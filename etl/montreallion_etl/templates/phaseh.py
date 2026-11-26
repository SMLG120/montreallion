"""Phase H: question-bank rebalancing (boroughs, sports, history, transit), from factual relationships only.

Two families:
  * Wikidata relationships (CC0): team membership (P54), Hall of Fame inductions (P166), offices held (P39),
    birthplace + occupation (P19 + P106), burial place (P119), place of publication (P291), founding place (P740),
    twinned cities (P190). The eligible set is exactly the query's result; each answer keeps its QID, EN/FR labels,
    name variants (alt labels that share a word with the label) and a sitelink familiarity signal. The query itself
    is the cited source (its URL re-runs it).
  * City of Montréal open data (CC BY 4.0): borough adjacency computed from the official administrative-limits
    polygons, the boroughs each métro line serves (GTFS stations located in those polygons), streets per borough
    (Géobase road network) and electoral districts per borough (2025 districts).

Every question carries an editorial difficulty (easy / medium / hard) chosen for the knowledge it asks for, not
for its answers' rarity scores.
"""

from __future__ import annotations

import csv
import math
import re
import sys
import urllib.parse
from collections import defaultdict
from dataclasses import dataclass

from ..http import fetch_json
from ..model import Answer, Candidate, make_id
from ..normalize import normalize_answer
from ..sources import ckan, wikidata
from . import Context, area_phrase, area_scope, de

# Answer sets from relationships can be large (e.g. every Canadiens player); the pipeline allows these templates more.
LARGE_SET_TEMPLATES = {"wikidata-relation": 1000, "street-in-borough": 700}

# ---------------------------------------------------------------- Wikidata relationships
MTL = "wd:Q340"  # Montréal (city)


@dataclass
class WD:
    key: str
    category: str
    scope: str
    difficulty: str
    prompt: tuple[str, str]
    eligibility: tuple[str, str]  # "{n}" is replaced by the answer count
    body: str  # SPARQL triple patterns binding ?p
    human: bool = True


def born(occ: str) -> str:
    return f"?p wdt:P19 {MTL} ; wdt:P106 wd:{occ} ; wdt:P31 wd:Q5 ."


def member(team: str) -> str:
    return f"?p wdt:P54 wd:{team} ; wdt:P31 wd:Q5 ."


