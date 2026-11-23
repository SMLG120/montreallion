"""Expansion phase C (food): eating and drinking places that are OPEN today.

Eligibility = an OpenStreetMap food/drink place on Montréal Island (ODbL; name, tags, location) that matches an
establishment listed as **Ouvert** in the City of Montréal's food-inspection registry (CC BY 4.0): same cleaned name
and within MATCH_M metres. OSM supplies the "what kind of place" (cuisine/shop tags) and a readable name; the City
registry is the authority for "currently operating". Places in only one of the two sources are not eligible (the
appeal flow covers real misses). Chains are one answer (all their open locations together).
"""

from __future__ import annotations

import math
import re
from collections import defaultdict
from dataclasses import dataclass

from ..model import Answer, Candidate, make_id
from ..normalize import normalize_answer
from ..sources import osm
from . import Context, prep_en, prep_fr
from .wikilists import _registry_key, _registry_open

MIN = 5
MAX = 400
MATCH_M = 150.0
REST_PREFIX = re.compile(r"^(restaurant|resto)\s+", re.I)


def _dist_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    return math.hypot((lon1 - lon2) * 111320 * math.cos(math.radians(45.5)), (lat1 - lat2) * 110540)


@dataclass
class Place:
    name: str
    tags: dict
    area: str
    osm_id: str
    reg_id: str
    reg_type: str


_cache: dict = {}


def open_places(ctx: Context) -> tuple[list[Place], list[dict]]:
    """OSM places on the island matched to an OPEN registry establishment (name key + distance)."""
    if "p" in _cache:
        return _cache["p"], _cache["src"]
    pois, osm_src = osm.food_pois()
    reg, reg_src = _registry_open()
    by_key: dict[str, list[dict]] = defaultdict(list)
    for r in reg:
        if r["type"].startswith("Événements") or not r["latitude"]:
            continue
        by_key[_registry_key(r["name"])].append(r)
    out = []
    for p in pois:
        name = re.sub(r"\s+", " ", p["tags"].get("name", "")).strip()
        k = _registry_key(name)
        if len(k) < 3:
            continue
        area = ctx.area_index.locate(p["lon"], p["lat"])
        if not area:
            continue  # off the island
        best = None
        for r in by_key.get(k, []):
            d = _dist_m(p["lat"], p["lon"], float(r["latitude"]), float(r["longitude"]))
            if d <= MATCH_M and (best is None or d < best[0]):
                best = (d, r)
        if best:
            out.append(Place(name, p["tags"], area, p["id"], best[1]["business_id"], best[1]["type"]))
    _cache["p"], _cache["src"] = out, [osm_src, reg_src]
    return out, _cache["src"]


def _cuisines(t: dict) -> set[str]:
    return {c.strip().lower() for c in t.get("cuisine", "").split(";") if c.strip()}


def _kind(t: dict) -> str:
    return t.get("amenity") or t.get("shop") or t.get("craft") or ""


EATERY = {"restaurant", "fast_food", "cafe"}


def cuisine(*names: str, kinds: set[str] = EATERY):
    return lambda t: _kind(t) in kinds and bool(_cuisines(t) & set(names))


def kind(*kinds: str):
    return lambda t: _kind(t) in kinds


