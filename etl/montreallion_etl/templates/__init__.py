"""Question templates: each turns parsed open data into candidate questions.

Rules every template follows:
  * the eligible-answer set is exactly what the dataset says (no guessing, no LLM);
  * the prompt states the dataset-defined eligibility, so answers are checkable;
  * a familiarity *signal* (data-backed: Wikidata sitelinks, park area…) is attached per answer;
  * City of Montréal (boroughs) vs other island municipalities are kept distinct.
"""

from __future__ import annotations

import math
from collections import defaultdict
from dataclasses import dataclass

from .. import geo
from ..model import Answer, Candidate, make_id
from ..sources import gtfs, montreal, wikidata

MIN_ANSWERS = 3


@dataclass
class Context:
    metro: gtfs.MetroData
    rem: gtfs.MetroData
    areas: list[montreal.Area]
    area_index: geo.AreaIndex
    neighbourhoods: list[dict]
    parks: list[dict]
    culture: list[dict]
    art: list[dict]
    wd_places: wikidata.Index
    wd_stations: wikidata.Index
    wd_people: wikidata.Index
    src: dict[str, dict]  # source key → {title,url,license,retrieved}


# ---------- French/English helpers ----------
VOWELS = tuple("AEIOUYÉÈÊÎÏÔÂH")


def de(name: str) -> str:
    """French 'de' + name with elision/contraction: de Verdun, d'Anjou, du Sud-Ouest, de L'Île-Bizard."""
    if name.startswith("Le "):
        return "du " + name[3:]
    if name.startswith("Les "):
        return "des " + name[4:]
    if name.upper().startswith(VOWELS):
        return "d'" + name
    return "de " + name


def area_phrase(area: montreal.Area) -> tuple[str, str]:
    if area.kind == "borough":
        return f"the borough of {area.name}", f"l'arrondissement {de(area.name)}"
    return area.name, area.name


def area_scope(area: montreal.Area) -> str:
    return "city" if area.kind == "borough" else "island"


def prep_fr(area: montreal.Area) -> str:
    return "dans " + area_phrase(area)[1] if area.kind == "borough" else "à " + area.name


def prep_en(area: montreal.Area) -> str:
    return "in " + area_phrase(area)[0]


# ---------- Familiarity signals ----------
def place_signal(ctx: Context, *names: str) -> tuple[float, list[str], str | None]:
    hit = ctx.wd_places.lookup(*names)
    if not hit:
        return 0.0, [], None
    sl, en, qid = hit
    return float(sl), [f"wikidata:{qid}"], en


# ---------- Templates ----------
LINE_PROMPTS = {
    "1": ("Green", "verte"),
    "2": ("Orange", "orange"),
    "4": ("Yellow", "jaune"),
    "5": ("Blue", "bleue"),
}


def _station_answer(ctx: Context, st: gtfs.Station) -> Answer:
    hit = ctx.wd_stations.lookup(st.name)
    sl = float(hit[0]) if hit else 0.0
    refs = [f"gtfs:{st.parent_id}"] + ([f"wikidata:{hit[2]}"] if hit else [])
    aliases = []
    if "-" in st.name and st.name.count("-") == 1 and "UQAM" in st.name:
        aliases.append(st.name.split("-")[0])  # "Berri"
    if st.name.startswith("Longueuil"):
        aliases += ["Longueuil", "Longueuil–Université-de-Sherbrooke"]
    if st.name.startswith("Square-Victoria"):
        aliases.append("Square-Victoria")
    # Familiarity: Wikipedia coverage, boosted for multi-line hubs.
    return Answer(en=st.name, aliases=aliases, signal=math.log1p(sl) + 0.6 * (len(st.lines) - 1), refs=refs)


