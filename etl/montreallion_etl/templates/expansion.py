"""Expansion phase C: data-driven templates over additional open sources.

Same rules as the original templates: the dataset (or a revision-pinned Wikipedia list)
defines the eligible set, the prompt states that definition, and every answer carries
provenance refs (Wikidata QID, RPCQ id, GTFS id…). New templates require ≥ 5 answers.
"""

from __future__ import annotations

import math
import re
import zipfile
from collections import defaultdict

from .. import geo
from ..http import fetch
from ..model import Answer, Candidate, make_id
from ..normalize import normalize_answer
from ..sources import ckan, gtfs, wikidata, wikipedia
from . import Context, area_scope, de, place_signal, prep_en, prep_fr

MIN = 5


def _areas(ctx: Context):
    return {a.name: a for a in ctx.areas}


WIKI_LISTS = ["List of museums in Montreal", "List of National Historic Sites of Canada in Montreal"]
_wd_cache: dict = {}


def _wd_info() -> tuple[dict, str]:
    """One Wikidata query for every title linked from the Wikipedia lists used here (WDQS allows ~1 req/min)."""
    if not _wd_cache:
        titles: set[str] = set()
        for page in WIKI_LISTS:
            txt, _ = wikipedia.page(page)
            for t in wikipedia.tables(txt) or [[]]:
                for r in t:
                    if r:
                        titles.update(wikipedia.link_targets(r[0])[:1])
        _wd_cache["v"] = wikidata.by_enwiki(sorted(titles))
    return _wd_cache["v"]


STOP = {"the", "and", "of", "de", "du", "des", "la", "le", "les", "montreal", "montréal", "church", "house", "museum", "musée", "maison", "site", "national", "historic"}


def _tokens(s: str) -> set[str]:
    return {w for w in re.findall(r"[a-zà-ÿ]{4,}", s.lower()) if w not in STOP}


def _same_thing(a: str, b: str) -> bool:
    """Conservative: two names share a distinctive word (so a link to a *different* article is not trusted)."""
    return bool(_tokens(a) & _tokens(b))


def _wd_enrich(answers_titles: list[tuple[Answer, str | None]], ctx: Context | None = None) -> str:
    """Adds QID ref, French label and sitelink signal from the answers' English Wikipedia titles.

    Only trusted when the linked article/label shares a distinctive word with the listed name;
    the article title (minus disambiguation) then becomes an accepted alias."""
    info, retrieved = _wd_info()
    for a, t in answers_titles:
        t = (t or "").replace("_", " ")
        hit = info.get(t)
        if not t or not _same_thing(a.en, t) or (hit and hit.get("en") and not _same_thing(a.en, hit["en"])):
            hit = None
        else:
            title = re.sub(r"\s*\([^)]*\)$", "", t)
            if title != a.en:
                a.aliases.append(title)
        if hit:
            a.refs.append(f"wikidata:{hit['qid']}")
            a.signal += math.log1p(hit["sl"])
            fr = hit.get("fr")
            # FR label only when the item is unambiguously this answer (its EN label or article title IS the listed name).
            exact = normalize_answer(hit.get("en") or "") == normalize_answer(a.en) or normalize_answer(title) == normalize_answer(a.en)
            if fr and fr != a.en and not a.fr and exact:
                a.fr = re.sub(r"\s*\([^)]*\)$", "", fr)
        elif ctx is not None:
            sig, refs, _ = place_signal(ctx, a.en)
            a.signal += math.log1p(sig)
            a.refs += refs
    return retrieved


# ---------------------------------------------------------------- heritage (City LPC dataset)
GENERIC = re.compile(r"^(site patrimonial (de la |du |de l'|des |de |d')|ancienne? )", re.I)