# key, EN noun phrase, FR noun phrase, OSM definition (for eligibility text), predicate
ISLAND_SPECS = [
    ("vietnamese", "Vietnamese restaurant", "restaurant vietnamien", "cuisine=vietnamese", cuisine("vietnamese")),
    ("chinese", "Chinese restaurant", "restaurant chinois", "cuisine=chinese/dumplings/cantonese/sichuan/szechuan", cuisine("chinese", "dumplings", "cantonese", "sichuan", "szechuan")),
    ("japanese", "Japanese or sushi restaurant", "restaurant japonais ou de sushis", "cuisine=japanese/sushi/ramen", cuisine("japanese", "sushi", "ramen")),
    ("ramen", "ramen restaurant", "restaurant de ramen", "cuisine=ramen/noodle", cuisine("ramen", "noodle")),
    ("korean", "Korean restaurant", "restaurant coréen", "cuisine=korean", cuisine("korean")),
    ("thai", "Thai restaurant", "restaurant thaïlandais", "cuisine=thai", cuisine("thai")),
    ("indian", "Indian, Pakistani or Sri Lankan restaurant", "restaurant indien, pakistanais ou sri-lankais", "cuisine=indian/pakistani/sri_lankan/nepalese", cuisine("indian", "pakistani", "sri_lankan", "nepalese")),
    ("lebanese", "Lebanese or Syrian restaurant", "restaurant libanais ou syrien", "cuisine=lebanese/syrian", cuisine("lebanese", "syrian")),
    ("middle-eastern", "Middle Eastern restaurant (shawarma, falafel, Persian, Turkish…)", "restaurant du Moyen-Orient (shawarma, falafel, persan, turc…)", "cuisine=middle_eastern/shawarma/falafel/persian/turkish/arab/afghan/armenian/kebab", cuisine("middle_eastern", "shawarma", "falafel", "persian", "turkish", "arab", "afghan", "armenian", "kebab")),
    ("greek", "Greek restaurant", "restaurant grec", "cuisine=greek", cuisine("greek")),
    ("italian", "Italian restaurant", "restaurant italien", "cuisine=italian/pasta", cuisine("italian", "pasta")),
    ("pizza", "pizzeria", "pizzéria", "cuisine=pizza", cuisine("pizza")),
    ("portuguese", "Portuguese restaurant", "restaurant portugais", "cuisine=portuguese", cuisine("portuguese")),
    ("french", "French restaurant or bistro", "restaurant français ou bistro", "cuisine=french/bistro/fine_dining", cuisine("french", "bistro", "fine_dining")),
    ("mexican", "Mexican or Latin American restaurant", "restaurant mexicain ou latino-américain", "cuisine=mexican/tacos/latin_american/peruvian/salvadoran/colombian/brazilian", cuisine("mexican", "tacos", "latin_american", "peruvian", "salvadoran", "colombian", "brazilian")),
    ("caribbean", "Caribbean or Haitian restaurant", "restaurant antillais ou haïtien", "cuisine=caribbean/haitian/jamaican/creole", cuisine("caribbean", "haitian", "jamaican", "creole")),
    ("african", "African or North African restaurant", "restaurant africain ou maghrébin", "cuisine=african/ethiopian/moroccan/tunisian/algerian/senegalese/eritrean", cuisine("african", "ethiopian", "moroccan", "tunisian", "algerian", "senegalese", "eritrean")),
    ("filipino-se-asian", "Filipino, Cambodian, Malaysian or Indonesian restaurant", "restaurant philippin, cambodgien, malaisien ou indonésien", "cuisine=filipino/cambodian/malaysian/indonesian/laotian", cuisine("filipino", "cambodian", "malaysian", "indonesian", "laotian")),
    ("bagel", "bagel shop", "commerce de bagels", "cuisine=bagel", cuisine("bagel", kinds=EATERY | {"bakery"})),
    ("poutine", "poutinerie or casse-croûte serving poutine", "poutinerie ou casse-croûte qui sert de la poutine", "cuisine=poutine/fries", cuisine("poutine", "fries")),
    ("hot-dog", "hot-dog or casse-croûte spot", "comptoir de hot-dogs", "cuisine=hot_dog", cuisine("hot_dog")),
    ("burger", "burger restaurant", "restaurant de burgers", "cuisine=burger", cuisine("burger")),
    ("chicken", "chicken or rotisserie restaurant", "restaurant de poulet ou rôtisserie", "cuisine=chicken/rotisserie", cuisine("chicken", "rotisserie")),
    ("bbq-steak", "barbecue, smokehouse or steakhouse", "restaurant de barbecue, fumoir ou steakhouse", "cuisine=barbecue/steak_house/smoked_meat/grill", cuisine("barbecue", "steak_house", "smoked_meat", "grill")),
    ("seafood", "seafood or fish restaurant", "restaurant de poissons et fruits de mer", "cuisine=seafood/fish/fish_and_chips", cuisine("seafood", "fish", "fish_and_chips")),
    ("breakfast", "breakfast or brunch restaurant", "restaurant de déjeuners ou de brunchs", "cuisine=breakfast/brunch/crepe/pancake/waffle", cuisine("breakfast", "brunch", "crepe", "pancake", "waffle")),
    ("sandwich", "sandwich or deli counter", "comptoir de sandwichs ou charcuterie", "cuisine=sandwich/deli/sub", cuisine("sandwich", "deli", "sub")),
    ("vegan", "vegetarian, vegan or salad restaurant", "restaurant végétarien, végane ou de salades", "cuisine=vegetarian/vegan/salad/poke or diet:vegan=only", lambda t: _kind(t) in EATERY and (bool(_cuisines(t) & {"vegetarian", "vegan", "salad", "poke"}) or t.get("diet:vegan") == "only")),
    ("bubble-tea", "bubble-tea or tea shop", "comptoir de bubble tea ou boutique de thé", "cuisine=bubble_tea/tea, shop=tea", lambda t: (_kind(t) in EATERY and bool(_cuisines(t) & {"bubble_tea", "tea"})) or _kind(t) == "tea"),
    ("ice-cream", "ice-cream or frozen-dessert shop", "crèmerie ou bar laitier", "amenity=ice_cream or cuisine=ice_cream/frozen_yogurt/gelato", lambda t: _kind(t) == "ice_cream" or bool(_cuisines(t) & {"ice_cream", "frozen_yogurt", "gelato"})),
    ("dessert", "pastry, dessert, cake or doughnut shop", "pâtisserie ou comptoir de desserts", "shop=pastry or cuisine=dessert/cake/donut/pastry", lambda t: _kind(t) == "pastry" or (_kind(t) in EATERY and bool(_cuisines(t) & {"dessert", "cake", "donut", "pastry"}))),
    ("bakery", "bakery", "boulangerie", "shop=bakery", kind("bakery")),
    ("chocolate", "chocolate or candy shop", "chocolaterie ou confiserie", "shop=chocolate/confectionery", kind("chocolate", "confectionery")),
    ("butcher", "butcher shop", "boucherie", "shop=butcher", kind("butcher")),
    ("fine-food", "fine-food shop (cheese, deli, seafood, coffee roaster…)", "épicerie fine (fromagerie, charcuterie, poissonnerie, brûlerie…)", "shop=cheese/deli/seafood/coffee/wine", kind("cheese", "deli", "seafood", "coffee", "wine")),
    ("greengrocer", "fruit-and-vegetable shop", "fruiterie", "shop=greengrocer", kind("greengrocer")),
    ("coffee-chain", "coffee-shop chain (2+ open locations)", "chaîne de cafés (2 succursales ouvertes ou plus)", "amenity=cafe with 2+ matched open locations", kind("cafe")),
    ("pub", "pub, bar or brewpub", "pub, bar ou brasserie artisanale", "amenity=pub/bar, craft=brewery", kind("pub", "bar", "brewery")),
    ("fast-food-chain", "fast-food chain (3+ open locations)", "chaîne de restauration rapide (3 succursales ouvertes ou plus)", "amenity=fast_food with 3+ matched open locations", kind("fast_food")),
]
CHAIN_MIN = {"coffee-chain": 2, "fast-food-chain": 3}