def metro_templates(ctx: Context) -> list[Candidate]:
    src = [ctx.src["gtfs"], ctx.src["wikidata"]]
    out = []
    stations = list(ctx.metro.stations.values())
    for line, (en, fr) in LINE_PROMPTS.items():
        on = [s for s in stations if line in s.lines]
        out.append(
            Candidate(
                id=make_id("metro-line", en),
                template="metro-line",
                concept=f"metro-line:{line}",
                category="transit",
                scope="greater" if line in ("2", "4") else "city",
                prompt={"en": f"Name a station on the STM {en} Line.", "fr": f"Nommez une station de la ligne {fr} du métro de la STM."},
                eligibility={
                    "en": f"Stations served by Line {line} ({en}) in the current STM GTFS schedule ({len(on)} stations).",
                    "fr": f"Stations desservies par la ligne {line} ({fr}) selon l'horaire GTFS actuel de la STM ({len(on)} stations).",
                },
                sources=src,
                answers=[_station_answer(ctx, s) for s in on],
                est_basis="wikidata-sitelinks+transfer-boost",
            )
        )
    hubs = [s for s in stations if len(s.lines) > 1]
    out.append(
        Candidate(
            id=make_id("metro-transfer"),
            template="metro-transfer",
            concept="metro-transfer",
            category="transit",
            scope="city",
            prompt={"en": "Name a métro station where you can transfer between two STM lines.", "fr": "Nommez une station de métro où l'on peut passer d'une ligne de la STM à une autre."},
            eligibility={"en": "Stations served by two or more STM métro lines (STM GTFS).", "fr": "Stations desservies par au moins deux lignes de métro de la STM (GTFS de la STM)."},
            sources=src,
            answers=[_station_answer(ctx, s) for s in hubs],
            est_basis="wikidata-sitelinks+transfer-boost",
        )
    )
    termini = [s for s in stations if s.termini_of]
    out.append(
        Candidate(
            id=make_id("metro-terminus"),
            template="metro-terminus",
            concept="metro-terminus",
            category="transit",
            scope="greater",
            prompt={"en": "Name a station at the end of an STM métro line (a terminus).", "fr": "Nommez une station au bout d'une ligne de métro de la STM (un terminus)."},
            eligibility={
                "en": "First or last station of the longest scheduled trips on each line (STM GTFS). Short-turn stops don't count.",
                "fr": "Première ou dernière station des trajets complets de chaque ligne (GTFS de la STM). Les terminus partiels ne comptent pas.",
            },
            sources=src,
            answers=[_station_answer(ctx, s) for s in termini],
            est_basis="wikidata-sitelinks+transfer-boost",
        )
    )
    by_area: dict[str, list[gtfs.Station]] = defaultdict(list)
    for s in stations:
        a = ctx.area_index.locate(s.lon, s.lat)
        if a:
            by_area[a].append(s)
    areas = {a.name: a for a in ctx.areas}
    for name, sts in sorted(by_area.items()):
        if len(sts) < MIN_ANSWERS:
            continue
        a = areas[name]
        border = [s.name for s in sts if ctx.area_index.near_boundary(s.lon, s.lat)]
        out.append(
            Candidate(
                warnings=[f"near a boundary (verify): {', '.join(border)}"] if border else [],
                id=make_id("metro-in", name),
                template="metro-in-area",
                concept=f"metro-in:{name}",
                category="transit",
                scope=area_scope(a),
                prompt={"en": f"Name a métro station located {prep_en(a)}.", "fr": f"Nommez une station de métro située {prep_fr(a)}."},
                eligibility={
                    "en": f"STM stations whose location falls inside {area_phrase(a)[0]}'s official boundary ({len(sts)} stations).",
                    "fr": f"Stations de la STM situées à l'intérieur des limites officielles {de(name) if a.kind == 'borough' else 'de ' + name} ({len(sts)} stations).",
                },
                sources=[ctx.src["gtfs"], ctx.src["limites"], ctx.src["wikidata"]],
                answers=[_station_answer(ctx, s) for s in sts],
                est_basis="wikidata-sitelinks+transfer-boost",
            )
        )
    return out