def heritage_templates(ctx: Context) -> list[Candidate]:
    f, src = ckan.resource("sites-immeubles-proteges-lpc", fmt="geojson")
    areas = _areas(ctx)
    items: list[dict] = []
    for ft in ckan.read_json(f)["features"]:  # type: ignore[index]
        p = ft["properties"]
        if p["type_zone"] == "AP":  # protection zones are buffers, not heritage places
            continue
        c = geo.centroid(ft["geometry"])
        if not c:
            continue
        lon, lat = geo.mtm8_to_lonlat(*c)
        area = ctx.area_index.locate(lon, lat)
        name = re.sub(r"\s+", " ", (p["Nom"] or "")).strip()
        if not area or not name:
            continue
        m = re.search(r"id=(\d+)", p.get("lien_RPCQ") or "")
        items.append({"name": name, "other": p.get("NomsAutres"), "area": area, "kind": p["type_zone"], "rpcq": m.group(1) if m else None, "lonlat": (lon, lat)})

    def answer(it: dict) -> Answer:
        aliases = []
        short = GENERIC.sub("", it["name"]).strip()
        if short and short != it["name"]:
            aliases.append(short[0].upper() + short[1:])
        if it["other"]:
            aliases += [x.strip() for x in re.split(r"[;,]", it["other"]) if len(x.strip()) > 3]
        sig, refs, _ = place_signal(ctx, it["name"], *aliases)
        refs = refs + ([f"rpcq:{it['rpcq']}"] if it["rpcq"] else [])
        # Familiarity: Wikipedia coverage; provincially classified places slightly above municipal citations.
        return Answer(en=it["name"], aliases=aliases, signal=math.log1p(sig) + (0.3 if it["kind"] in ("IC", "SC", "SD") else 0), refs=refs,
                      geo=it["lonlat"], geo_basis="mtl-lpc-centroid")

    sources = [src, ctx.src["limites"], ctx.src["wikidata"]]
    out = []
    by_area: dict[str, list[dict]] = defaultdict(list)
    for it in items:
        by_area[it["area"]].append(it)
    for name, its in sorted(by_area.items()):
        a = areas.get(name)
        if not a or len({i["name"] for i in its}) < MIN:
            continue
        out.append(
            Candidate(
                id=make_id("heritage-in", name),
                template="heritage-in-area",
                concept=f"heritage-in:{name}",
                category="history",
                scope=area_scope(a),
                prompt={
                    "en": f"Name a heritage building or site protected under Québec's Cultural Heritage Act {prep_en(a)}.",
                    "fr": f"Nommez un immeuble ou un site patrimonial protégé par la Loi sur le patrimoine culturel {prep_fr(a)}.",
                },
                eligibility={
                    "en": f"Classified, cited or declared heritage buildings and sites (protection zones excluded) in the City of Montréal's LPC dataset, located {prep_en(a)}.",
                    "fr": f"Immeubles et sites patrimoniaux classés, cités ou déclarés (aires de protection exclues) du jeu de données LPC de la Ville de Montréal, situés {prep_fr(a)}.",
                },
                sources=sources,
                answers=[answer(i) for i in its],
                est_basis="wikidata-sitelinks+designation-level",
            )
        )

    kinds = {
        "cinema": (
            lambda n: re.match(r"^(cinéma|théâtre|theatre|regent theater)", n, re.I),
            "a former or current cinema or theatre building protected under Québec's Cultural Heritage Act on the Island of Montréal",
            "un cinéma ou un théâtre protégé par la Loi sur le patrimoine culturel sur l'île de Montréal",
            "Buildings whose protected name begins with Cinéma/Théâtre",
            "Immeubles dont le nom protégé commence par Cinéma ou Théâtre",
        ),
        "church": (
            lambda n: re.match(r"^(ancienne )?(église|chapelle|basilique|cathédrale|temple)", n, re.I),
            "a church or chapel protected under Québec's Cultural Heritage Act on the Island of Montréal",
            "une église ou une chapelle protégée par la Loi sur le patrimoine culturel sur l'île de Montréal",
            "Protected buildings named Église, Chapelle, Basilique, Cathédrale or Temple",
            "Immeubles protégés nommés Église, Chapelle, Basilique, Cathédrale ou Temple",
        ),
        "wayside-cross": (
            lambda n: n.lower().startswith("croix de chemin"),
            "a wayside cross (croix de chemin) protected under Québec's Cultural Heritage Act on the Island of Montréal",
            "une croix de chemin protégée par la Loi sur le patrimoine culturel sur l'île de Montréal",
            "Protected wayside crosses",
            "Croix de chemin protégées",
        ),
        "site": (
            lambda n: n.lower().startswith("site patrimonial"),
            "a heritage site (site patrimonial) protected under Québec's Cultural Heritage Act on the Island of Montréal",
            "un site patrimonial protégé par la Loi sur le patrimoine culturel sur l'île de Montréal",
            "Classified, cited or declared heritage sites",
            "Sites patrimoniaux classés, cités ou déclarés",
        ),
    }
    for kind, (pred, en, fr, el_en, el_fr) in kinds.items():
        its = [i for i in items if pred(i["name"])]
        if len({i["name"] for i in its}) < MIN:
            continue
        out.append(
            Candidate(
                id=make_id("heritage-kind", kind),
                template="heritage-kind",
                concept=f"heritage-kind:{kind}",
                category="history",
                scope="island",
                prompt={"en": f"Name {en}.", "fr": f"Nommez {fr}."},
                eligibility={
                    "en": f"{el_en} in the City of Montréal's LPC dataset (whole island, protection zones excluded).",
                    "fr": f"{el_fr} du jeu de données LPC de la Ville de Montréal (toute l'île, aires de protection exclues).",
                },
                sources=sources,
                answers=[answer(i) for i in its],
                est_basis="wikidata-sitelinks+designation-level",
            )
        )
    return out