# Per-area questions (borough or municipality with ≥ MIN distinct open places).
AREA_SPECS = [
    ("cafe", "café", "café", "amenity=cafe", kind("cafe")),
    ("bakery", "bakery or pastry shop", "boulangerie ou pâtisserie", "shop=bakery/pastry", kind("bakery", "pastry")),
    ("restaurant", "sit-down restaurant", "restaurant (service aux tables)", "amenity=restaurant", kind("restaurant")),
    ("bar", "bar, pub or brewpub", "bar, pub ou brasserie artisanale", "amenity=bar/pub, craft=brewery", kind("bar", "pub", "brewery")),
    ("fast-food", "fast-food spot or casse-croûte", "comptoir de restauration rapide ou casse-croûte", "amenity=fast_food", kind("fast_food")),
]
AREA_MAX = 300  # an area question with more distinct answers than this is too open-ended to be fun; skipped


def _answers(places: list[Place]) -> list[Answer]:
    by: dict[str, list[Place]] = defaultdict(list)
    for p in places:
        by[normalize_answer(REST_PREFIX.sub("", p.name)) or normalize_answer(p.name)].append(p)
    out = []
    for group in by.values():
        # Prefer the shortest spelling as the label ("Amir" over "Restaurant Amir"); others become aliases.
        p0 = min(group, key=lambda p: (len(p.name), -len(p.tags)))
        aliases = [p.name for p in group if normalize_answer(p.name) != normalize_answer(p0.name)]
        aliases = list(dict.fromkeys(aliases))
        stripped = REST_PREFIX.sub("", p0.name)
        if stripped != p0.name and len(normalize_answer(stripped)) >= 4:
            aliases.append(stripped)
        for p in group:
            for t in ("name:fr", "name:en", "brand", "official_name", "alt_name", "short_name"):
                v = (p.tags.get(t) or "").strip()
                if v and normalize_answer(v) != normalize_answer(p0.name) and v not in aliases and len(normalize_answer(v)) >= 3:
                    aliases.append(v)
        refs = sorted({f"mtl-food:{p.reg_id}" for p in group})[:5] + sorted({f"osm:{p.osm_id}" for p in group})[:3]
        wd = next((p.tags.get("brand:wikidata") or p.tags.get("wikidata") for p in group if p.tags.get("brand:wikidata") or p.tags.get("wikidata")), None)
        if wd:
            refs.insert(0, f"wikidata:{wd}")
        locations = len({p.reg_id for p in group})
        # Familiarity: open locations on the island (chains are better known) + a bonus for a Wikidata-linked brand.
        out.append(Answer(en=p0.name, aliases=aliases, refs=refs, signal=math.log1p(locations) + (1.0 if wd else 0.0)))
    return out


