"""Expansion phase C: questions whose eligible set is a revision-pinned Wikipedia list or category.

Wikipedia (CC BY-SA 4.0) is used for facts only (names in lists/categories); no prose is reused.
Every answer is linked to Wikidata through its article when one exists (QID ref, EN/FR labels,
sitelink familiarity signal). Prompts say "past or present" whenever a list mixes defunct items.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field

from ..model import Answer, Candidate, make_id
from ..normalize import normalize_answer
from ..sources import ckan, wikidata, wikipedia
from . import Context, place_signal
from .expansion import MIN, _same_thing

PAREN = re.compile(r"\s*\([^)]*\)")


@dataclass
class Item:
    label: str  # French display name (list label or article title)
    title: str | None = None  # frwiki article
    extra: dict = field(default_factory=dict)


def _clean(s: str) -> str:
    s = PAREN.sub("", s).replace("’", "'")
    return re.sub(r"\s+", " ", s).strip(" -–,.;:")


def _bullet_item(line: str) -> Item | None:
    """'* [[Title|Label]] (FIJM), fondé en 1951' → Item(Label, Title). Plain bullets keep text up to the first separator."""
    body = line.lstrip("*").strip()
    m = re.match(r"^(?:Le |La |L')?\[\[([^\]|]+)(?:\|([^\]]+))?\]\]", body)
    if m:
        return Item(_clean(m.group(2) or m.group(1)), m.group(1).strip())
    text = wikipedia.plain(body)
    text = re.split(r"\s+[-–(]|,|:", text)[0]
    text = _clean(text)
    return Item(text) if 2 < len(text) < 70 and not re.match(r"^(\[|http)", text) else None


def sections(wikitext: str) -> dict[str, str]:
    out, cur = {}, None
    for line in wikitext.split("\n"):
        m = re.match(r"^(==+)\s*(.*?)\s*\1\s*$", line)
        if m:
            cur = wikipedia.plain(m.group(2))
            out[cur] = ""
        elif cur:
            out[cur] += line + "\n"
    return out


def bullets(text: str) -> list[Item]:
    items = []
    for line in text.split("\n"):
        if re.match(r"^\*[^*]", line):
            it = _bullet_item(line)
            if it:
                items.append(it)
    return items


# ---------------------------------------------------------------- specs
@dataclass
class Spec:
    key: str
    category: str
    scope: str
    prompt: tuple[str, str]
    eligibility: tuple[str, str]
    collect: object  # () -> tuple[list[Item], list[dict]]
    aliases: dict[str, list[str]] = field(default_factory=dict)  # normalized label → extra aliases
    exclude: tuple[str, ...] = ()


SKIP_SUBCATS = {"Juste pour rire"}  # a company category (people, TV shows, a museum), not festivals


def _cat(title: str, *, subcats: bool = True, depth: int = 1) -> tuple[list[Item], list[dict]]:
    pages, subs, src = wikipedia.category(title)
    items = [Item(_clean(p), p) for p in pages if not p.startswith("Liste ")]
    srcs = [src]
    if subcats and depth > 0:
        for s in subs:
            if s in SKIP_SUBCATS:
                continue
            more, ssrc = _cat(s, subcats=True, depth=depth - 1)
            items += more
            srcs += ssrc
    return items, srcs


def _section(page: str, *names: str) -> tuple[list[Item], list[dict]]:
    txt, src = wikipedia.page(page, "fr")
    secs = sections(txt)
    items: list[Item] = []
    for n in names:
        items += bullets(secs.get(n, ""))
    return items, [src]


def _union(*parts: tuple[list[Item], list[dict]]) -> tuple[list[Item], list[dict]]:
    items, srcs = [], []
    for it, s in parts:
        items += it
        srcs += s
    seen, out_src = set(), []
    for s in srcs:
        if s["url"] not in seen:
            seen.add(s["url"])
            out_src.append(s)
    return items, out_src


def _bridges(section_prefix: str) -> tuple[list[Item], list[dict]]:
    txt, src = wikipedia.page("Liste des ponts de Montréal", "fr")
    items = []
    for name, body in sections(txt).items():
        if not name.startswith(section_prefix):
            continue
        for t in wikipedia.tables(body + "\n|}" if body.count("{|") > body.count("|}") else body):
            for r in t:
                if not r:
                    continue
                label = wikipedia.plain(r[0])
                if re.match(r"^(Pont|Tunnel|Estacade|Viaduc)\S*\s+\S", label):
                    links = wikipedia.link_targets(r[0])
                    items.append(Item(_clean(label), links[0] if links else None))
    return items, [src]


def _table_rows(page: str, pred, name_col: int, min_cols: int) -> tuple[list[Item], list[dict]]:
    txt, src = wikipedia.page(page, "fr")
    items = []
    for t in wikipedia.tables(txt):
        for r in t[1:]:
            if len(r) >= min_cols and pred([wikipedia.plain(c) for c in r]):
                links = wikipedia.link_targets(r[name_col])
                label = _clean(wikipedia.plain(r[name_col]).split(",")[0])
                if label:
                    items.append(Item(label, links[0] if links else None))
    return items, [src]


def _skyscrapers(pred) -> tuple[list[Item], list[dict]]:
    """Skyscraper table: tied ranks span rows (later rows lack the rank cell)."""
    txt, src = wikipedia.page("Liste des plus hautes constructions de Montréal", "fr")
    items, rank = [], 0
    for r in wikipedia.tables(txt)[0][1:]:
        c = [wikipedia.plain(x) for x in r]
        if not c:
            continue
        if re.match(r"^\d+", c[0]):
            rank, off = int(re.match(r"^\d+", c[0]).group(0)), 1
        else:
            off = 0
        if len(c) < off + 6:
            continue
        year = int(_num(c[off + 5])) if _num(c[off + 5]) else 0
        if pred(rank, year):
            links = wikipedia.link_targets(r[off])
            items.append(Item(_clean(c[off]), links[0] if links else None))
    return items, [src]


def compact(s: str) -> str:
    """Alias-table key: lower-case, accents and every non-alphanumeric removed ('Pont Jacques-Cartier' → 'pontjacquescartier')."""
    import unicodedata

    return re.sub(r"[^a-z0-9]", "", unicodedata.normalize("NFKD", s.lower()).encode("ascii", "ignore").decode())


def _num(s: str) -> float:
    m = re.search(r"\d+(?:[.,]\d+)?", s.replace(" ", ""))
    return float(m.group(0).replace(",", ".")) if m else 0.0


FEST = "Liste des festivals et événements à Montréal"

SPECS: list[Spec] = [
    # ------------------------------------------------ festivals & cultural events
    Spec(
        "fest-music", "festivals", "island",
        ("Name a music festival held in Montréal (past or present).", "Nommez un festival de musique tenu à Montréal (passé ou actuel)."),
        ("Festivals in French Wikipedia's category Festival de musique à Montréal or the Musique section of its List of festivals and events in Montréal.",
         "Festivals de la catégorie Festival de musique à Montréal de Wikipédia ou de la section Musique de la Liste des festivals et événements à Montréal."),
        lambda: _union(_cat("Festival de musique à Montréal"), _section(FEST, "Musique")),
        exclude=("Festivals de Montréal",),
        aliases=
        {"festivalinternationaldejazzdemontreal": ["Jazz Fest", "Montreal Jazz Festival", "FIJM", "Festival de jazz", "Jazz Festival"],
         "francofoliesdemontreal": ["Francos", "FrancoFolies", "Francofolies"], "osheaga": ["Osheaga Festival", "Osheaga Music and Arts Festival"],
         "igloofest": ["Igloo Fest"], "festivalinternationalnuitsdafrique": ["Nuits d'Afrique"], "popmontreal": ["Pop Montréal"],
         "mutek": ["MUTEK Montréal"], "piknicelectronik": ["Piknic", "Piknic Électronik"], "ilesoniq": ["Île Soniq", "Ile Soniq"]},
    ),
    Spec(
        "fest-film", "festivals", "island",
        ("Name a film festival held in Montréal (past or present).", "Nommez un festival de cinéma tenu à Montréal (passé ou actuel)."),
        ("Festivals in French Wikipedia's category Festival de cinéma à Montréal (and its subcategories) or the Cinéma section of its List of festivals and events in Montréal.",
         "Festivals de la catégorie Festival de cinéma à Montréal de Wikipédia (et sous-catégories) ou de la section Cinéma de la Liste des festivals et événements à Montréal."),
        lambda: _union(_cat("Festival de cinéma à Montréal"), _section(FEST, "Cinéma")),
        exclude=("Image & nation",),  # same festival as the Image+Nation article; its spelling is kept as an alias
        aliases={"imagenation": ["Image & Nation", "Image et Nation"], "fantasia": ["Fantasia", "Fantasia Festival", "Fantasia International Film Festival"], "festivaldunouveaucinema": ["FNC", "Festival du nouveau cinéma"],
         "festivaldesfilmsdumondedemontreal": ["FFM", "Montreal World Film Festival", "World Film Festival"],
         "rencontresinternationalesdudocumentairedemontreal": ["RIDM"]},
    ),
    Spec(
        "fest-stage", "festivals", "island",
        ("Name a theatre, dance or comedy festival held in Montréal (past or present).", "Nommez un festival de théâtre, de danse ou d'humour tenu à Montréal (passé ou actuel)."),
        ("Entries in the Théâtre, Danse and Humour sections of French Wikipedia's List of festivals and events in Montréal.",
         "Entrées des sections Théâtre, Danse et Humour de la Liste des festivals et événements à Montréal de Wikipédia."),
        lambda: _section(FEST, "Théâtre", "Danse", "Humour"),
        {"justepourrire": ["Just for Laughs", "JFL", "JPR"], "festivaltransameriques": ["FTA", "Festival TransAmériques"], "zoofest": ["Zoofest"],
         "montrealfringefestival": ["Fringe", "St-Ambroise Fringe", "Montreal Fringe"]},
    ),
    Spec(
        "fest-arts", "festivals", "island",
        ("Name a visual-arts, literary or multidisciplinary festival held in Montréal (past or present).", "Nommez un festival d'arts visuels, de littérature ou multidisciplinaire tenu à Montréal (passé ou actuel)."),
        ("Entries in the Arts visuels, Littérature and Pluridisciplinaire sections of French Wikipedia's List of festivals and events in Montréal.",
         "Entrées des sections Arts visuels, Littérature et Pluridisciplinaire de la Liste des festivals et événements à Montréal de Wikipédia."),
        lambda: _section(FEST, "Arts visuels", "Littérature", "Pluridisciplinaire"),
        {"festivalmural": ["MURAL", "Mural Festival"], "festivalinternationaldelitteraturemetropolisbleu": ["Blue Metropolis", "Métropolis bleu"],
         "montrealenlumiere": ["Montréal en lumière", "Montreal High Lights", "MEL"], "nuitblanche": ["Nuit blanche"]},
    ),
    Spec(
        "fest-any", "festivals", "island",
        ("Name a festival held in Montréal (past or present).", "Nommez un festival tenu à Montréal (passé ou actuel)."),
        ("Articles in French Wikipedia's category Festival à Montréal and its music and film subcategories.",
         "Articles de la catégorie Festival à Montréal de Wikipédia et de ses sous-catégories musique et cinéma."),
        lambda: _cat("Festival à Montréal", depth=2),
        exclude=("Festivals de Montréal",),
        aliases=
        {"festivalinternationaldejazzdemontreal": ["Jazz Fest", "Montreal Jazz Festival", "FIJM"], "justepourrire": ["Just for Laughs", "JFL"],
         "francofoliesdemontreal": ["Francos", "FrancoFolies"], "fantasia": ["Fantasia Festival"]},
    ),
    # ------------------------------------------------ landmarks & culture
    Spec(
        "theatre", "history", "city",
        ("Name a theatre in the City of Montréal.", "Nommez un théâtre de la ville de Montréal."),
        ("Theatres on French Wikipedia's List of theatres in Montréal.", "Théâtres de la Liste des théâtres de Montréal de Wikipédia."),
        lambda: _section("Liste des théâtres de Montréal", "Théâtres"),
        {"theatredunouveaumonde": ["TNM"], "centaurtheatre": ["Centaur", "Théâtre Centaur"]},
    ),
    Spec(
        "skyscraper-top25", "history", "city",
        ("Name one of the 25 tallest skyscrapers in Montréal.", "Nommez l'un des 25 plus hauts gratte-ciel de Montréal."),
        ("Buildings ranked 1–25 in French Wikipedia's List of the tallest structures in Montréal (skyscraper table, revision cited).",
         "Immeubles classés 1 à 25 dans la Liste des plus hautes constructions de Montréal de Wikipédia (tableau des gratte-ciel, révision citée)."),
        lambda: _skyscrapers(lambda rank, year: rank <= 25),
        exclude=("Le de la Montagne",),
        aliases=
        {"1000delagauchetiere": ["1000 de la Gauchetière", "Mille de la Gauchetière"], "placevillemarie": ["PVM", "Place Ville-Marie"],
         "tourdelabourse": ["Stock Exchange Tower"], "1250rene-levesque": ["IBM-Marathon"]},
    ),
    Spec(
        "skyscraper-old", "history", "city",
        ("Name a Montréal skyscraper completed before 1975.", "Nommez un gratte-ciel de Montréal achevé avant 1975."),
        ("Buildings in the skyscraper table of French Wikipedia's List of the tallest structures in Montréal whose completion year is before 1975.",
         "Immeubles du tableau des gratte-ciel de la Liste des plus hautes constructions de Montréal de Wikipédia achevés avant 1975."),
        lambda: _skyscrapers(lambda rank, year: 1900 < year < 1975),
        {"placevillemarie": ["PVM", "Place Ville-Marie"], "tourdelabourse": ["Stock Exchange Tower"], "chateauchamplain": ["Château Champlain", "Marriott Château Champlain"]},
    ),
    Spec(
        "mall", "boroughs", "island",
        ("Name a shopping centre on the Island of Montréal (past or present).", "Nommez un centre commercial de l'île de Montréal (passé ou actuel)."),
        ("Shopping centres on French Wikipedia's List of shopping centres in Montréal (all boroughs and municipalities).",
         "Centres commerciaux de la Liste des centres commerciaux de Montréal de Wikipédia (tous les arrondissements et villes)."),
        lambda: _section_all("Liste des centres commerciaux de Montréal"),
        {"centreeatondemontreal": ["Eaton Centre", "Centre Eaton"], "complexedesjardins": ["Desjardins"], "carrefourangrignon": ["Angrignon"]},
    ),
    # ------------------------------------------------ bridges
    Spec(
        "bridge-st-lawrence", "transit", "greater",
        ("Name a bridge or crossing over the St. Lawrence River at Montréal.", "Nommez un pont ou un ouvrage qui traverse le fleuve Saint-Laurent à Montréal."),
        ("Crossings in the Saint-Laurent table of French Wikipedia's List of bridges of Montréal (road, rail and other).",
         "Ouvrages du tableau du fleuve Saint-Laurent de la Liste des ponts de Montréal de Wikipédia (routiers, ferroviaires et autres)."),
        lambda: _bridges("Ponts traversant le fleuve"),
        {"pontjacques-cartier": ["Jacques Cartier Bridge", "Jacques-Cartier"], "pontsamuel-dechamplain": ["Champlain Bridge", "Pont Champlain", "Samuel De Champlain Bridge"],
         "pontvictoria": ["Victoria Bridge"], "ponthonore-mercier": ["Mercier Bridge", "Pont Mercier", "Honoré Mercier Bridge"],
         "tunnellouis-hippolyte-lafontaine": ["Lafontaine Tunnel", "Tunnel La Fontaine", "LaFontaine Tunnel"], "pontdelaconcorde": ["Concorde Bridge"]},
    ),
    Spec(
        "bridge-prairies", "transit", "greater",
        ("Name a bridge over the Rivière des Prairies (between Montréal and Laval or Repentigny).", "Nommez un pont qui traverse la rivière des Prairies (entre Montréal et Laval ou Repentigny)."),
        ("Crossings in the Rivière des Prairies table of French Wikipedia's List of bridges of Montréal.",
         "Ouvrages du tableau de la rivière des Prairies de la Liste des ponts de Montréal de Wikipédia."),
        lambda: _bridges("Ponts traversant la rivière des Prairies"),
        {"pontpie-ix": ["Pie-IX Bridge"], "pontviau": ["Viau Bridge"], "pontpapineau-leblanc": ["Papineau Bridge", "Pont Papineau"], "pontlachapelle": ["Lachapelle Bridge"],
         "pontmedericmartin": ["Médéric-Martin"], "pontlouis-bisson": ["Louis-Bisson"]},
    ),
    Spec(
        "bridge-west", "transit", "greater",
        ("Name a bridge over Lac des Deux Montagnes or the Ottawa River at the west end of Montréal Island.", "Nommez un pont qui traverse le lac des Deux Montagnes ou la rivière des Outaouais à l'ouest de l'île de Montréal."),
        ("Crossings in the Lac des Deux-Montagnes / Rivière des Outaouais table of French Wikipedia's List of bridges of Montréal.",
         "Ouvrages du tableau du lac des Deux-Montagnes et de la rivière des Outaouais de la Liste des ponts de Montréal de Wikipédia."),
        lambda: _bridges("Ponts traversant le Lac des Deux-Montagnes"),
        {"pontdelile-aux-tourtes": ["Île-aux-Tourtes", "Ile aux Tourtes Bridge"], "pontgalipeault": ["Galipeault"], "ponttaschereau": ["Taschereau Bridge"]},
    ),
    # ------------------------------------------------ food culture
    Spec(
        "food-quebec-cheese", "food", "province",
        ("Name a Québec cheese.", "Nommez un fromage québécois."),
        ("Cheeses in French Wikipedia's category Fromage québécois (brands and named cheeses).", "Fromages de la catégorie Fromage québécois de Wikipédia (marques et fromages nommés)."),
        lambda: _cat("Fromage québécois", subcats=False),
        exclude=("Musée du fromage cheddar", "Sélection Caseus", "Liste de fromageries québécoises"),
        aliases={"oka": ["Oka cheese", "Fromage Oka"], "leriopelledelisleauxgrues": ["Riopelle", "Le Riopelle"]},
    ),
    Spec(
        "food-quebec-cuisine", "food", "province",
        ("Name a dish, food or treat from Québec cuisine.", "Nommez un plat, un aliment ou une gâterie de la cuisine québécoise."),
        ("Articles in French Wikipedia's category Cuisine québécoise and its Soupe québécoise / Cuisine montréalaise subcategories (cheeses, restaurants and businesses excluded).",
         "Articles de la catégorie Cuisine québécoise de Wikipédia et de ses sous-catégories Soupe québécoise / Cuisine montréalaise (fromages, restaurants et entreprises exclus)."),
        lambda: _union(_cat("Cuisine québécoise", subcats=False), _cat("Soupe québécoise", subcats=False), _cat("Cuisine montréalaise", subcats=False)),
        {"poutine": ["Poutine"], "tourtiere": ["Meat pie", "Tourtiere"], "patechinois": ["Shepherd's pie", "Pâté chinois"], "poudingchomeur": ["Pouding chômeur", "Pudding chômeur"],
         "bageldemontreal": ["Montreal bagel", "Montreal-style bagel", "Bagel"], "smokedmeat": ["Smoked meat", "Montreal smoked meat", "Viande fumée"],
         "hot-dogdemontreal": ["Steamé", "Steamie", "Montreal hot dog", "Hot-dog steamé"], "epicesasteakdemontreal": ["Montreal steak spice", "Steak spice"]},
        exclude=("Cuisine québécoise", "Assaisonnées", "Brasserie Dawes", "Brasserie Ekers", "Édifice de l'École-Britannique-et-Canadienne-de-Montréal", "Fairmount Bagel", "St-Viateur Bagel",
                 "Schwartz's", "La Binerie Mont-Royal", "St. Lawrence", "Gibeau Orange Julep", "Wilensky's Light Lunch", "Ah Caramel!", "Restaurant au Québec"),
    ),
    Spec(
        "food-microbrewery-mtl", "food", "city",
        ("Name a microbrewery or brewpub in Montréal.", "Nommez une microbrasserie ou une brasserie artisanale à Montréal."),
        ("Breweries whose city is Montréal in the regional tables of French Wikipedia's List of microbreweries in Québec (revision cited; permit-holders).",
         "Brasseries dont la ville est Montréal dans les tableaux régionaux de la Liste de microbrasseries au Québec de Wikipédia (révision citée; titulaires de permis)."),
        lambda: _table_rows("Liste de microbrasseries au Québec", lambda c: len(c) >= 3 and c[2].strip() == "Montréal", 0, 3),
        {"dieuduciel": ["Dieu du Ciel!", "Dieu du Ciel"], "brasseurdemontreal": ["Brasseur de Montréal"]},
    ),
]


def _section_all(page: str) -> tuple[list[Item], list[dict]]:
    """Bullets under sections named after an island borough or municipality (off-island sections skipped)."""
    from ..sources import montreal

    areas, _ = montreal.areas()
    names = {normalize_answer(a.name) for a in areas} | {"villedemontreal"}
    txt, src = wikipedia.page(page, "fr")
    items = []
    for name, body in sections(txt).items():
        if normalize_answer(name) in names:
            items += [i for i in bullets(body) if normalize_answer(i.label) not in names]
    return items, [src]


# ---------------------------------------------------------------- restaurants: category ∩ open in the City registry
def _registry_open() -> tuple[list[dict], dict]:
    f, src = ckan.resource("etablissements-alimentaires", fmt="csv")
    rows = [r for r in ckan.read_csv(f) if r["statut"] == "Ouvert"]
    return rows, src


# Verified by hand against the registry (name differs too much for the automatic match): article → business_id.
REGISTRY_OVERRIDES = {
    "Dunn's": "66865",  # RESTAURANT FAMEUX DUNN'S DECARIE, 7385 boul. Décarie — Ouvert
    "Moishes Steakhouse": "128148",
    "Décarie Hot Dogs": "72556",  # RESTAURANT DECARIE HOT DOG, 953 boul. Décarie — Ouvert  # MOISHES, 1001 rue Square-Victoria (moved from The Main) — Ouvert
}

REG_PREFIX = re.compile(r"^(restaurant|resto|casse[- ]croute|bistro|cafe|les? restaurants?)\s+", re.I)
REG_SUFFIX = re.compile(r"\s+(inc|ltee|ltd)\.?$", re.I)


def _registry_key(name: str) -> str:
    """'RESTAURANT JOE BEEF (NOTRE-DAME)' → key of 'Joe Beef'; 'CASSE-CROUTE WILENSKY'S' → 'wilenskys'."""
    import unicodedata

    s = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode()
    s = PAREN.sub("", s).strip()
    for _ in range(2):
        s = REG_SUFFIX.sub("", REG_PREFIX.sub("", s)).strip()
    return normalize_answer(s)