# ---------------------------------------------------------------- community gardens
GARDEN_PREFIX = re.compile(r"^jardin(s)? (communautaire|citoyen|collectif)s?( du| de la| de l'| des| de| d')?\s*", re.I)


def garden_templates(ctx: Context) -> list[Candidate]:
    f, src = ckan.resource("jardins-communautaires", fmt="csv")
    areas = _areas(ctx)
    by: dict[str, list[dict]] = defaultdict(list)
    official = {re.sub(r"[-–]", "-", a.name): a.name for a in ctx.areas}
    for r in ckan.read_csv(f):
        area = official.get(re.sub(r"[-–]", "-", r["arrondissement"].strip()), r["arrondissement"].strip())
        by[area].append(r)
    out = []
    for name, rows in sorted(by.items()):
        a = areas.get(name)
        if not a or len(rows) < MIN:
            continue
        answers = []
        for r in rows:
            full = re.sub(r"\s+", " ", r["nom"]).strip()
            short = GARDEN_PREFIX.sub("", full).strip()
            aliases = [short, f"Jardin {short}", f"Jardin communautaire {short}"] if short and short != full else []
            # Familiarity: an older garden is more established; Wikidata/park coverage when the garden carries a park's name.
            sig, refs, _ = place_signal(ctx, short, f"parc {short}") if short else (0.0, [], None)
            answers.append(Answer(en=full, aliases=aliases, signal=math.log1p(sig), refs=refs + [f"mtl-jardin:{r['id']}"]))
        out.append(
            Candidate(
                id=make_id("garden-in", name),
                template="community-garden-in-area",
                concept=f"garden-in:{name}",
                category="parks",
                scope=area_scope(a),
                prompt={"en": f"Name a community garden {prep_en(a)}.", "fr": f"Nommez un jardin communautaire {prep_fr(a)}."},
                eligibility={
                    "en": f"Community and citizen gardens listed in the City of Montréal's community-gardens dataset {prep_en(a)}.",
                    "fr": f"Jardins communautaires et citoyens du jeu de données des jardins communautaires de la Ville de Montréal {prep_fr(a)}.",
                },
                sources=[src, ctx.src["wikidata"]],
                answers=answers,
                est_basis="wikidata-sitelinks-of-namesake-park",
            )
        )
    return out