def area_templates(ctx: Context) -> list[Candidate]:
    out = []
    boroughs = [a for a in ctx.areas if a.kind == "borough"]
    munis = [a for a in ctx.areas if a.kind == "municipality"]

    def ans(a: montreal.Area) -> Answer:
        sig, refs, en = place_signal(ctx, a.name)
        return Answer(en=a.name, signal=math.log1p(sig), refs=refs)

    out.append(
        Candidate(
            id=make_id("city-borough"),
            template="city-borough",
            concept="city-borough",
            category="boroughs",
            scope="city",
            prompt={"en": "Name one of the boroughs of the City of Montréal.", "fr": "Nommez l'un des arrondissements de la Ville de Montréal."},
            eligibility={"en": f"The {len(boroughs)} boroughs in the City's official administrative boundaries.", "fr": f"Les {len(boroughs)} arrondissements des limites administratives officielles."},
            sources=[ctx.src["limites"], ctx.src["wikidata"]],
            answers=[ans(a) for a in boroughs],
            est_basis="wikidata-sitelinks",
        )
    )
    out.append(
        Candidate(
            id=make_id("island-municipality"),
            template="island-municipality",
            concept="island-municipality",
            category="boroughs",
            scope="island",
            prompt={"en": "Name a municipality on the Island of Montréal that is NOT part of the City of Montréal.", "fr": "Nommez une municipalité de l'île de Montréal qui ne fait PAS partie de la Ville de Montréal."},
            eligibility={"en": f"The {len(munis)} other municipalities of the agglomeration.", "fr": f"Les {len(munis)} autres municipalités de l'agglomération."},
            sources=[ctx.src["limites"], ctx.src["wikidata"]],
            answers=[ans(a) for a in munis],
            est_basis="wikidata-sitelinks",
        )
    )

    areas = {a.name: a for a in ctx.areas}
    by_area: dict[str, list[str]] = defaultdict(list)
    for n in ctx.neighbourhoods:
        by_area[n["area"]].append(n["name"])
    for name, hoods in sorted(by_area.items()):
        a = areas.get(name)
        if not a or len(set(hoods)) < MIN_ANSWERS:
            continue
        answers = []
        for h in sorted(set(hoods)):
            sig, refs, en = place_signal(ctx, h)
            answers.append(Answer(en=h, signal=math.log1p(sig), refs=refs))
        out.append(
            Candidate(
                id=make_id("neighbourhood-in", name),
                template="neighbourhood-in-area",
                concept=f"neighbourhood-in:{name}",
                category="boroughs",
                scope=area_scope(a),
                prompt={"en": f"Name a neighbourhood {prep_en(a)}.", "fr": f"Nommez un quartier {prep_fr(a)}."},
                eligibility={
                    "en": f"The City's reference neighbourhoods (quartiers de référence en habitation) for {name} ({len(answers)}).",
                    "fr": f"Les quartiers de référence en habitation de la Ville pour {name} ({len(answers)}).",
                },
                sources=[ctx.src["quartiers"], ctx.src["wikidata"]],
                answers=answers,
                est_basis="wikidata-sitelinks",
            )
        )
    return out


PARK_TYPE_EN = {"Parc": "Park", "Square": "Square", "Parc-nature": "Nature Park"}


