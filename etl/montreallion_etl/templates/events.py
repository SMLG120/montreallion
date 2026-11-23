"""Expansion phase C (festivals & events): winners, line-ups and venues from revision-pinned Wikipedia articles.

Facts only (names in tables/lists). Each answer is linked to Wikidata through its article when it has one
(QID, EN/FR labels, sitelinks as the familiarity signal). Prompts state the edition range the source covers.
"""

from __future__ import annotations

import math
import re
from collections import defaultdict
from dataclasses import dataclass, field

from ..model import Answer, Candidate, make_id
from ..normalize import normalize_answer
from ..sources import wikidata, wikipedia
from . import Context, place_signal
from .expansion import _same_thing
from .wikilists import _cat, _clean, bullets, compact, sections

MIN = 5


@dataclass
class Ref:
    label: str
    title: str | None
    lang: str
    trust_label: bool = False  # the article IS the answer (e.g. a country), so its WD labels may be used as translations


@dataclass
class Event:
    key: str
    category: str
    scope: str
    prompt: tuple[str, str]
    eligibility: tuple[str, str]
    refs: list[Ref]
    sources: list[dict]
    aliases: dict[str, list[str]] = field(default_factory=dict)


LIEN = re.compile(r"\{\{(?:Lien|Link)\|([^{}]*)\}\}", re.I)


def _lien(m: re.Match) -> str:
    """{{Lien|langue=de|trad=Heidi Genee|fr=Heidi Genée}} → 'Heidi Genée' (fr= wins, then the first unnamed or trad= value)."""
    parts = m.group(1).split("|")
    named = {k.strip(): v.strip() for k, sep, v in (x.partition("=") for x in parts) if sep}
    unnamed = [p.strip() for p in parts if "=" not in p]
    return named.get("fr") or (unnamed[0] if unnamed else named.get("trad", ""))


def _link_or_text(cell: str, lang: str, trust: bool = False) -> list[Ref]:
    cell = LIEN.sub(_lien, cell).replace("'''", "")
    links = [t for t in wikipedia.link_targets(cell) if not re.match(r"^\d{3,4}$", t)]
    if links:
        labels = re.findall(r"\[\[(?:[^|\]]*\|)?([^\]]+)\]\]", wikipedia.FILE.sub("", wikipedia.REF.sub("", cell)))
        return [Ref(_clean(lab), t, lang, trust) for t, lab in zip(links, labels)]
    text = _clean(wikipedia.plain(cell).strip("*' "))
    return [Ref(text, None, lang)] if text else []


# ---------------------------------------------------------------- extractors
def fireworks(cols: tuple[int, ...]) -> tuple[list[Ref], list[dict]]:
    txt, src = wikipedia.page("Montreal International Fireworks Competition", "en")
    refs = []
    for r in wikipedia.tables(txt)[0][1:]:
        if r and re.match(r"^\d{4}", wikipedia.plain(r[0])):
            for c in cols:
                if c < len(r):
                    refs += [x for x in _link_or_text(r[c], "en", True) if x.title]
    return refs, [src]


def francouvertes(cols: tuple[int, ...]) -> tuple[list[Ref], list[dict]]:
    txt, src = wikipedia.page("Francouvertes", "fr")
    refs = []
    for r in wikipedia.tables(txt)[0][1:]:
        if len(r) >= 5 and wikipedia.plain(r[0]).isdigit():
            for c in cols:
                refs += _link_or_text(r[c], "fr")
    return refs, [src]


def ffm_grand_prix(part: str) -> tuple[list[Ref], list[dict]]:
    """'* 1978 : ''[[Ligabue (film)|Ligabue]]'' de [[Salvatore Nocita]] {{Italie}}' (ties as '** …' sub-items)."""
    txt, src = wikipedia.page("Festival des films du monde de Montréal", "fr")
    body = sections(txt)["Grand prix des Amériques"]
    refs = []
    for line in body.split("\n"):
        if not line.startswith("*"):
            continue
        line = re.sub(r"^\*+\s*(\d{4}\s*:)?\s*", "", line)
        if not line.strip():
            continue
        film, _, director = line.partition(" de ")
        if part == "film":
            refs += _link_or_text(film, "fr")[:1]
        else:
            refs += [r for r in _link_or_text(director, "fr") if r.title][:2]
    return refs, [src]