WD_SPECS: list[WD] = [
    # ------------------------------------------------ sports
    WD("habs-player", "sports", "island", "easy",
       ("Name a player who has played for the Montréal Canadiens.", "Nommez un joueur ayant joué pour le Canadien de Montréal."),
       ("People recorded in Wikidata as members (P54) of the Montréal Canadiens ({n} people).",
        "Personnes inscrites dans Wikidata comme membres (P54) du Canadien de Montréal ({n} personnes)."),
       member("Q188143")),
    WD("habs-hhof", "sports", "island", "medium",
       ("Name a Hockey Hall of Fame inductee who played for the Montréal Canadiens.", "Nommez un membre du Temple de la renommée du hockey ayant joué pour le Canadien de Montréal."),
       ("People recorded in Wikidata as members of the Montréal Canadiens (P54) who received the Hockey Hall of Fame induction (P166) ({n} people).",
        "Personnes inscrites dans Wikidata comme membres du Canadien (P54) et intronisées au Temple de la renommée du hockey (P166) ({n} personnes)."),
       "?p wdt:P54 wd:Q188143 ; wdt:P166 wd:Q1136687 ; wdt:P31 wd:Q5 ."),
    WD("expos-player", "sports", "island", "medium",
       ("Name a player who played for the Montréal Expos (1969–2004).", "Nommez un joueur ayant joué pour les Expos de Montréal (1969–2004)."),
       ("People recorded in Wikidata as members (P54) of the Montréal Expos ({n} people).",
        "Personnes inscrites dans Wikidata comme membres (P54) des Expos de Montréal ({n} personnes)."),
       member("Q1148233")),
    WD("alouettes-player", "sports", "island", "medium",
       ("Name a player who has played for the Montréal Alouettes (CFL).", "Nommez un joueur ayant joué pour les Alouettes de Montréal (LCF)."),
       ("People recorded in Wikidata as members (P54) of the Montréal Alouettes ({n} people).",
        "Personnes inscrites dans Wikidata comme membres (P54) des Alouettes de Montréal ({n} personnes)."),
       member("Q576837")),
    WD("alouettes-cfhof", "sports", "island", "hard",
       ("Name a Canadian Football Hall of Fame inductee who played for the Montréal Alouettes.", "Nommez un membre du Temple de la renommée du football canadien ayant joué pour les Alouettes de Montréal."),
       ("People recorded in Wikidata as members of the Montréal Alouettes (P54) inducted into the Canadian Football Hall of Fame (P166) ({n} people).",
        "Personnes inscrites dans Wikidata comme membres des Alouettes (P54) et intronisées au Temple de la renommée du football canadien (P166) ({n} personnes)."),
       "?p wdt:P54 wd:Q576837 ; wdt:P166 wd:Q3517653 ; wdt:P31 wd:Q5 ."),
    WD("cfmtl-player", "sports", "island", "medium",
       ("Name a player who has played for CF Montréal (the Montreal Impact in MLS until 2020).", "Nommez un joueur ayant joué pour le CF Montréal (l'Impact de Montréal en MLS jusqu'en 2020)."),
       ("People recorded in Wikidata as members (P54) of the MLS club CF Montréal, founded 2010 ({n} people).",
        "Personnes inscrites dans Wikidata comme membres (P54) du club de la MLS CF Montréal, fondé en 2010 ({n} personnes)."),
       member("Q167615")),
    WD("maroons-player", "sports", "island", "hard",
       ("Name a player who played for the Montréal Maroons (NHL, 1924–1938).", "Nommez un joueur ayant joué pour les Maroons de Montréal (LNH, 1924–1938)."),
       ("People recorded in Wikidata as members (P54) of the Montréal Maroons ({n} people).",
        "Personnes inscrites dans Wikidata comme membres (P54) des Maroons de Montréal ({n} personnes)."),
       member("Q546280")),
    WD("wanderers-player", "sports", "island", "hard",
       ("Name a player who played for the Montréal Wanderers hockey club.", "Nommez un joueur ayant joué pour le club de hockey des Wanderers de Montréal."),
       ("People recorded in Wikidata as members (P54) of the Montréal Wanderers (1903–1918) ({n} people).",
        "Personnes inscrites dans Wikidata comme membres (P54) des Wanderers de Montréal (1903–1918) ({n} personnes)."),
       member("Q459647")),
    WD("royals-baseball-player", "sports", "island", "hard",
       ("Name a player who played for the Montréal Royals baseball club.", "Nommez un joueur ayant joué pour le club de baseball des Royaux de Montréal."),
       ("People recorded in Wikidata as members (P54) of the Montréal Royals minor-league baseball club ({n} people).",
        "Personnes inscrites dans Wikidata comme membres (P54) des Royaux de Montréal, club de baseball des ligues mineures ({n} personnes)."),
       member("Q3446304")),
    WD("manic-player", "sports", "island", "hard",
       ("Name a player who played for the Montréal Manic (NASL soccer, 1981–1983).", "Nommez un joueur ayant joué pour le Manic de Montréal (soccer, NASL, 1981–1983)."),
       ("People recorded in Wikidata as members (P54) of the Montréal Manic ({n} people).",
        "Personnes inscrites dans Wikidata comme membres (P54) du Manic de Montréal ({n} personnes)."),
       member("Q1133645")),
    WD("born-hockey", "sports", "city", "medium",
       ("Name an ice hockey player born in Montréal.", "Nommez un joueur de hockey sur glace né à Montréal."),
       ("People recorded in Wikidata as born in Montréal (P19) with the occupation ice hockey player (P106) ({n} people).",
        "Personnes inscrites dans Wikidata comme nées à Montréal (P19) et ayant pour occupation joueur de hockey sur glace (P106) ({n} personnes)."),
       born("Q11774891")),
    WD("born-hhof", "sports", "city", "hard",
       ("Name a Hockey Hall of Fame inductee born in Montréal.", "Nommez un membre du Temple de la renommée du hockey né à Montréal."),
       ("People recorded in Wikidata as born in Montréal (P19) and inducted into the Hockey Hall of Fame (P166) ({n} people).",
        "Personnes inscrites dans Wikidata comme nées à Montréal (P19) et intronisées au Temple de la renommée du hockey (P166) ({n} personnes)."),
       f"?p wdt:P19 {MTL} ; wdt:P166 wd:Q1136687 ; wdt:P31 wd:Q5 ."),
    WD("born-soccer", "sports", "city", "hard",
       ("Name a soccer player born in Montréal.", "Nommez un joueur ou une joueuse de soccer né(e) à Montréal."),
       ("People recorded in Wikidata as born in Montréal (P19) with the occupation association football player (P106) ({n} people).",
        "Personnes inscrites dans Wikidata comme nées à Montréal (P19) et ayant pour occupation joueur de soccer (P106) ({n} personnes)."),
       born("Q937857")),
    WD("born-figure-skater", "sports", "city", "hard",
       ("Name a figure skater born in Montréal.", "Nommez un patineur ou une patineuse artistique né(e) à Montréal."),
       ("People recorded in Wikidata as born in Montréal (P19) with the occupation figure skater (P106) ({n} people).",
        "Personnes inscrites dans Wikidata comme nées à Montréal (P19) et ayant pour occupation patineur artistique (P106) ({n} personnes)."),
       born("Q13219587")),
    WD("born-tennis", "sports", "city", "hard",
       ("Name a tennis player born in Montréal.", "Nommez un joueur ou une joueuse de tennis né(e) à Montréal."),
       ("People recorded in Wikidata as born in Montréal (P19) with the occupation tennis player (P106) ({n} people).",
        "Personnes inscrites dans Wikidata comme nées à Montréal (P19) et ayant pour occupation joueur de tennis (P106) ({n} personnes)."),
       born("Q10833314")),
    WD("born-boxer", "sports", "city", "hard",
       ("Name a boxer born in Montréal.", "Nommez un boxeur ou une boxeuse né(e) à Montréal."),
       ("People recorded in Wikidata as born in Montréal (P19) with the occupation boxer (P106) ({n} people).",
        "Personnes inscrites dans Wikidata comme nées à Montréal (P19) et ayant pour occupation boxeur (P106) ({n} personnes)."),
       born("Q11338576")),
    WD("born-swimmer", "sports", "city", "hard",
       ("Name a swimmer born in Montréal.", "Nommez un nageur ou une nageuse né(e) à Montréal."),
       ("People recorded in Wikidata as born in Montréal (P19) with the occupation swimmer (P106) ({n} people).",
        "Personnes inscrites dans Wikidata comme nées à Montréal (P19) et ayant pour occupation nageur (P106) ({n} personnes)."),
       born("Q10843402")),
    WD("teams-based", "sports", "city", "medium",
       ("Name a sports team based in Montréal (past or present).", "Nommez une équipe sportive basée à Montréal (passée ou actuelle)."),
       ("Items recorded in Wikidata as sports teams (P31) headquartered or located in Montréal (P159/P131) ({n} teams).",
        "Éléments inscrits dans Wikidata comme équipes sportives (P31) dont le siège ou l'emplacement est Montréal (P159/P131) ({n} équipes)."),
       f"?p wdt:P31/wdt:P279* wd:Q12973014 ; wdt:P159|wdt:P131 {MTL} .", human=False),
    # ------------------------------------------------ history & people
    WD("mayor-all", "history", "city", "medium",
       ("Name a person who has been mayor of Montréal (any era).", "Nommez une personne ayant été maire de Montréal (toutes époques)."),
       ("People recorded in Wikidata as having held the position Mayor of Montréal (P39) ({n} people).",
        "Personnes inscrites dans Wikidata comme ayant occupé le poste de maire de Montréal (P39) ({n} personnes)."),
       "?p wdt:P39 wd:Q177645 ; wdt:P31 wd:Q5 ."),
    WD("born-writer", "history", "city", "medium",
       ("Name a writer born in Montréal.", "Nommez un écrivain ou une écrivaine né(e) à Montréal."),
       ("People recorded in Wikidata as born in Montréal (P19) with the occupation writer (P106) ({n} people).",
        "Personnes inscrites dans Wikidata comme nées à Montréal (P19) et ayant pour occupation écrivain (P106) ({n} personnes)."),
       born("Q36180")),
    WD("born-singer", "history", "city", "easy",
       ("Name a singer born in Montréal.", "Nommez un chanteur ou une chanteuse né(e) à Montréal."),
       ("People recorded in Wikidata as born in Montréal (P19) with the occupation singer (P106) ({n} people).",
        "Personnes inscrites dans Wikidata comme nées à Montréal (P19) et ayant pour occupation chanteur (P106) ({n} personnes)."),
       born("Q177220")),
    WD("born-actor", "history", "city", "easy",
       ("Name an actor or actress born in Montréal.", "Nommez un acteur ou une actrice né(e) à Montréal."),
       ("People recorded in Wikidata as born in Montréal (P19) with the occupation actor (P106) ({n} people).",
        "Personnes inscrites dans Wikidata comme nées à Montréal (P19) et ayant pour occupation acteur (P106) ({n} personnes)."),
       born("Q33999")),
    WD("born-painter", "history", "city", "hard",
       ("Name a painter born in Montréal.", "Nommez un peintre né(e) à Montréal."),
       ("People recorded in Wikidata as born in Montréal (P19) with the occupation painter (P106) ({n} people).",
        "Personnes inscrites dans Wikidata comme nées à Montréal (P19) et ayant pour occupation peintre (P106) ({n} personnes)."),
       born("Q1028181")),
    WD("born-film-director", "history", "city", "medium",
       ("Name a film director born in Montréal.", "Nommez un cinéaste né(e) à Montréal."),
       ("People recorded in Wikidata as born in Montréal (P19) with the occupation film director (P106) ({n} people).",
        "Personnes inscrites dans Wikidata comme nées à Montréal (P19) et ayant pour occupation réalisateur de cinéma (P106) ({n} personnes)."),
       born("Q2526255")),
    WD("born-architect", "history", "city", "hard",
       ("Name an architect born in Montréal.", "Nommez un ou une architecte né(e) à Montréal."),
       ("People recorded in Wikidata as born in Montréal (P19) with the occupation architect (P106) ({n} people).",
        "Personnes inscrites dans Wikidata comme nées à Montréal (P19) et ayant pour occupation architecte (P106) ({n} personnes)."),
       born("Q42973")),
    WD("born-politician", "history", "city", "medium",
       ("Name a politician born in Montréal.", "Nommez une personnalité politique née à Montréal."),
       ("People recorded in Wikidata as born in Montréal (P19) with the occupation politician (P106) ({n} people).",
        "Personnes inscrites dans Wikidata comme nées à Montréal (P19) et ayant pour occupation homme ou femme politique (P106) ({n} personnes)."),
       born("Q82955")),
    WD("born-comedian", "history", "city", "medium",
       ("Name a comedian born in Montréal.", "Nommez un ou une humoriste né(e) à Montréal."),
       ("People recorded in Wikidata as born in Montréal (P19) with the occupation comedian (P106) ({n} people).",
        "Personnes inscrites dans Wikidata comme nées à Montréal (P19) et ayant pour occupation humoriste (P106) ({n} personnes)."),
       born("Q245068")),
    WD("buried-nddn", "history", "city", "hard",
       ("Name a notable person buried in Notre-Dame-des-Neiges Cemetery.", "Nommez une personnalité inhumée au cimetière Notre-Dame-des-Neiges."),
       ("People recorded in Wikidata with Notre-Dame-des-Neiges Cemetery as place of burial (P119) ({n} people).",
        "Personnes inscrites dans Wikidata avec le cimetière Notre-Dame-des-Neiges comme lieu de sépulture (P119) ({n} personnes)."),
       "?p wdt:P119 wd:Q507432 ; wdt:P31 wd:Q5 ."),
    WD("buried-mount-royal", "history", "city", "hard",
       ("Name a notable person buried in Mount Royal Cemetery.", "Nommez une personnalité inhumée au cimetière Mont-Royal."),
       ("People recorded in Wikidata with Mount Royal Cemetery as place of burial (P119) ({n} people).",
        "Personnes inscrites dans Wikidata avec le cimetière Mont-Royal comme lieu de sépulture (P119) ({n} personnes)."),
       "?p wdt:P119 wd:Q1457377 ; wdt:P31 wd:Q5 ."),
    WD("newspaper", "history", "city", "medium",
       ("Name a newspaper published in Montréal (past or present).", "Nommez un journal publié à Montréal (passé ou actuel)."),
       ("Items recorded in Wikidata as newspapers (P31) with Montréal as place of publication (P291) ({n} newspapers).",
        "Éléments inscrits dans Wikidata comme journaux (P31) publiés à Montréal (P291) ({n} journaux)."),
       f"?p wdt:P31/wdt:P279* wd:Q11032 ; wdt:P291 {MTL} .", human=False),
    WD("company-founded", "history", "city", "medium",
       ("Name a company founded in Montréal.", "Nommez une entreprise fondée à Montréal."),
       ("Items recorded in Wikidata as businesses (P31) with Montréal as location of formation (P740) ({n} companies).",
        "Éléments inscrits dans Wikidata comme entreprises (P31) dont le lieu de fondation est Montréal (P740) ({n} entreprises)."),
       f"?p wdt:P740 {MTL} ; wdt:P31/wdt:P279* wd:Q4830453 .", human=False),
    WD("twin-city", "history", "city", "hard",
       ("Name a city twinned with Montréal (a sister city).", "Nommez une ville jumelée avec Montréal."),
       ("Cities recorded in Wikidata as twinned administrative bodies of Montréal (P190) ({n} cities).",
        "Villes inscrites dans Wikidata comme jumelées avec Montréal (P190) ({n} villes)."),
       f"{MTL} wdt:P190 ?p .", human=False),
]