# ---------------------------------------------------------------- museums (Wikipedia list)
def museum_templates(ctx: Context) -> list[Candidate]:
    txt, src = wikipedia.page("List of museums in Montreal")
    rows = []
    for r in wikipedia.tables(txt)[0][1:]:
        if len(r) < 4:
            continue
        links = wikipedia.link_targets(r[0])
        name = wikipedia.plain(r[0])
        if not name:
            continue
        rows.append({"name": name, "title": links[0] if links else None, "borough": wikipedia.plain(r[2]), "type": wikipedia.plain(r[3])})

    def answers(sel: list[dict]) -> tuple[list[Answer], str]:
        pairs = [(Answer(en=x["name"]), x["title"]) for x in sel]
        retrieved = _wd_enrich(pairs, ctx)
        return [a for a, _ in pairs], retrieved

    specs = [
        ("all", lambda x: True, "a museum in Montréal", "un musée à Montréal", "Every museum", "Tous les musées", "island"),
        ("art", lambda x: x["type"] == "Art", "an art museum in Montréal", "un musée d'art à Montréal", "Museums whose type is Art", "Musées de type « Art »", "island"),
        (
            "history",
            lambda x: x["type"] in ("History", "Historic house", "Military", "Religious"),
            "a history, historic-house, military or religious museum in Montréal",
            "un musée d'histoire, de maison historique, militaire ou religieux à Montréal",
            "Museums of type History, Historic house, Military or Religious",
            "Musées de type histoire, maison historique, militaire ou religieux",
            "island",
        ),
        ("ville-marie", lambda x: x["borough"] == "Ville-Marie", "a museum in the borough of Ville-Marie", "un musée dans l'arrondissement de Ville-Marie", "Museums whose borough is Ville-Marie", "Musées situés dans Ville-Marie", "city"),
    ]
    out = []
    for key, pred, en, fr, el_en, el_fr, scope in specs:
        sel = [x for x in rows if pred(x)]
        if len(sel) < MIN:
            continue
        ans, retrieved = answers(sel)
        out.append(
            Candidate(
                id=make_id("museum", key),
                template="museum-list",
                concept=f"museum:{key}",
                category="history",
                scope=scope,
                prompt={"en": f"Name {en}.", "fr": f"Nommez {fr}."},
                eligibility={
                    "en": f"{el_en} on Wikipedia's List of museums in Montreal (revision cited, {len(sel)} museums).",
                    "fr": f"{el_fr} de la liste des musées de Montréal de Wikipédia (révision citée, {len(sel)} musées).",
                },
                sources=[src, {**wikidata.SOURCE, "retrieved": retrieved}],
                answers=ans,
                est_basis="wikidata-sitelinks",
            )
        )
    return out


# ---------------------------------------------------------------- National Historic Sites (Wikipedia list)
COORD = re.compile(r"\{\{coord\|([\d.]+)\|([\d.]+)\|([\d.]+)\|N\|([\d.]+)\|([\d.]+)\|([\d.]+)\|W", re.I)
COORD_DEC = re.compile(r"\{\{coord\|(-?[\d.]+)\|(-?[\d.]+)\|", re.I)


def _coord(cell: str) -> tuple[float, float] | None:
    m = COORD.search(cell)
    if m:
        d = [float(x) for x in m.groups()]
        return -(d[3] + d[4] / 60 + d[5] / 3600), d[0] + d[1] / 60 + d[2] / 3600
    m = COORD_DEC.search(cell)
    if m:
        lat, lon = float(m.group(1)), float(m.group(2))
        return (lon if lon < 0 else -lon), lat
    return None


def nhs_templates(ctx: Context) -> list[Candidate]:
    txt, src = wikipedia.page("List of National Historic Sites of Canada in Montreal")
    areas = _areas(ctx)
    rows = []
    for r in wikipedia.tables(txt)[0][1:]:
        if len(r) < 4:
            continue
        links = wikipedia.link_targets(r[0])
        name = wikipedia.plain(r[0])
        ll = _coord(r[3])
        area = ctx.area_index.locate(*ll) if ll else None
        if name:
            rows.append({"name": name, "title": links[0] if links else None, "area": area})
    out = []
    groups: dict[str, list[dict]] = {"__island__": [r for r in rows if r["area"]]}
    for r in rows:
        if r["area"]:
            groups.setdefault(r["area"], []).append(r)
    for key, sel in groups.items():
        if len(sel) < MIN:
            continue
        pairs = [(Answer(en=x["name"]), x["title"]) for x in sel]
        retrieved = _wd_enrich(pairs, ctx)
        if key == "__island__":
            where_en, where_fr, scope = "on the Island of Montréal", "sur l'île de Montréal", "island"
        else:
            a = areas[key]
            where_en, where_fr, scope = prep_en(a), prep_fr(a), area_scope(a)
        out.append(
            Candidate(
                id=make_id("nhs-in", "island" if key == "__island__" else key),
                template="national-historic-site",
                concept=f"nhs-in:{key}",
                category="history",
                scope=scope,
                prompt={"en": f"Name a National Historic Site of Canada {where_en}.", "fr": f"Nommez un lieu historique national du Canada {where_fr}."},
                eligibility={
                    "en": f"Sites on Wikipedia's List of National Historic Sites of Canada in Montreal whose coordinates fall {where_en} (revision cited).",
                    "fr": f"Lieux de la liste Wikipédia des lieux historiques nationaux du Canada à Montréal dont les coordonnées sont {where_fr} (révision citée).",
                },
                sources=[src, ctx.src["limites"], {**wikidata.SOURCE, "retrieved": retrieved}],
                answers=[a for a, _ in pairs],
                est_basis="wikidata-sitelinks",
            )
        )
    return out