def f1_montreal(col: int) -> tuple[list[Ref], list[dict]]:
    txt, src = wikipedia.page("Grand Prix automobile du Canada", "fr")
    refs = []
    for r in wikipedia.tables(txt)[1][1:]:
        if len(r) >= 4 and re.match(r"^\d{4}$", wikipedia.plain(r[0])) and "Villeneuve" in wikipedia.plain(r[3]):
            refs += _link_or_text(r[col], "fr")[:1]
    return refs, [src]


def gp_cycliste(cols: tuple[int, ...]) -> tuple[list[Ref], list[dict]]:
    """Podiums section: a template-opened table ({{En-tête de tableau Palmarès…}}), rows 'year | 1st | 2nd | 3rd'."""
    txt, src = wikipedia.page("Grand Prix cycliste de Montréal", "fr")
    body = sections(txt)["Podiums"]
    refs = []
    for row in body.split("|-")[1:]:
        cells = [ln[1:].strip() for ln in row.strip().split("\n") if ln.startswith("|") and not ln.startswith("|}")]
        if len(cells) >= 4 and re.search(r"\|\d{4}\]\]", cells[0]):
            for c in cols:
                refs += [x for x in _link_or_text(cells[c], "fr") if x.title][:1]
    return refs, [src]


def marathon() -> tuple[list[Ref], list[dict]]:
    txt, src = wikipedia.page("Marathon de Montréal", "fr")
    refs = []
    for r in wikipedia.tables(txt)[1]:
        if len(r) >= 6 and re.match(r"^\d{4}$", wikipedia.plain(r[0])):
            for c in (1, 4):
                refs += [x for x in _link_or_text(r[c], "fr") if len(x.label) > 4][:1]
    return refs, [src]


def heavy(years: tuple[str, ...]) -> tuple[list[Ref], list[dict]]:
    txt, src = wikipedia.page("Heavy Montréal", "en")
    secs = sections(txt)
    refs = []
    for y in years:
        body = secs.get(y, "")
        for tb in wikipedia.tables(body + ("\n|}" if body.count("{|") > body.count("|}") else "")):
            for row in tb[1:]:
                for cell in row:
                    refs += [x for x in _link_or_text(cell, "en") if x.title]
    return refs, [src]


def ridm(col: int) -> tuple[list[Ref], list[dict]]:
    """Per-edition award tables ('Prix | Film | Réalisatrice/Réalisateur | Pays')."""
    txt, src = wikipedia.page("Rencontres internationales du documentaire de Montréal", "fr")
    refs = []
    for tb in wikipedia.tables(txt):
        if not tb or "Film" not in [wikipedia.plain(c) for c in tb[0]]:
            continue
        for r in tb[1:]:
            if len(r) >= 4:  # rows missing the prize cell (rowspan) are shifted; skipped rather than guessed
                refs += [x for x in _link_or_text(r[col], "fr") if len(normalize_answer(x.label)) > 2][:1]
    return refs, [src]


# Italic links in those sections that are not films shown: an award-winner's name, and a link that resolves to the
# beverage article instead of the 2018 short film.
FANTASIA_NOT_FILMS = {"Andrzej Żuławski", "Milk"}
ITALIC_LINK = re.compile(r"''\[\[([^\]|]+)(?:\|([^\]]+))?\]\]''")


def fantasia(years: tuple[str, ...]) -> tuple[list[Ref], list[dict]]:
    """Films named (italic links) in the per-year sections of the Fantasia article."""
    txt, src = wikipedia.page("Fantasia International Film Festival", "en")
    secs = sections(txt)
    refs = []
    for y in years:
        body = re.sub(r"\{\{cite[^{}]*\}\}", "", wikipedia.REF.sub("", secs.get(y, "")), flags=re.I)  # citations name publications
        for m in ITALIC_LINK.finditer(body):
            if m.group(1) in FANTASIA_NOT_FILMS:
                continue
            refs.append(Ref(_clean(m.group(2) or m.group(1)), m.group(1), "en"))
    return refs, [src]


def olympics_venues() -> tuple[list[Ref], list[dict]]:
    txt, src = wikipedia.page("Venues of the 1976 Summer Olympics", "en")
    refs = []
    for tb in wikipedia.tables(txt)[:2]:  # Olympic Park + Greater Montréal (football/other venues were outside Montréal)
        for r in tb[1:]:
            if r:
                refs += _link_or_text(r[0], "en")[:1]
    return refs, [src]