def park_templates(ctx: Context) -> list[Candidate]:
    out = []
    areas = {a.name: a for a in ctx.areas}
    by_area: dict[str, list[dict]] = defaultdict(list)
    for p in ctx.parks:
        by_area[p["area"]].append(p)
    for name, parks in sorted(by_area.items()):
        a = areas.get(name)
        if not a or len(parks) < MIN_ANSWERS:
            continue
        answers = []
        for p in parks:
            full_fr = f"{p['type']} {p['specific']}"
            en_type = PARK_TYPE_EN[p["type"]]
            full_en = f"{p['specific']} {en_type}"
            aliases = [p["specific"], *(f"{p['type']} {art} {p['specific']}" for art in ("du", "de", "de la", "des"))]
            if p["type"] == "Parc":
                aliases.append(f"Parc-{p['specific']}")
            if p.get("alt"):
                aliases.append(f"{p['type']} {p['alt']}")
            sig, refs, _ = place_signal(ctx, full_fr, f"parc {p['specific']}")
            # Familiarity: park size (ha) and Wikipedia coverage.
            answers.append(Answer(en=full_en, fr=full_fr, aliases=aliases, signal=math.log1p(p["ha"]) + math.log1p(sig), refs=refs))
        out.append(
            Candidate(
                id=make_id("park-in", name),
                template="park-in-area",
                concept=f"park-in:{name}",
                category="parks",
                scope=area_scope(a),
                prompt={"en": f"Name a public park {prep_en(a)}.", "fr": f"Nommez un parc public {prep_fr(a)}."},
                eligibility={
                    "en": f"Named borough and large parks (parcs, squares, nature parks) in the City's green-space inventory located {prep_en(a)} ({len(answers)}).",
                    "fr": f"Parcs, squares et parcs-nature nommés de l'inventaire des espaces verts de la Ville situés {prep_fr(a)} ({len(answers)}).",
                },
                sources=[ctx.src["parcs"], ctx.src["limites"], ctx.src["wikidata"]],
                answers=answers,
                est_basis="park-area+wikidata-sitelinks",
            )
        )
    return out


NETWORKS = {
    "Bibliothèque": ("library", "a public library in the Montréal library network", "une bibliothèque du réseau des bibliothèques de Montréal"),
    "Salle de spectacle": ("venue", "a municipal performance venue (salle de spectacle) in Montréal", "une salle de spectacle municipale de Montréal"),
    "Musée municipal": ("museum", "a municipal museum of the City of Montréal", "un musée municipal de la Ville de Montréal"),
    "Espace pour la vie": ("espace-pour-la-vie", "one of the Espace pour la vie nature museums", "l'un des musées de nature d'Espace pour la vie"),
}


# Everyday short forms for well-known places (matched on the official French name).
CULTURE_ALIASES = {
    "Biodôme": ["Biodôme", "Biodome"],
    "Insectarium": ["Insectarium"],
    "Planétarium": ["Planétarium", "Planetarium", "Planétarium de Montréal", "Montreal Planetarium"],
    "Jardin botanique": ["Jardin botanique", "Botanical Garden", "Botanical Gardens", "Montreal Botanical Garden"],
    "Pointe-à-Callière": ["Pointe-à-Callière", "Musée Pointe-à-Callière"],
    "Centre d'histoire": ["Centre d'histoire", "MEM", "MEM - Centre des mémoires montréalaises", "Centre des mémoires montréalaises"],
    "Centre d’histoire": ["Centre d'histoire", "MEM", "MEM - Centre des mémoires montréalaises", "Centre des mémoires montréalaises"],
}


def _in_network(c: dict, net: str) -> bool:
    if net not in c["networks"]:
        return False
    # The library network lists BAnQ's Grande Bibliothèque (provincial, not a City library) and a cultural
    # centre whose library is listed separately; keep only the City's own "Bibliothèque …" branches.
    if net == "Bibliothèque":
        return c["name"].startswith("Bibliothèque ") and not c["name"].startswith("Grande Bibliothèque")
    return True