# ---------------------------------------------------------------- exo commuter trains (GTFS)
EXO_URL = "https://exo.quebec/uploads/ressources-telechargeables/a-propos/donnees-ouvertes/trains/google_transit.zip"
EXO_SOURCE = {
    "title": "exo — GTFS scheduled train service (via ARTM open data)",
    "url": "https://donnees.artm.quebec/catalogue/dataset/exo-trains-gtfs",
    "license": "CC BY 4.0",
}


def exo_templates(ctx: Context) -> list[Candidate]:
    data = gtfs.load_rail("exo-trains-gtfs", EXO_URL, {"2"})
    f = fetch("exo-trains-gtfs", EXO_URL, suffix=".zip")
    z = zipfile.ZipFile(f.path)
    routes = {r["route_id"]: r for r in gtfs._rows(z, "routes.txt")}
    src = {**EXO_SOURCE, "retrieved": data.retrieved}
    out = []
    stations = list(data.stations.values())

    def ans(st: gtfs.Station) -> Answer:
        name = re.sub(r"^gare\s+", "", st.name, flags=re.I)
        sig, refs, _ = place_signal(ctx, f"Gare {name}", f"gare de {name}", name)
        return Answer(en=name, aliases=[f"Gare {name}"], signal=math.log1p(sig) + 0.5 * (len(st.lines) - 1), refs=[f"gtfs-exo:{st.parent_id}"] + refs)

    for rid, r in sorted(routes.items()):
        on = [s for s in stations if rid in s.lines]
        if len(on) < MIN:
            continue
        line = (r.get("route_long_name") or r.get("route_short_name") or rid).strip()
        line = re.sub(r"^(ligne\s+)?\d+\s*[-–]?\s*", "", line, flags=re.I)
        out.append(
            Candidate(
                id=make_id("exo-line", line),
                template="exo-line",
                concept=f"exo-line:{rid}",
                category="transit",
                scope="greater",
                prompt={"en": f"Name a station on exo's {line} commuter-train line.", "fr": f"Nommez une gare de la ligne de train {line} d'exo."},
                eligibility={
                    "en": f"Stations served by the {line} line in exo's current GTFS schedule ({len(on)}).",
                    "fr": f"Gares desservies par la ligne {line} dans l'horaire GTFS actuel d'exo ({len(on)}).",
                },
                sources=[src, ctx.src["wikidata"]],
                answers=[ans(s) for s in on],
                est_basis="wikidata-sitelinks+lines-served",
            )
        )
    island = [s for s in stations if ctx.area_index.locate(s.lon, s.lat)]
    if len(island) >= MIN:
        out.append(
            Candidate(
                id=make_id("exo-island-station"),
                template="exo-island",
                concept="exo-island",
                category="transit",
                scope="island",
                prompt={"en": "Name an exo commuter-train station on the Island of Montréal.", "fr": "Nommez une gare de train d'exo située sur l'île de Montréal."},
                eligibility={
                    "en": f"exo GTFS stations whose coordinates fall inside one of the island's 34 municipalities/boroughs ({len(island)}).",
                    "fr": f"Gares du GTFS d'exo dont les coordonnées sont dans l'une des 34 municipalités ou arrondissements de l'île ({len(island)}).",
                },
                sources=[src, ctx.src["limites"], ctx.src["wikidata"]],
                answers=[ans(s) for s in island],
                est_basis="wikidata-sitelinks+lines-served",
            )
        )
    return out


