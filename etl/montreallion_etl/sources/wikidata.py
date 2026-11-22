"""Wikidata (CC0). Used for (a) EN labels and (b) sitelink counts as a familiarity proxy.

Sitelinks = number of Wikipedia/Wikimedia language editions with an article on the item.
It's a crude but reproducible, data-backed signal for "how widely known is this?".
"""

from __future__ import annotations

import re

from ..http import fetch_json
from ..normalize import normalize_answer

ENDPOINT = "https://query.wikidata.org/sparql"
SOURCE = {
    "title": "Wikidata (sitelink counts and labels)",
    "url": "https://www.wikidata.org/",
    "license": "CC0 1.0",
}

# Island of Montréal bounding box (generous); items are later matched by name within a question's context.
PLACES_QUERY = """
SELECT ?item ?sl ?fr ?en WHERE {
  SERVICE wikibase:box {
    ?item wdt:P625 ?loc .
    bd:serviceParam wikibase:cornerSouthWest "Point(-73.99 45.39)"^^geo:wktLiteral ;
                    wikibase:cornerNorthEast "Point(-73.46 45.72)"^^geo:wktLiteral .
  }
  ?item wikibase:sitelinks ?sl . FILTER(?sl > 0)
  OPTIONAL { ?item rdfs:label ?fr FILTER(LANG(?fr) = "fr") }
  OPTIONAL { ?item rdfs:label ?en FILTER(LANG(?en) = "en") }
}
"""

PAREN = re.compile(r"\s*\([^)]*\)\s*")

STATIONS_QUERY = """
SELECT ?item ?sl ?fr ?en WHERE {
  ?item wdt:P16 wd:Q392377 ; wdt:P81 ?line ; wikibase:sitelinks ?sl .
  OPTIONAL { ?item rdfs:label ?fr FILTER(LANG(?fr) = "fr") }
  OPTIONAL { ?item rdfs:label ?en FILTER(LANG(?en) = "en") }
}
"""


def _key(label: str) -> str:
    """Strict key: like normalize_answer but WITHOUT dropping filler words, so 'Parc Jarry' ≠ 'Jarry'."""
    s = PAREN.sub(" ", label)
    s = normalize_answer("x " + s + " x")  # padding defeats prefix/suffix filler stripping
    return s[1:-1]


class Index:
    """Lookup: normalized label → (max sitelinks, best EN label, qid)."""

    def __init__(self) -> None:
        self.by_key: dict[str, tuple[int, str | None, str]] = {}

    def add(self, qid: str, sl: int, fr: str | None, en: str | None) -> None:
        for label in (fr, en):
            if not label:
                continue
            k = _key(label)
            if not k:
                continue
            cur = self.by_key.get(k)
            if cur is None or sl > cur[0]:
                self.by_key[k] = (sl, en, qid)

    def lookup(self, *names: str) -> tuple[int, str | None, str] | None:
        best = None
        for n in names:
            hit = self.by_key.get(_key(n))
            if hit and (best is None or hit[0] > best[0]):
                best = hit
        return best


def _bindings(data: object) -> list[dict]:
    return data["results"]["bindings"]  # type: ignore[index]


def places(refresh: bool = False) -> tuple[Index, str]:
    data, f = fetch_json("wd-island-places", ENDPOINT, post={"query": PLACES_QUERY, "format": "json"}, refresh=refresh, timeout=180)
    idx = Index()
    for b in _bindings(data):
        idx.add(b["item"]["value"].rsplit("/", 1)[-1], int(b["sl"]["value"]), b.get("fr", {}).get("value"), b.get("en", {}).get("value"))
    return idx, f.retrieved


def stations(refresh: bool = False) -> tuple[Index, str]:
    """Montréal Metro stations (network Q392377). Labels like 'Jarry station' are reduced to 'Jarry'."""
    data, f = fetch_json("wd-metro-stations", ENDPOINT, post={"query": STATIONS_QUERY, "format": "json"}, refresh=refresh, timeout=180)
    idx = Index()
    for b in _bindings(data):
        fr = b.get("fr", {}).get("value")
        en = b.get("en", {}).get("value")
        en_short = re.sub(r"\s+station$", "", en) if en else None
        fr_short = re.sub(r"^station\s+", "", fr, flags=re.I) if fr else None
        idx.add(b["item"]["value"].rsplit("/", 1)[-1], int(b["sl"]["value"]), fr_short, en_short)
    return idx, f.retrieved


def people(names: list[str], key: str, refresh: bool = False) -> tuple[Index, str]:
    """Visual artists (occupation ⊑ visual artist Q3391743) whose FR or EN label exactly matches one of `names`.

    The occupation filter avoids crediting a namesake (e.g. a politician) with an artist's fame."""
    clean = sorted({PAREN.sub(" ", n).strip() for n in names if n.strip()})
    values = " ".join('"%s"@fr "%s"@en' % (n.replace('"', ""), n.replace('"', "")) for n in clean)
    q = f"""
SELECT ?item ?sl ?fr ?en WHERE {{
  VALUES ?name {{ {values} }}
  ?item rdfs:label ?name ; wdt:P31 wd:Q5 ; wikibase:sitelinks ?sl .
  FILTER EXISTS {{ ?item wdt:P106/wdt:P279* wd:Q3391743 }}
  OPTIONAL {{ ?item rdfs:label ?fr FILTER(LANG(?fr) = "fr") }}
  OPTIONAL {{ ?item rdfs:label ?en FILTER(LANG(?en) = "en") }}
}}"""
    data, f = fetch_json(key, ENDPOINT, post={"query": q, "format": "json"}, refresh=refresh, timeout=180)
    idx = Index()
    for b in _bindings(data):
        idx.add(b["item"]["value"].rsplit("/", 1)[-1], int(b["sl"]["value"]), b.get("fr", {}).get("value"), b.get("en", {}).get("value"))
    return idx, f.retrieved