def culture_templates(ctx: Context) -> list[Candidate]:
    out = []
    areas = {a.name: a for a in ctx.areas}
    for net, (slug, en_desc, fr_desc) in NETWORKS.items():
        places = [c for c in ctx.culture if _in_network(c, net)]
        if len(places) < MIN_ANSWERS:
            continue

        def ans(c: dict) -> Answer:
            aliases = []
            for prefix in ("Bibliothèque ", "Maison de la culture ", "Salle "):
                if c["name"].startswith(prefix):
                    aliases.append(c["name"][len(prefix):])
            for key, extra in CULTURE_ALIASES.items():
                if key in c["name"]:
                    aliases += extra
            sig, refs, en = place_signal(ctx, c["name"])
            return Answer(en=en or c["name"], fr=c["name"], aliases=aliases, signal=math.log1p(sig), refs=refs)

        out.append(
            Candidate(
                id=make_id("culture", slug),
                template="culture-network",
                concept=f"culture:{slug}",
                category="festivals",
                scope="city",
                prompt={"en": f"Name {en_desc}.", "fr": f"Nommez {fr_desc}."},
                eligibility={
                    "en": f"Places listed under “{net}” in the City's municipal cultural places dataset ({len(places)}).",
                    "fr": f"Lieux classés « {net} » dans les lieux culturels municipaux de la Ville ({len(places)}).",
                },
                sources=[ctx.src["culture"], ctx.src["wikidata"]],
                answers=[ans(c) for c in places],
                est_basis="wikidata-sitelinks",
            )
        )
        if net != "Bibliothèque":
            continue
        by_area: dict[str, list[dict]] = defaultdict(list)
        for c in places:
            by_area[c["area"]].append(c)
        for name, libs in sorted(by_area.items()):
            a = areas.get(name)
            if not a or len(libs) < MIN_ANSWERS:
                continue
            out.append(
                Candidate(
                    id=make_id("library-in", name),
                    template="library-in-area",
                    concept=f"library-in:{name}",
                    category="festivals",
                    scope=area_scope(a),
                    prompt={"en": f"Name a public library {prep_en(a)}.", "fr": f"Nommez une bibliothèque publique {prep_fr(a)}."},
                    eligibility={
                        "en": f"Montréal network libraries the City lists {prep_en(a)} ({len(libs)}).",
                        "fr": f"Bibliothèques du réseau montréalais que la Ville situe {prep_fr(a)} ({len(libs)}).",
                    },
                    sources=[ctx.src["culture"], ctx.src["wikidata"]],
                    answers=[ans(c) for c in libs],
                    est_basis="wikidata-sitelinks",
                )
            )
    return out


def art_templates(ctx: Context) -> list[Candidate]:
    out = []

    def ans(artist: str, works: int) -> Answer:
        hit = ctx.wd_people.lookup(artist)
        sl = float(hit[0]) if hit else 0.0
        parts = artist.split()
        aliases = [parts[-1]] if len(parts) > 1 and len(parts[-1]) >= 4 else []
        return Answer(en=artist, aliases=aliases, signal=math.log1p(sl) + 0.3 * math.log1p(works), refs=[f"wikidata:{hit[2]}"] if hit else [])

    counts: dict[str, int] = defaultdict(int)
    for w in ctx.art:
        for artist in w["artists"]:
            counts[artist] += 1
    out.append(
        Candidate(
            id=make_id("public-art-artist"),
            template="public-art-artist",
            concept="public-art-artist",
            category="festivals",
            scope="city",
            prompt={"en": "Name an artist with a work in the City of Montréal's public art collection.", "fr": "Nommez une ou un artiste dont une œuvre fait partie de la collection d'art public de la Ville de Montréal."},
            eligibility={
                "en": f"Artists credited in the City's public art inventory ({len(counts)}).",
                "fr": f"Artistes crédités dans l'inventaire d'art public de la Ville ({len(counts)}).",
            },
            sources=[ctx.src["art"], ctx.src["wikidata"]],
            answers=[ans(a, n) for a, n in sorted(counts.items())],
            est_basis="wikidata-sitelinks+works-count",
        )
    )
    return out