ALT_MAX = 6
TOKEN = re.compile(r"[a-zà-ÿ]{3,}", re.I)


def _query(spec: WD) -> str:
    return f"""SELECT ?p ?sl ?fr ?en (GROUP_CONCAT(DISTINCT ?alt; separator="|") AS ?alts) WHERE {{
  {spec.body}
  ?p wikibase:sitelinks ?sl .
  OPTIONAL {{ ?p rdfs:label ?fr FILTER(LANG(?fr) = "fr") }}
  OPTIONAL {{ ?p rdfs:label ?en FILTER(LANG(?en) = "en") }}
  OPTIONAL {{ ?p skos:altLabel ?alt FILTER(LANG(?alt) = "en" || LANG(?alt) = "fr") }}
}} GROUP BY ?p ?sl ?fr ?en"""


def _variants(label: str, alts: list[str]) -> list[str]:
    """Alt labels kept as name variants only if they share a word with the label (no unrelated nicknames or codes)."""
    words = {normalize_answer(w) for w in TOKEN.findall(label)}
    out = []
    for a in alts:
        a = a.strip()
        if not a or len(a) > 60 or re.search(r"\d|[@/:]", a) or len(a.split()) > 6:
            continue
        if words & {normalize_answer(w) for w in TOKEN.findall(a)} and normalize_answer(a) != normalize_answer(label):
            out.append(a)
    return out[:ALT_MAX]