def expo67(national: bool) -> tuple[list[Ref], list[dict]]:
    txt, src = wikipedia.page("Liste des pavillons d'Expo 67", "fr")
    refs = []
    for r in wikipedia.tables(txt)[0][1:]:
        if len(r) < 2:
            continue
        name, typ = (_clean(wikipedia.plain(re.sub(r"^width=\S+\|", "", c))) for c in r[:2])
        if not name or "réservé" in typ.lower() or "service" in typ.lower():
            continue
        if name in ("Judaïsme",):  # a faith pavilion typed 'national' in the list; not a nation or region
            continue
        if national == ("national" in typ.lower()):
            # National pavilions are named after the country: its frwiki article gives EN/FR names.
            refs.append(Ref(name, name if national else None, "fr", national))
    return refs, [src]


def igloofest() -> tuple[list[Ref], list[dict]]:
    txt, src = wikipedia.page("Igloofest", "fr")
    body = sections(txt)["DJs/groupes notables"]
    refs = [Ref(_clean(re.sub(r"\(\d{4}.*", "", i.label)), i.title, "fr") for i in bullets(body)]
    return refs, [src]


def qc_region(region: str) -> tuple[list[Ref], list[dict]]:
    txt, src = wikipedia.page("Liste des festivals québécois", "fr")
    refs = []
    for tb in wikipedia.tables(txt)[:1]:
        for r in tb[1:]:
            if len(r) >= 3 and normalize_answer(wikipedia.plain(r[2])) == normalize_answer(region):
                refs += _link_or_text(r[0], "fr")[:1]
    return refs, [src]


def qc_city() -> tuple[list[Ref], list[dict]]:
    txt, src = wikipedia.page("Liste des festivals et événements de la ville de Québec", "fr")
    refs = []
    for name, body in sections(txt).items():
        if name in ("Disparus", "Notes et références", "Voir aussi", "Articles connexes"):
            continue
        refs += [Ref(i.label, i.title, "fr") for i in bullets(body)]
    cat, csrc = _cat("Festival à Québec", subcats=False)
    refs += [Ref(i.label, i.title, "fr") for i in cat]
    # Held in Montréal, though listed in the Québec City category.
    refs = [r for r in refs if (r.title or r.label) not in ("Les Sommets du cinéma d'animation",)]
    return refs, [src] + csrc


def qc_category(title: str) -> tuple[list[Ref], list[dict]]:
    items, srcs = _cat(title, depth=1)
    return [Ref(i.label, i.title, "fr") for i in items], srcs


def _regions() -> list[str]:
    txt, _ = wikipedia.page("Liste des festivals québécois", "fr")
    c: dict[str, int] = defaultdict(int)
    for r in wikipedia.tables(txt)[0][1:]:
        if len(r) >= 3:
            c[wikipedia.plain(r[2])] += 1
    return [k for k, v in sorted(c.items(), key=lambda kv: -kv[1]) if v >= MIN and k]


REGION_FR_EN = {
    "Montérégie": "Montérégie", "Laurentides": "Laurentians", "Lanaudière": "Lanaudière", "Estrie": "Eastern Townships",
    "Cantons-de-l'Est": "Eastern Townships", "Québec": "Québec City area", "Capitale-Nationale": "Québec City area",
    "Mauricie": "Mauricie", "Outaouais": "Outaouais", "Gaspésie": "Gaspésie", "Bas-Saint-Laurent": "Bas-Saint-Laurent",
    "Saguenay–Lac-Saint-Jean": "Saguenay–Lac-Saint-Jean", "Chaudière-Appalaches": "Chaudière-Appalaches", "Centre-du-Québec": "Centre-du-Québec",
    "Abitibi-Témiscamingue": "Abitibi-Témiscamingue", "Charlevoix": "Charlevoix", "Côte-Nord": "Côte-Nord", "Laval": "Laval", "Montréal": "Montréal",
}