def restaurant_candidate(ctx: Context, info: dict) -> Candidate | None:
    """Well-known restaurants (French + English Wikipedia restaurant categories), kept only if a matching
    establishment is OPEN in the City's food-inspection registry (name match, normalized)."""
    fr_pages, _, fr_src = wikipedia.category("Restaurant à Montréal")
    en_pages, en_subs, en_src = wikipedia.category("Restaurants in Montreal", lang="en")
    for sub in en_subs:
        if "Defunct" in sub:
            continue
        more, _, _ = wikipedia.category(sub, lang="en")
        en_pages += more
    reg, reg_src = _registry_open()
    reg_keys: dict[str, dict] = {}
    for r in reg:
        if r["type"].startswith("Événements"):  # one-off event permits are not the restaurant itself
            continue
        reg_keys.setdefault(_registry_key(r["name"]), r)
    seen, answers = set(), []
    for lang, pages in (("fr", fr_pages), ("en", en_pages)):
        for p in pages:
            name = _clean(p)
            k = normalize_answer(name)
            if k in seen:
                continue
            hits = [r for rk, r in reg_keys.items() if k and (rk == k or rk.startswith(k) and len(k) >= 5)]
            if not hits and name in REGISTRY_OVERRIDES:
                hits = [r for r in reg if r["business_id"] == REGISTRY_OVERRIDES[name]]
            if not hits:
                continue
            seen.add(k)
            wd = info.get((lang, p))
            bid = f"mtl-food:{hits[0]['business_id']}"
            same = next((x for x in answers if bid in x.refs), None)
            if same:  # same establishment under another article title (e.g. Wilensky / Wilensky's)
                same.aliases.append(name)
                continue
            a = Answer(en=name, refs=[bid])
            if wd:
                a.refs.append(f"wikidata:{wd['qid']}")
                a.signal = math.log1p(wd["sl"])
                other = wd.get("en" if lang == "fr" else "fr")
                if other and normalize_answer(other) != k and _same_thing(name, other):
                    a.aliases.append(_clean(other))
            answers.append(a)
    if len(answers) < MIN:
        return None
    return Candidate(
        id=make_id("food-restaurant-famous"),
        template="wiki-restaurant-open",
        concept="food:famous-restaurant",
        category="food",
        scope="island",
        prompt={"en": "Name a famous Montréal restaurant that is still open.", "fr": "Nommez un restaurant célèbre de Montréal toujours ouvert."},
        eligibility={
            "en": "Restaurants with an article in Wikipedia's Montréal restaurant categories (FR or EN, defunct excluded) that are listed as open in the City of Montréal's food-establishment registry.",
            "fr": "Restaurants ayant un article dans les catégories de restaurants de Montréal de Wikipédia (FR ou EN, disparus exclus) inscrits comme ouverts au registre des établissements alimentaires de la Ville de Montréal.",
        },
        sources=[fr_src, en_src, reg_src],
        answers=answers,
        est_basis="wikidata-sitelinks",
    )