def wikidata_relation_templates(ctx: Context) -> list[Candidate]:
    out = []
    for spec in WD_SPECS:
        q = _query(spec)
        data, f = fetch_json(f"wd-rel-{spec.key}", wikidata.ENDPOINT, post={"query": q, "format": "json"}, timeout=180)
        answers = []
        for b in data["results"]["bindings"]:  # type: ignore[index]
            qid = b["p"]["value"].rsplit("/", 1)[-1]
            en = b.get("en", {}).get("value")
            fr = b.get("fr", {}).get("value")
            label = en or fr
            if not label or re.fullmatch(r"Q\d+", label):
                continue
            alts = [x for x in (b.get("alts", {}).get("value") or "").split("|") if x]
            a = Answer(en=label, fr=fr if fr and normalize_answer(fr) != normalize_answer(label) else None,
                       aliases=_variants(label, alts), refs=[f"wikidata:{qid}"], signal=math.log1p(int(b["sl"]["value"])))
            answers.append(a)
        # Two different entities can share a French label (namesakes): keep it only where it names one entity.
        fr_owner: dict[str, set[str]] = defaultdict(set)
        for a in answers:
            for form in (a.en, a.fr or ""):
                if form:
                    fr_owner[normalize_answer(form)].add(a.refs[0])
        for a in answers:
            if a.fr and len(fr_owner[normalize_answer(a.fr)]) > 1:
                a.fr = None
        n = len({normalize_answer(a.en) for a in answers})
        src = {
            "title": f"Wikidata query: {spec.eligibility[0].split(' (')[0]}",
            "url": "https://query.wikidata.org/#" + urllib.parse.quote(q),
            "license": "CC0 1.0",
            "retrieved": f.retrieved,
        }
        out.append(
            Candidate(
                id=make_id("wd", spec.key),
                template="wikidata-relation",
                concept=f"wd:{spec.key}",
                category=spec.category,
                scope=spec.scope,
                prompt={"en": spec.prompt[0], "fr": spec.prompt[1]},
                eligibility={"en": spec.eligibility[0].format(n=n), "fr": spec.eligibility[1].format(n=n)},
                sources=[src],
                answers=answers,
                est_basis="wikidata-sitelinks",
                difficulty=spec.difficulty,
                answer_type="person" if spec.human else None,
            )
        )
    return out