def _events() -> list[Event]:
    W = "Wikipedia"
    ev = [
        Event("fireworks-gold", "festivals", "island",
              ("Name a country whose team won the Gold Jupiter at Montréal's International Fireworks Competition.", "Nommez un pays dont l'équipe a remporté le Jupiter d'or à L'International des Feux de Montréal."),
              ("Countries in the Gold Jupiter column of English Wikipedia's Montreal International Fireworks Competition article (1985–present, revision cited).",
               "Pays de la colonne Jupiter d'or de l'article Montreal International Fireworks Competition de Wikipédia anglais (1985 à aujourd'hui, révision citée)."),
              *fireworks((1,))),
        Event("fireworks-any", "festivals", "island",
              ("Name a country that won a Jupiter (gold, silver or bronze) at Montréal's International Fireworks Competition.", "Nommez un pays qui a remporté un Jupiter (or, argent ou bronze) à L'International des Feux de Montréal."),
              ("Countries in the Gold, Silver or Bronze Jupiter columns of English Wikipedia's Montreal International Fireworks Competition article.",
               "Pays des colonnes Jupiter d'or, d'argent ou de bronze de l'article Montreal International Fireworks Competition de Wikipédia anglais."),
              *fireworks((1, 2, 3))),
        Event("francouvertes-winner", "festivals", "island",
              ("Name a winner of Les Francouvertes, Montréal's emerging francophone music competition.", "Nommez un gagnant ou une gagnante des Francouvertes."),
              ("Winners (1st place) in the editions table of French Wikipedia's Francouvertes article (1995–present).", "Gagnants (1re position) du tableau des éditions de l'article Francouvertes de Wikipédia (1995 à aujourd'hui)."),
              *francouvertes((2,))),
        Event("francouvertes-podium", "festivals", "island",
              ("Name an act that finished 2nd or 3rd at Les Francouvertes.", "Nommez un artiste ou groupe arrivé 2e ou 3e aux Francouvertes."),
              ("Acts in the 2nd and 3rd place columns of the editions table of French Wikipedia's Francouvertes article.", "Artistes des colonnes 2e et 3e position du tableau des éditions de l'article Francouvertes de Wikipédia."),
              *francouvertes((3, 4))),
        Event("ffm-gp-film", "festivals", "island",
              ("Name a film that won the Grand Prix des Amériques at the Montréal World Film Festival.", "Nommez un film lauréat du Grand Prix des Amériques au Festival des films du monde de Montréal."),
              ("Films listed under Grand prix des Amériques in French Wikipedia's Festival des films du monde de Montréal article (1978–2018, ties included).",
               "Films de la section Grand prix des Amériques de l'article Festival des films du monde de Montréal de Wikipédia (1978–2018, ex æquo inclus)."),
              *ffm_grand_prix("film")),
        Event("ffm-gp-director", "festivals", "island",
              ("Name a director whose film won the Grand Prix des Amériques at the Montréal World Film Festival.", "Nommez un cinéaste dont le film a remporté le Grand Prix des Amériques au Festival des films du monde de Montréal."),
              ("Directors listed under Grand prix des Amériques in French Wikipedia's Festival des films du monde de Montréal article.",
               "Cinéastes de la section Grand prix des Amériques de l'article Festival des films du monde de Montréal de Wikipédia."),
              *ffm_grand_prix("director")),
        Event("f1-driver-mtl", "sports", "island",
              ("Name a driver who won the Formula One Canadian Grand Prix in Montréal (Circuit Gilles-Villeneuve).", "Nommez un pilote qui a gagné le Grand Prix du Canada de Formule 1 à Montréal (circuit Gilles-Villeneuve)."),
              ("Winners of editions held at Circuit Gilles-Villeneuve (1978–present) in the results table of French Wikipedia's Grand Prix automobile du Canada article.",
               "Vainqueurs des éditions disputées au circuit Gilles-Villeneuve (1978 à aujourd'hui) dans le palmarès de l'article Grand Prix automobile du Canada de Wikipédia."),
              *f1_montreal(1),
              aliases={"michaelschumacher": ["Schumacher"], "lewishamilton": ["Hamilton"], "gillesvilleneuve": ["Gilles"], "maxverstappen": ["Verstappen"], "ayrtonsenna": ["Senna"], "nelsonpiquet": ["Piquet"]}),
        Event("f1-team-mtl", "sports", "island",
              ("Name a constructor (team) that won the Canadian Grand Prix in Montréal.", "Nommez une écurie qui a gagné le Grand Prix du Canada à Montréal."),
              ("Constructors of the winning cars in editions held at Circuit Gilles-Villeneuve in French Wikipedia's Grand Prix automobile du Canada results table.",
               "Constructeurs des voitures gagnantes des éditions disputées au circuit Gilles-Villeneuve dans le palmarès de l'article Grand Prix automobile du Canada de Wikipédia."),
              *f1_montreal(2)),
        Event("gp-cycliste", "sports", "city",
              ("Name a winner of the Grand Prix Cycliste de Montréal (UCI WorldTour road race).", "Nommez un vainqueur du Grand Prix cycliste de Montréal."),
              ("Winners in the Podiums table of French Wikipedia's Grand Prix cycliste de Montréal article (2010–present).", "Vainqueurs du tableau Podiums de l'article Grand Prix cycliste de Montréal de Wikipédia (2010 à aujourd'hui)."),
              *gp_cycliste((1,))),
        Event("gp-cycliste-podium", "sports", "city",
              ("Name a rider who finished on the podium (top 3) of the Grand Prix Cycliste de Montréal.", "Nommez un coureur monté sur le podium (top 3) du Grand Prix cycliste de Montréal."),
              ("Riders in the Podiums table of French Wikipedia's Grand Prix cycliste de Montréal article (1st–3rd, 2010–present).", "Coureurs du tableau Podiums de l'article Grand Prix cycliste de Montréal de Wikipédia (1er à 3e, 2010 à aujourd'hui)."),
              *gp_cycliste((1, 2, 3))),
        Event("marathon", "sports", "city",
              ("Name a winner (men's or women's) of the Montréal Marathon.", "Nommez un gagnant ou une gagnante du Marathon de Montréal."),
              ("Men's and women's marathon winners in the winners table of French Wikipedia's Marathon de Montréal article.", "Gagnants et gagnantes du marathon dans le tableau des vainqueurs de l'article Marathon de Montréal de Wikipédia."),
              *marathon()),
        Event("olympics-1976-venue", "history", "greater",
              ("Name a venue in Montréal or its region that hosted events at the 1976 Summer Olympics.", "Nommez un site de Montréal ou de sa région qui a accueilli des épreuves des Jeux olympiques d'été de 1976."),
              ("Venues in the Montreal Olympic Park and Greater Montreal tables of English Wikipedia's Venues of the 1976 Summer Olympics article.",
               "Sites des tableaux Parc olympique de Montréal et Grand Montréal de l'article Venues of the 1976 Summer Olympics de Wikipédia anglais."),
              *olympics_venues(),
              aliases={"olympicstadium": ["Big O", "Stade olympique"], "velodrome": ["Biodôme"]}),
        Event("expo67-national", "festivals", "island",
              ("Name a country or region that had a national pavilion at Expo 67.", "Nommez un pays ou une région qui avait un pavillon national à Expo 67."),
              ("Pavilions of type 'pavillon national' in French Wikipedia's Liste des pavillons d'Expo 67.", "Pavillons de type « pavillon national » de la Liste des pavillons d'Expo 67 de Wikipédia."),
              *expo67(True),
              aliases={"unionsovietique": ["USSR", "Soviet Union", "URSS"], "etatsunis": ["USA", "United States", "U.S."], "royaumeuni": ["UK", "Britain", "Great Britain"]}),
        Event("expo67-other", "festivals", "island",
              ("Name a theme, provincial or corporate pavilion of Expo 67.", "Nommez un pavillon thématique, provincial ou d'entreprise d'Expo 67."),
              ("Pavilions other than national (and other than service buildings) in French Wikipedia's Liste des pavillons d'Expo 67.", "Pavillons autres que nationaux (et autres que bâtiments de service) de la Liste des pavillons d'Expo 67 de Wikipédia."),
              *expo67(False)),
        Event("igloofest-dj", "festivals", "island",
              ("Name a notable DJ or act that played Igloofest.", "Nommez un DJ ou un groupe notable qui a joué à Igloofest."),
              ("Acts in the notable DJs/groups list of French Wikipedia's Igloofest article.", "Artistes de la liste des DJs et groupes notables de l'article Igloofest de Wikipédia."),
              *igloofest()),
        Event("qc-city-festival", "festivals", "province",
              ("Name a festival or recurring event held in Québec City.", "Nommez un festival ou un événement récurrent tenu à Québec (la ville)."),
              ("Current events on French Wikipedia's Liste des festivals et événements de la ville de Québec, plus its category Festival à Québec.",
               "Événements courants de la Liste des festivals et événements de la ville de Québec de Wikipédia, et sa catégorie Festival à Québec."),
              *qc_city(),
              aliases={"festivaldetedequebec": ["FEQ", "Quebec City Summer Festival", "Festival d'été"], "carnavaldequebec": ["Carnaval", "Quebec Winter Carnival"]}),
        Event("qc-music-festival", "festivals", "province",
              ("Name a music festival held in Québec outside Montréal.", "Nommez un festival de musique tenu au Québec ailleurs qu'à Montréal."),
              ("Articles in French Wikipedia's category Festival de musique au Québec and its subcategories, minus those in Festival de musique à Montréal.",
               "Articles de la catégorie Festival de musique au Québec de Wikipédia et de ses sous-catégories, moins ceux de Festival de musique à Montréal."),
              *_minus(qc_category("Festival de musique au Québec"), "Festival de musique à Montréal")),
        Event("qc-film-festival", "festivals", "province",
              ("Name a film festival held in Québec outside Montréal.", "Nommez un festival de cinéma tenu au Québec ailleurs qu'à Montréal."),
              ("Articles in French Wikipedia's category Festival de cinéma au Québec and its subcategories, minus those in Festival de cinéma à Montréal.",
               "Articles de la catégorie Festival de cinéma au Québec de Wikipédia et de ses sous-catégories, moins ceux de Festival de cinéma à Montréal."),
              *_minus(qc_category("Festival de cinéma au Québec"), "Festival de cinéma à Montréal")),
    ]
    ev += [
        Event("ridm-film", "festivals", "island",
              ("Name a documentary that won a prize at the RIDM (Montréal International Documentary Festival).", "Nommez un documentaire primé aux Rencontres internationales du documentaire de Montréal (RIDM)."),
              ("Films in the per-edition award tables of French Wikipedia's Rencontres internationales du documentaire de Montréal article (2012 onward).",
               "Films des tableaux de prix par édition de l'article Rencontres internationales du documentaire de Montréal de Wikipédia (depuis 2012)."),
              *ridm(1)),
        Event("ridm-director", "festivals", "island",
              ("Name a filmmaker who won a prize at the RIDM (Montréal International Documentary Festival).", "Nommez un ou une cinéaste primé(e) aux Rencontres internationales du documentaire de Montréal (RIDM)."),
              ("Directors in the per-edition award tables of French Wikipedia's Rencontres internationales du documentaire de Montréal article (2012 onward).",
               "Réalisateurs et réalisatrices des tableaux de prix par édition de l'article Rencontres internationales du documentaire de Montréal de Wikipédia (depuis 2012)."),
              *ridm(2)),
    ]
    for span, yrs in (("1996–2012", ("1996–2005", "2006", "2007", "2008", "2009", "2010", "2011", "2012")),
                      ("2013–2018", ("2013", "2014", "2015", "2016", "2017", "2018")),
                      ("2019 onward", tuple(str(y) for y in range(2019, 2031)))):
        ev.append(Event(f"fantasia-{span[:4]}", "festivals", "island",
                        (f"Name a film that screened at Montréal's Fantasia festival ({span}).", f"Nommez un film présenté au festival Fantasia de Montréal ({span})."),
                        (f"Films named in the {span} year sections of English Wikipedia's Fantasia International Film Festival article.",
                         f"Films nommés dans les sections annuelles {span} de l'article Fantasia International Film Festival de Wikipédia anglais."),
                        *fantasia(yrs)))
    groups = [("2008", "2009", "2010", "2011"), ("2012", "2013"), ("2014", "2015"), ("2016", "2018", "2019")]
    for g in groups:
        span = f"{g[0]}–{g[-1]}"
        ev.append(Event(f"heavy-{g[0]}", "festivals", "island",
                        (f"Name a band that played Heavy Montréal (formerly Heavy MTL) between {span}.", f"Nommez un groupe qui a joué à Heavy Montréal (ex-Heavy MTL) entre {span}."),
                        (f"Linked acts in the {span} line-up tables of English Wikipedia's Heavy Montréal article.", f"Groupes liés des tableaux de programmation {span} de l'article Heavy Montréal de Wikipédia anglais."),
                        *heavy(g)))
    for region in _regions():
        if region in ("Montréal", "Québec", "Capitale-Nationale"):  # Montréal is covered elsewhere; Québec City by qc-city-festival
            continue
        en = REGION_FR_EN.get(region, region)
        ev.append(Event(f"qc-region-{region}", "festivals", "province",
                        (f"Name a festival held in the {en} tourist region of Québec.", f"Nommez un festival tenu dans la région touristique {_de(region)}."),
                        (f"Festivals whose tourist region is {region} in the table of French Wikipedia's Liste des festivals québécois.",
                         f"Festivals dont la région touristique est {region} dans le tableau de la Liste des festivals québécois de Wikipédia."),
                        *qc_region(region)))
    return ev