# ---------------------------------------------------------------- build
def wikilist_templates(ctx: Context) -> list[Candidate]:
    collected = [(s, *s.collect()) for s in SPECS]  # type: ignore[operator]
    fr_titles = sorted({it.title for _, items, _ in collected for it in items if it.title})
    rest_fr, _, _ = wikipedia.category("Restaurant à Montréal")
    rest_en, en_subs, _ = wikipedia.category("Restaurants in Montreal", lang="en")
    for sub in en_subs:
        if "Defunct" not in sub:
            rest_en += wikipedia.category(sub, lang="en")[0]
    info_fr, r_fr = wikidata.by_wiki(fr_titles + rest_fr, "fr")
    info_en, _ = wikidata.by_wiki(rest_en, "en")
    wsrc = {**wikidata.SOURCE, "retrieved": r_fr}
    out: list[Candidate] = []
    for spec, items, srcs in collected:
        answers: dict[str, Answer] = {}
        by_qid: dict[str, Answer] = {}
        index: dict[str, Answer] = {}
        for it in items:
            if it.label in spec.exclude or (it.title and it.title in spec.exclude):
                continue
            wd = info_fr.get(it.title or "")
            fr = it.label
            en = wd["en"] if wd and wd.get("en") and _same_thing(fr, wd["en"]) else fr
            en = _clean(en)
            k = normalize_answer(en)
            if not k or len(fr) < 3:
                continue
            a = index.get(k) or index.get(normalize_answer(fr)) or (by_qid.get(wd["qid"]) if wd else None)
            if a is None:
                a = Answer(en=en, fr=fr if normalize_answer(fr) != k else None)
                answers[k] = a
            elif normalize_answer(fr) not in (normalize_answer(a.en), normalize_answer(a.fr or "")):
                a.aliases.append(fr)  # same entity listed under another name
            if wd:
                by_qid[wd["qid"]] = a
            for form in (a.en, a.fr or "", fr):
                if normalize_answer(form):
                    index.setdefault(normalize_answer(form), a)
            if it.title and _clean(it.title) not in (a.en, a.fr) and _same_thing(fr, it.title):
                a.aliases.append(_clean(it.title))
            if wd and f"wikidata:{wd['qid']}" not in a.refs:
                a.refs.append(f"wikidata:{wd['qid']}")
                a.signal = max(a.signal, math.log1p(wd["sl"]))
            elif not wd:
                sig, refs, _ = place_signal(ctx, fr, en)
                a.signal = max(a.signal, math.log1p(sig))
                a.refs += [r for r in refs if r not in a.refs]
            table = {compact(k): v for k, v in spec.aliases.items()}
            for form in (a.en, a.fr or "", fr, it.title or ""):
                a.aliases += [x for x in table.get(compact(form), []) if x not in a.aliases]
        if len(answers) < MIN:
            continue
        out.append(
            Candidate(
                id=make_id("wl", spec.key),
                template="wikipedia-list",
                concept=f"wl:{spec.key}",
                category=spec.category,
                scope=spec.scope,
                prompt={"en": spec.prompt[0], "fr": spec.prompt[1]},
                eligibility={"en": spec.eligibility[0], "fr": spec.eligibility[1]},
                sources=srcs + [wsrc],
                answers=list(answers.values()),
                est_basis="wikidata-sitelinks",
            )
        )
    info = {("fr", t): v for t, v in info_fr.items()} | {("en", t): v for t, v in info_en.items()}
    rc = restaurant_candidate(ctx, info)
    if rc:
        out.append(rc)
    return out