def _candidate(key: str, en: str, fr: str, osm_def: str, answers: list[Answer], srcs: list[dict], where_en: str, where_fr: str, scope: str) -> Candidate:
    return Candidate(
        id=make_id("food", key),
        template="food-open-place",
        concept=f"food:{key}",
        category="food",
        scope=scope,
        prompt={"en": f"Name a {en} that is open {where_en}.", "fr": f"Nommez un(e) {fr} ouvert(e) {where_fr}."},
        eligibility={
            "en": f"Places tagged {osm_def} in OpenStreetMap {where_en} that match, by name and location (≤ {int(MATCH_M)} m), an establishment listed as open in the City of Montréal's food-establishment registry. Chains count once.",
            "fr": f"Lieux étiquetés {osm_def} dans OpenStreetMap {where_fr} qui correspondent, par le nom et l'emplacement (≤ {int(MATCH_M)} m), à un établissement inscrit comme ouvert au registre des établissements alimentaires de la Ville de Montréal. Une chaîne compte une seule fois.",
        },
        sources=srcs,
        answers=answers,
        est_basis="open-locations+wikidata-brand",
    )


def food_templates(ctx: Context) -> list[Candidate]:
    places, srcs = open_places(ctx)
    out: list[Candidate] = []
    for key, en, fr, osm_def, pred in ISLAND_SPECS:
        answers = _answers([p for p in places if pred(p.tags)])
        if key in CHAIN_MIN:
            answers = [a for a in answers if sum(r.startswith("mtl-food:") for r in a.refs) >= CHAIN_MIN[key]]
        if MIN <= len(answers) <= MAX:
            out.append(_candidate(key, en, fr, osm_def, answers, srcs, "on Montréal Island", "sur l'île de Montréal", "island"))
    areas = {a.name: a for a in ctx.areas}
    for key, en, fr, osm_def, pred in AREA_SPECS:
        by_area: dict[str, list[Place]] = defaultdict(list)
        for p in places:
            if pred(p.tags):
                by_area[p.area].append(p)
        for area, ps in sorted(by_area.items()):
            a = areas[area]
            answers = _answers(ps)
            if MIN <= len(answers) <= AREA_MAX:
                scope = "city" if a.kind == "borough" else "island"
                out.append(_candidate(f"{key}-in-{area}", en, fr, osm_def, answers, srcs, prep_en(a), prep_fr(a), scope))
    return out