def _de(region: str) -> str:
    return ("de l'" if region[0] in "AEÉIOU" else "de la " if region in ("Montérégie", "Mauricie", "Gaspésie", "Côte-Nord") else "des " if region.endswith("s") and region in ("Laurentides", "Cantons-de-l'Est") else "de ") + region


def _minus(part: tuple[list[Ref], list[dict]], cat: str) -> tuple[list[Ref], list[dict]]:
    refs, srcs = part
    drop, more = _cat(cat, depth=1)
    gone = {i.title for i in drop}
    return [r for r in refs if r.title not in gone], srcs + more


# ---------------------------------------------------------------- build
def event_templates(ctx: Context) -> list[Candidate]:
    events = _events()
    by_lang: dict[str, set[str]] = defaultdict(set)
    for e in events:
        for r in e.refs:
            if r.title:
                by_lang[r.lang].add(r.title)
    info = {lang: wikidata.by_wiki(sorted(t), lang)[0] for lang, t in by_lang.items()}
    wsrc = {**wikidata.SOURCE, "retrieved": wikidata.by_wiki(sorted(by_lang.get("fr", {"x"})), "fr")[1] or ""}
    out = []
    for e in events:
        answers: list[Answer] = []
        index: dict[str, Answer] = {}
        for r in e.refs:
            label = _clean(r.label)
            if len(normalize_answer(label)) < 2:
                continue
            wd = info.get(r.lang, {}).get(r.title or "")
            other = None
            if wd:
                other = wd["fr"] if r.lang == "en" else wd["en"]
                if other and not (r.trust_label or _same_thing(label, other)):
                    other = None
            en, fr = (label, other) if r.lang == "en" else (other or label, label)
            en, fr = _clean(en), _clean(fr) if fr else None
            keys = {normalize_answer(x) for x in (en, fr or "", label) if x} | ({wd["qid"]} if wd else set())
            a = next((index[k] for k in keys if k in index), None)
            if a is None:
                a = Answer(en=en, fr=fr if fr and normalize_answer(fr) != normalize_answer(en) else None)
                answers.append(a)
            for k in keys:
                index.setdefault(k, a)
            if r.title and _clean(r.title) not in (a.en, a.fr) and _same_thing(label, r.title):
                a.aliases.append(_clean(r.title))
            if wd and f"wikidata:{wd['qid']}" not in a.refs:
                a.refs.append(f"wikidata:{wd['qid']}")
                a.signal = max(a.signal, math.log1p(wd["sl"]))
            elif not wd and not a.refs:
                sig, refs, _ = place_signal(ctx, label)
                a.signal, a.refs = math.log1p(sig), refs
            a.signal += 0.05  # repeat winners/acts rank slightly higher
        table = {compact(k): v for k, v in e.aliases.items()}
        for a in answers:
            for form in (a.en, a.fr or ""):
                a.aliases += [x for x in table.get(compact(form), []) if x not in a.aliases]
            a.aliases = [x for x in dict.fromkeys(a.aliases) if normalize_answer(x) not in (normalize_answer(a.en), normalize_answer(a.fr or ""))]
        if len(answers) < MIN:
            continue
        out.append(Candidate(
            id=make_id("ev", e.key),
            template="wikipedia-event",
            concept=f"ev:{e.key}",
            category=e.category,
            scope=e.scope,
            prompt={"en": e.prompt[0], "fr": e.prompt[1]},
            eligibility={"en": e.eligibility[0], "fr": e.eligibility[1]},
            sources=e.sources + [wsrc],
            answers=answers,
            est_basis="wikidata-sitelinks",
        ))
    return out