# ---------------------------------------------------------------- STM bus networks (GTFS)
def stm_bus_templates(ctx: Context) -> list[Candidate]:
    f = fetch("stm-gtfs", gtfs.URL, suffix=".zip")
    z = zipfile.ZipFile(f.path)
    routes = {r["route_id"]: r for r in gtfs._rows(z, "routes.txt") if r["route_type"] == "3"}
    trips: dict[str, int] = defaultdict(int)
    for t in gtfs._rows(z, "trips.txt"):
        if t["route_id"] in routes:
            trips[t["route_id"]] += 1
    nets = [
        ("night", lambda n: 300 <= n < 400, "an STM night bus route (300 series)", "une ligne d'autobus de nuit de la STM (série 300)"),
        ("express", lambda n: 400 <= n < 500, "an STM express bus route (400 series)", "une ligne d'autobus express de la STM (série 400)"),
    ]
    out = []
    for key, pred, en, fr in nets:
        sel = [r for r in routes.values() if r["route_short_name"].isdigit() and pred(int(r["route_short_name"]))]
        if len(sel) < MIN:
            continue
        answers = []
        for r in sel:
            num, name = r["route_short_name"], r["route_long_name"].strip()
            answers.append(
                Answer(en=f"{num} {name}", aliases=[num, f"{num} - {name}", f"ligne {num}", f"bus {num}", f"route {num}"], signal=math.log1p(trips[r["route_id"]]), refs=[f"gtfs-stm-route:{r['route_id']}"])
            )
        out.append(
            Candidate(
                id=make_id("stm-bus", key),
                template="stm-bus-network",
                concept=f"stm-bus:{key}",
                category="transit",
                scope="island",
                prompt={"en": f"Name {en}.", "fr": f"Nommez {fr}."},
                eligibility={
                    "en": f"Bus routes numbered in that series in the current STM GTFS schedule ({len(sel)}). The route number alone is accepted.",
                    "fr": f"Lignes d'autobus de cette série dans l'horaire GTFS actuel de la STM ({len(sel)}). Le numéro seul est accepté.",
                },
                sources=[{**gtfs.SOURCE, "retrieved": f.retrieved}],
                answers=answers,
                est_basis="scheduled-trips",
            )
        )
    return out


# ---------------------------------------------------------------- park extras (same City dataset as park-in-area)
def park_extra_templates(ctx: Context) -> list[Candidate]:
    from . import PARK_TYPE_EN

    def ans(p: dict) -> Answer:
        full_fr = f"{p['type']} {p['specific']}"
        sig, refs, _ = place_signal(ctx, full_fr, f"parc {p['specific']}")
        aliases = [p["specific"], *(f"{p['type']} {art} {p['specific']}" for art in ("du", "de", "de la", "des"))]
        return Answer(en=f"{p['specific']} {PARK_TYPE_EN[p['type']]}", fr=full_fr, aliases=aliases, signal=math.log1p(p["ha"]) + math.log1p(sig), refs=refs,
                      geo=p["lonlat"], geo_basis="mtl-park-centroid")

    specs = [
        ("nature", lambda p: p["type"] == "Parc-nature", "a nature park (parc-nature) in Montréal", "un parc-nature de Montréal", "Parks of type Parc-nature", "Parcs de type parc-nature"),
        ("square", lambda p: p["type"] == "Square", "a public square (square) in the City of Montréal", "un square de la Ville de Montréal", "Green spaces of type Square", "Espaces verts de type square"),
        ("large", lambda p: p["ha"] >= 25, "a park of 25 hectares or more in the City of Montréal", "un parc de 25 hectares ou plus dans la Ville de Montréal", "Named parks whose summed polygon area is at least 25 ha", "Parcs nommés dont la superficie totale est d'au moins 25 ha"),
    ]
    out = []
    for key, pred, en, fr, el_en, el_fr in specs:
        sel = [p for p in ctx.parks if pred(p)]
        if len(sel) < MIN:
            continue
        out.append(
            Candidate(
                id=make_id("park-kind", key),
                template="park-kind",
                concept=f"park-kind:{key}",
                category="parks",
                scope="city",
                prompt={"en": f"Name {en}.", "fr": f"Nommez {fr}."},
                eligibility={
                    "en": f"{el_en} in the City's green-space inventory ({len(sel)}).",
                    "fr": f"{el_fr} de l'inventaire des espaces verts de la Ville ({len(sel)}).",
                },
                sources=[ctx.src["parcs"], ctx.src["wikidata"]],
                answers=[ans(p) for p in sel],
                est_basis="park-area+wikidata-sitelinks",
            )
        )
    return out