# ---------------------------------------------------------------- boroughs: geometry
def _planar(lon: float, lat: float) -> tuple[float, float]:
    return lon * 111_320 * math.cos(math.radians(45.5)), lat * 110_540


def _rings(geom: dict) -> list[list]:
    polys = geom["coordinates"] if geom["type"] == "MultiPolygon" else [geom["coordinates"]]
    return [ring for poly in polys for ring in poly]


def _seg_dist(p, a, b) -> float:
    (px, py), (ax, ay), (bx, by) = p, a, b
    dx, dy = bx - ax, by - ay
    t = 0.0 if dx == dy == 0 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


ADJ_TOL_M = 25  # boundary vertices this close to a neighbour's boundary count as shared
ADJ_MIN_M = 200  # ... and the shared stretch must be at least this long (corners don't count)


def adjacency(ctx: Context) -> dict[str, set[str]]:
    """Areas whose official boundaries run together for at least ADJ_MIN_M metres."""
    cell = 100.0
    shapes = {a.name: [[_planar(*pt[:2]) for pt in r] for r in _rings(a.geom)] for a in ctx.areas}
    grids: dict[str, dict] = {}
    boxes = {}
    for name, rings in shapes.items():
        g = defaultdict(list)
        xs, ys = [], []
        for r in rings:
            for i in range(len(r) - 1):
                a, b = r[i], r[i + 1]
                xs += [a[0], b[0]]
                ys += [a[1], b[1]]
                for cx in range(int(min(a[0], b[0]) // cell) - 1, int(max(a[0], b[0]) // cell) + 2):
                    for cy in range(int(min(a[1], b[1]) // cell) - 1, int(max(a[1], b[1]) // cell) + 2):
                        g[(cx, cy)].append((a, b))
        grids[name] = g
        boxes[name] = (min(xs), min(ys), max(xs), max(ys))
    adj: dict[str, set[str]] = defaultdict(set)
    names = list(shapes)
    for i, an in enumerate(names):
        for bn in names[i + 1:]:
            (ax0, ay0, ax1, ay1), (bx0, by0, bx1, by1) = boxes[an], boxes[bn]
            if ax0 > bx1 + 50 or bx0 > ax1 + 50 or ay0 > by1 + 50 or by0 > ay1 + 50:
                continue
            shared = 0.0
            for r in shapes[an]:
                for k in range(len(r) - 1):
                    p, q = r[k], r[k + 1]
                    segs = grids[bn].get((int(p[0] // cell), int(p[1] // cell)), [])
                    if segs and min(_seg_dist(p, s[0], s[1]) for s in segs) <= ADJ_TOL_M:
                        segs2 = grids[bn].get((int(q[0] // cell), int(q[1] // cell)), [])
                        if segs2 and min(_seg_dist(q, s[0], s[1]) for s in segs2) <= ADJ_TOL_M:
                            shared += math.hypot(q[0] - p[0], q[1] - p[1])
            if shared >= ADJ_MIN_M:
                adj[an].add(bn)
                adj[bn].add(an)
    return adj


def _area_answer(ctx: Context, name: str) -> Answer:
    from . import place_signal

    sig, refs, en = place_signal(ctx, name)
    return Answer(en=name, refs=refs, signal=math.log1p(sig))


def borough_templates(ctx: Context) -> list[Candidate]:
    out: list[Candidate] = []
    src_lim = ctx.src["limites"]
    kinds = {a.name: a for a in ctx.areas}
    # 1. Neighbours (shared official boundary).
    adj = adjacency(ctx)
    for name in sorted(adj):
        area = kinds[name]
        near = sorted(adj[name])
        if len(near) < 3:  # e.g. Verdun, Senneville: too few neighbours for a fair question
            continue
        en_ph, fr_ph = area_phrase(area)
        out.append(
            Candidate(
                id=make_id("borders", name),
                template="area-adjacency",
                concept=f"borders:{name}",
                category="boroughs",
                scope="island",
                prompt={"en": f"Name a borough or island municipality that shares a border with {en_ph}.",
                        "fr": f"Nommez un arrondissement ou une ville de l'île qui a une frontière commune avec {fr_ph if area.kind == 'borough' else name}."},
                eligibility={"en": f"Boroughs and municipalities of the agglomeration whose official boundary runs alongside {name}'s for at least {ADJ_MIN_M} m in the City's administrative-limits dataset ({len(near)}).",
                             "fr": f"Arrondissements et villes de l'agglomération dont la limite officielle longe celle {de(name)} sur au moins {ADJ_MIN_M} m dans le jeu de données des limites administratives ({len(near)})."},
                sources=[src_lim],
                answers=[_area_answer(ctx, n) for n in near],
                est_basis="wikidata-sitelinks",
                difficulty="medium" if area.kind == "borough" else "hard",
            )
        )
    # 2. Boroughs/municipalities each métro line serves.
    from . import LINE_PROMPTS

    for line, (en, fr) in LINE_PROMPTS.items():
        served = sorted({a for s in ctx.metro.stations.values() if line in s.lines and (a := ctx.area_index.locate(s.lon, s.lat))})
        if len(served) < 3:
            continue
        out.append(
            Candidate(
                id=make_id("line-areas", en),
                template="metro-line-areas",
                concept=f"metro-line-areas:{line}",
                category="boroughs",
                scope="island",
                prompt={"en": f"Name a borough or island municipality with a station on the STM {en} Line.",
                        "fr": f"Nommez un arrondissement ou une ville de l'île où se trouve une station de la ligne {fr} du métro."},
                eligibility={"en": f"Boroughs and municipalities whose official limits contain at least one Line {line} station (STM GTFS stop positions) ({len(served)}).",
                             "fr": f"Arrondissements et villes dont les limites officielles contiennent au moins une station de la ligne {line} (positions GTFS de la STM) ({len(served)})."},
                sources=[ctx.src["gtfs"], src_lim],
                answers=[_area_answer(ctx, n) for n in served],
                est_basis="wikidata-sitelinks",
                difficulty="medium",
            )
        )
    out += _street_templates(ctx)
    out += _district_templates(ctx)
    return out


# ---------------------------------------------------------------- boroughs: streets (Géobase)
NOT_A_STREET = re.compile(r"^(bretelle|acc[eè]s|sortie|entr[ée]e|voie de service|stationnement|passage|piste|sentier|ruelle|tunnel|pont|viaduc|autoroute)\b", re.I)


def _area_key(name: str) -> str:
    return normalize_answer(name.replace("–", "-").replace("—", "-"))


def _street_templates(ctx: Context) -> list[Candidate]:
    f, src = ckan.resource("geobase", fmt="csv")
    csv.field_size_limit(sys.maxsize)
    rows = ckan.read_csv(f)
    boroughs = {_area_key(a.name): a for a in ctx.areas if a.kind == "borough"}
    streets: dict[str, dict[str, Answer]] = defaultdict(dict)
    for r in rows:
        odo = (r.get("ODONYME") or "").strip()
        name = (r.get("NOM_VOIE") or "").strip()
        if not odo or not name or NOT_A_STREET.match(odo):
            continue
        for side in ("ARR_GCH", "ARR_DRT"):
            area = boroughs.get(_area_key(r.get(side) or ""))
            if not area:
                continue
            k = normalize_answer(odo)
            a = streets[area.name].get(k)
            if a is None:
                a = streets[area.name][k] = Answer(en=odo, aliases=[name] if normalize_answer(name) != k else [], refs=[], signal=0.0)
            a.signal += 1  # segments (≈ length): longer streets are better known
    out = []
    for area_name, answers in sorted(streets.items()):
        area = next(a for a in ctx.areas if a.name == area_name)
        for a in answers.values():
            a.signal = math.log1p(a.signal)
        out.append(
            Candidate(
                id=make_id("street-in", area_name),
                template="street-in-borough",
                concept=f"street-in:{area_name}",
                category="boroughs",
                scope=area_scope(area),
                prompt={"en": f"Name a street in the borough of {area_name}.", "fr": f"Nommez une rue de l'arrondissement {de(area_name)}."},
                eligibility={"en": f"Named streets with at least one segment in {area_name} in the City's Géobase road network (ramps, accesses and lanes excluded) ({len(answers)}).",
                             "fr": f"Voies nommées ayant au moins un tronçon dans l'arrondissement {de(area_name)} selon la Géobase de la Ville (bretelles, accès et ruelles exclus) ({len(answers)})."},
                sources=[src],
                answers=list(answers.values()),
                est_basis="geobase-segment-count",
                difficulty="medium",
            )
        )
    return out


# ---------------------------------------------------------------- boroughs: electoral districts
def _district_templates(ctx: Context) -> list[Candidate]:
    f, src = ckan.resource("districts-electoraux", fmt="csv", name_contains="2025")
    csv.field_size_limit(sys.maxsize)
    by: dict[str, list[str]] = defaultdict(list)
    for r in ckan.read_csv(f):
        by[r["NOM_ARR"].strip()].append(r["NOM_DISTRICT"].strip())
    known = {a.name: a for a in ctx.areas}
    out = []
    for borough, names in sorted(by.items()):
        if len(names) < 3 or borough not in known:
            continue
        out.append(
            Candidate(
                id=make_id("district-in", borough),
                template="district-in-borough",
                concept=f"district-in:{borough}",
                category="boroughs",
                scope="city",
                prompt={"en": f"Name a municipal electoral district of the borough of {borough}.", "fr": f"Nommez un district électoral municipal de l'arrondissement {de(borough)}."},
                eligibility={"en": f"The 2025 municipal electoral districts of {borough} ({len(names)}).", "fr": f"Les districts électoraux municipaux de 2025 de l'arrondissement {de(borough)} ({len(names)})."},
                sources=[src],
                answers=[_area_answer(ctx, n) for n in names],
                est_basis="wikidata-sitelinks",
                difficulty="hard",
            )
        )
    return out


PHASE_H = [wikidata_relation_templates, borough_templates]