def rem_templates(ctx: Context) -> list[Candidate]:
    src = [ctx.src["rem"], ctx.src["wikidata"]]
    stations = list(ctx.rem.stations.values())
    areas = {a.name: a for a in ctx.areas}

    def ans(st: gtfs.Station) -> Answer:
        sig, refs, _ = place_signal(ctx, f"{st.name} (REM)", f"Gare {st.name}", f"Station {st.name}")
        # Trunk stations served by every route are busier and better known.
        return Answer(en=st.name, signal=math.log1p(sig) + 0.8 * len(st.lines), refs=[f"gtfs-rem:{st.parent_id}", *refs])

    def cand(slug: str, concept: str, scope: str, en: str, fr: str, el_en: str, el_fr: str, sts: list) -> Candidate:
        return Candidate(
            id=make_id("rem", slug),
            template="rem",
            concept=concept,
            category="transit",
            scope=scope,
            prompt={"en": en, "fr": fr},
            eligibility={"en": f"{el_en} ({len(sts)} stations, REM GTFS feed {ctx.rem.feed_version}).", "fr": f"{el_fr} ({len(sts)} stations, GTFS du REM {ctx.rem.feed_version})."},
            sources=src if "limites" not in concept else [ctx.src["rem"], ctx.src["limites"], ctx.src["wikidata"]],
            answers=[ans(s) for s in sts],
            est_basis="wikidata-sitelinks+routes-served",
        )

    out = [
        cand("station", "rem-station", "greater", "Name a station of the REM light-rail network.", "Nommez une station du Réseau express métropolitain (REM).",
             "Stations with scheduled REM service", "Stations desservies selon l'horaire du REM", stations),
        cand("terminus", "rem-terminus", "greater", "Name a REM station at the end of a branch (a terminus).", "Nommez une station du REM située au bout d'une antenne (un terminus).",
             "First or last stops of the longest REM trips on each route", "Premiers ou derniers arrêts des trajets complets de chaque route du REM",
             [s for s in stations if s.termini_of]),
    ]
    all_routes = set().union(*(s.lines for s in stations))
    for route in sorted(all_routes):
        only = [s for s in stations if s.lines == {route}]
        if len(only) >= MIN_ANSWERS:
            end = max(only, key=lambda s: len(s.termini_of))
            out.append(
                cand(f"branch-{slugify_name(end.name)}", f"rem-branch:{route}", "greater",
                     f"Name a REM station on the {end.name} branch (served only by that branch).",
                     f"Nommez une station du REM sur l'antenne {de(end.name)} (desservie seulement par cette antenne).",
                     f"Stations served only by REM route {route}", f"Stations desservies uniquement par la route {route} du REM", only)
            )
    inside = [s for s in stations if (a := ctx.area_index.locate(s.lon, s.lat)) and areas[a].kind == "borough"]
    outside = [s for s in stations if s not in inside]
    border = [s.name for s in stations if ctx.area_index.near_boundary(s.lon, s.lat)]
    out.append(cand("in-city", "rem-in-city:limites", "city", "Name a REM station located inside the City of Montréal (in one of its boroughs).",
                    "Nommez une station du REM située dans la Ville de Montréal (dans l'un de ses arrondissements).",
                    "REM stations inside the City of Montréal's borough boundaries", "Stations du REM à l'intérieur des limites des arrondissements de la Ville", inside))
    out.append(cand("outside-city", "rem-outside-city:limites", "greater", "Name a REM station located OUTSIDE the City of Montréal.",
                    "Nommez une station du REM située À L'EXTÉRIEUR de la Ville de Montréal.",
                    "REM stations outside the City of Montréal's borough boundaries (other island municipalities, Laval, South and North Shore)",
                    "Stations du REM hors des arrondissements de la Ville (autres villes de l'île, Laval, Rive-Sud et Rive-Nord)", outside))
    if border:
        for c in out[-2:]:
            c.warnings.append(f"near a boundary (verify): {', '.join(border)}")
    return out


def slugify_name(n: str) -> str:
    from ..normalize import slugify

    return slugify(n)


ALL = [metro_templates, rem_templates, area_templates, park_templates, culture_templates, art_templates]