# ---------------------------------------------------------------- neighbourhoods (Wikipedia list ∪ Wikidata items)
HOOD_QUERY = """
SELECT ?item ?fr ?en ?sl ?boroFr WHERE {
  VALUES ?cls { wd:Q123705 wd:Q2983893 wd:Q109325424 wd:Q15715406 wd:Q1394476 }
  ?item wdt:P31 ?cls ; wdt:P131 ?boro ; wikibase:sitelinks ?sl .
  ?boro wdt:P131 wd:Q340 ; rdfs:label ?boroFr FILTER(LANG(?boroFr) = "fr")
  OPTIONAL { ?item rdfs:label ?fr FILTER(LANG(?fr) = "fr") }
  OPTIONAL { ?item rdfs:label ?en FILTER(LANG(?en) = "en") }
}"""
# Everyday names players use (well-established nicknames/translations only).
HOOD_ALIASES = {
    "Downtown Montreal": ["Downtown", "Centre-ville", "Centre-ville de Montréal"],
    "Gay Village": ["The Village", "Le Village", "Village gai"],
    "Mille carré doré": ["Golden Square Mile", "Square Mile"],
    "Chinatown": ["Quartier chinois"],
    "Quartier Latin": ["Latin Quarter", "Quartier latin"],
    "Quartier des spectacles": ["Entertainment District"],
    "Red-Light District": ["Red Light"],
    "Little Italy": ["Petite-Italie"],
    "Little Portugal": ["Petit Portugal"],
    "The Plateau": ["Plateau", "Plateau Mont-Royal", "Le Plateau"],
    "Park Extension": ["Parc-Extension", "Parc-Ex", "Park Ex"],
    "Goose Village": ["Village-aux-Oies"],
    "Pointe-Saint-Charles": ["The Point", "Point Saint-Charles"],
    "Notre-Dame-de-Grâce": ["NDG"],
    "Côte-des-Neiges": ["CDN"],
    "Milton-Parc": ["Milton Park", "McGill Ghetto"],
    "Hochelaga-Maisonneuve": ["HoMa"],
    "Old Montreal": ["Vieux-Montréal", "Old Montréal"],
    "Little Burgundy": ["Petite-Bourgogne"],
}
NOT_A_HOOD = re.compile(r"^(no particular|see also|references|external links|other neighbourhoods|\[http)", re.I)


def neighbourhood_templates(ctx: Context) -> list[Candidate]:
    from ..http import fetch_json

    txt, src = wikipedia.page("List of neighbourhoods in Montreal")
    areas = _areas(ctx)
    official = {normalize_answer(a.name): a.name for a in ctx.areas}
    hoods: dict[str, dict[str, Answer]] = defaultdict(dict)

    def add(area: str | None, en: str, fr: str | None = None, sig: float = 0.0, refs: list[str] | None = None):
        if not area or not en or NOT_A_HOOD.match(en):
            return
        en = re.sub(r",\s*Montr[ée]al$", "", re.sub(r"\s*\(.*$", "", en)).strip()
        k = normalize_answer(en)
        cur = hoods[area].get(k)
        if cur:
            cur.signal = max(cur.signal, sig)
            cur.refs = sorted(set(cur.refs + (refs or [])))
            if fr and not cur.fr and normalize_answer(fr) != k:
                cur.fr = fr
        else:
            hoods[area][k] = Answer(en=en, fr=fr if fr and normalize_answer(fr) != k else None, signal=sig, refs=refs or [])

    sec = None
    for line in txt.split("\n"):
        m = re.match(r"^==\s*([^=].*?)\s*==\s*$", line)
        if m:
            sec = official.get(normalize_answer(wikipedia.plain(m.group(1))))
            continue
        m = re.match(r"^===\s*([^=].*?)\s*===\s*$", line) or (re.match(r"^\*+\s*(.*)$", line) if sec else None)
        if m and sec:
            for name in re.split(r"\s+and\s+", wikipedia.plain(m.group(1)).split(":")[0]):
                sig, refs, _ = place_signal(ctx, name)
                add(sec, name, sig=math.log1p(sig), refs=refs)
    data, f = fetch_json("wd-neighbourhoods", wikidata.ENDPOINT, post={"query": HOOD_QUERY, "format": "json"}, timeout=180)
    for b in data["results"]["bindings"]:  # type: ignore[index]
        area = official.get(normalize_answer(b["boroFr"]["value"]))
        fr = b.get("fr", {}).get("value")
        en = b.get("en", {}).get("value") or fr
        sig, refs = math.log1p(int(b["sl"]["value"])), [f"wikidata:{b['item']['value'].rsplit('/', 1)[-1]}"]
        if not area:
            continue
        # Same place as a Wikipedia entry (matched on either label) → merge, adding the French name.
        known = next((hoods[area][k] for k in (normalize_answer(en or ""), normalize_answer(fr or "")) if k in hoods[area]), None)
        if known:
            known.signal = max(known.signal, sig)
            known.refs = sorted(set(known.refs + refs))
            if fr and not known.fr and normalize_answer(fr) != normalize_answer(known.en):
                known.fr = fr
            continue
        add(area, fr or en or "", None, sig, refs)  # new place: the French label is the local name
    for by in hoods.values():
        for a in by.values():
            if a.fr and a.fr.lower().startswith("parc "):
                a.fr = None  # a park item, not the neighbourhood's French name
            a.aliases += HOOD_ALIASES.get(a.en, [])
    wsrc = {**wikidata.SOURCE, "title": "Wikidata (neighbourhood items located in each borough)", "retrieved": f.retrieved}
    out = []
    for name, by in sorted(hoods.items()):
        a = areas.get(name)
        if not a or a.kind != "borough" or len(by) < MIN:
            continue
        out.append(
            Candidate(
                id=make_id("hood-in", name),
                template="neighbourhood-in-borough",
                concept=f"hood-in:{name}",
                category="boroughs",
                scope="city",
                prompt={"en": f"Name a neighbourhood {prep_en(a)}.", "fr": f"Nommez un quartier {prep_fr(a)}."},
                eligibility={
                    "en": f"Neighbourhoods listed under {a.name} on Wikipedia's List of neighbourhoods in Montreal, plus Wikidata neighbourhood items located in the borough (sociological districts included).",
                    "fr": f"Quartiers listés sous {a.name} dans la liste Wikipédia des quartiers de Montréal, plus les quartiers Wikidata situés dans l'arrondissement (quartiers sociologiques inclus).",
                },
                sources=[src, wsrc],
                answers=list(by.values()),
                est_basis="wikidata-sitelinks",
            )
        )
    return out


# ---------------------------------------------------------------- métro stations by opening period (Wikipedia list)
def metro_opening_templates(ctx: Context) -> list[Candidate]:
    txt, src = wikipedia.page("List of Montreal Metro stations")
    rows = []
    for r in wikipedia.tables(txt)[1][1:]:
        m = re.search(r"\{\{stms\|([^}|]+)", r[0]) if r else None
        y = re.search(r"\b(19|20)\d\d\b", wikipedia.plain(r[-1])) if r else None
        if m and y:
            rows.append((m.group(1).strip(), int(y.group(0))))
    periods = [
        ("1966", lambda y: y == 1966, "opened with the original network in 1966", "ouverte avec le réseau initial en 1966"),
        ("1976-1978", lambda y: 1976 <= y <= 1978, "opened between 1976 and 1978", "ouverte entre 1976 et 1978"),
        ("1980s", lambda y: 1980 <= y <= 1988, "opened in the 1980s", "ouverte dans les années 1980"),
    ]
    out = []
    for key, pred, en, fr in periods:
        sel = sorted({n for n, y in rows if pred(y)})
        if len(sel) < MIN:
            continue
        answers = []
        for n in sel:
            hit = ctx.wd_stations.lookup(n)
            answers.append(Answer(en=n, signal=math.log1p(hit[0]) if hit else 0.0, refs=[f"wikidata:{hit[2]}"] if hit else []))
        out.append(
            Candidate(
                id=make_id("metro-opened", key),
                template="metro-opened",
                concept=f"metro-opened:{key}",
                category="transit",
                scope="greater",
                prompt={"en": f"Name a Montréal métro station that {en}.", "fr": f"Nommez une station du métro de Montréal {fr}."},
                eligibility={
                    "en": f"Stations whose opening date on Wikipedia's List of Montreal Metro stations falls in that period ({len(sel)}).",
                    "fr": f"Stations dont la date d'ouverture dans la liste Wikipédia des stations du métro de Montréal tombe dans cette période ({len(sel)}).",
                },
                sources=[src, ctx.src["wikidata"]],
                answers=answers,
                est_basis="wikidata-sitelinks",
            )
        )
    return out


ALL_EXPANSION = [neighbourhood_templates, metro_opening_templates, heritage_templates, garden_templates, museum_templates, nhs_templates, exo_templates, stm_bus_templates, park_extra_templates]
