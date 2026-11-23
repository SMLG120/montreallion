"""Phase D: public map layers → public/map/*.geojson + public/map/index.json.

Every geometry comes from a cited source (City of Montréal open data, STM/REM/exo GTFS, OpenStreetMap, Wikipedia
coordinates, Wikidata P625). Nothing is positioned by hand or by geocoding a name.

These layers are a general map of Montréal. They deliberately carry NO question ids, rarity, scores or eligibility
tags (e.g. restaurants show a generic kind, never the cuisine a question filters on). The only question-linked
coordinates live in the server-only data/generated/answer-geo.json, served per player after a reveal.
"""

from __future__ import annotations

import json
import re
import time
from collections import defaultdict

from . import PROJECT_ROOT
from . import geo
from .http import fetch, fetch_json
from .normalize import normalize_answer
from .sources import ckan, gtfs, osm, wikidata, wikipedia

OUT = PROJECT_ROOT / "public" / "map"
GREATER = (-74.10, 45.30, -73.30, 45.80)  # west, south, east, north
OVERPASS = "https://overpass-api.de/api/interpreter"
OSM_SRC = {"title": "OpenStreetMap (Overpass API)", "url": "https://www.openstreetmap.org/copyright", "license": osm.LICENSE}


def _in(lon: float, lat: float) -> bool:
    return GREATER[0] <= lon <= GREATER[2] and GREATER[1] <= lat <= GREATER[3]


def _pt(lon: float, lat: float, **props) -> dict:
    return {"type": "Feature", "geometry": {"type": "Point", "coordinates": [round(lon, 5), round(lat, 5)]}, "properties": {k: v for k, v in props.items() if v not in (None, "", [])}}


# ---------------------------------------------------------------- polygons
def areas_layer(ctx) -> tuple[list[dict], list[dict]]:
    feats = []
    for a in ctx.areas:
        g = geo.simplify_geometry(a.geom, 0.0002)
        if g:
            feats.append({"type": "Feature", "geometry": g, "properties": {"name": a.name, "kind": a.kind}})
    return feats, [ctx.src["limites"]]


def neighbourhoods_layer(ctx) -> tuple[list[dict], list[dict]]:
    f, src = ckan.resource("quartiers", fmt="geojson", name_contains="Quartiers de r")
    feats = []
    for ft in ckan.read_json(f)["features"]:  # type: ignore[index]
        p = ft["properties"]
        g = geo.simplify_geometry(ft["geometry"], 0.0001)
        if g:
            area = p["nom_arr"] if p["nom_mun"] == "Montréal" else p["nom_mun"]
            feats.append({"type": "Feature", "geometry": g, "properties": {"name": p["nom_qr"].strip(), "area": area.strip()}})
    return feats, [src]


# ---------------------------------------------------------------- roads (OSM)
ROADS_Q = f"""[out:json][timeout:180];
(way["highway"~"^(motorway|trunk|primary)$"]["ref"]({GREATER[1]},{GREATER[0]},{GREATER[3]},{GREATER[2]});
 way["bridge"="yes"]["highway"~"^(motorway|trunk|primary|secondary)$"]["name"~"^(Pont|Tunnel)"]({GREATER[1]},{GREATER[0]},{GREATER[3]},{GREATER[2]});
 way["tunnel"="yes"]["highway"~"^(motorway|trunk)$"]["name"]({GREATER[1]},{GREATER[0]},{GREATER[3]},{GREATER[2]}););
out geom tags;"""


def route_ref(raw: str) -> tuple[str, str] | None:
    """OSM Québec refs are bare numbers ('40', 'A 13'): autoroutes are 1–99 and 400+, provincial routes 100–399."""
    m = re.fullmatch(r"(?:A|R)?\s*-?\s*(\d{1,3})", raw.strip(), re.I)
    if not m:
        return None
    n = int(m.group(1))
    return ("autoroute", f"A-{n}") if n < 100 or n >= 400 else ("route", f"R-{n}")


def _merge_lines(lines: list[list]) -> list[list]:
    """Greedy line merge: join segments whose end touches another's start (OSM splits roads into many ways)."""
    key = lambda p: (round(p[0], 6), round(p[1], 6))  # noqa: E731
    pool: list[list | None] = [l for l in lines if len(l) >= 2]
    merged = True
    while merged:
        merged = False
        starts: dict[tuple, int] = {}
        for i, l in enumerate(pool):
            if l is not None:
                starts.setdefault(key(l[0]), i)
        for i in range(len(pool)):
            l = pool[i]
            if l is None:
                continue
            j = starts.get(key(l[-1]))
            if j is None or j == i or pool[j] is None:
                continue
            pool[i] = l + pool[j][1:]  # type: ignore[index]
            pool[j] = None
            starts.pop(key(l[-1]), None)
            merged = True
        pool = [l for l in pool if l is not None]
    return pool  # type: ignore[return-value]


def roads_layer() -> tuple[list[dict], list[dict]]:
    f = fetch("osm-overpass-roads", OVERPASS, post={"data": ROADS_Q}, timeout=240, suffix=".json")
    data = json.loads(f.path.read_text("utf-8"))
    groups: dict[tuple, list] = defaultdict(list)
    names: dict[tuple, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    for e in data["elements"]:
        t = e.get("tags", {})
        if t.get("highway") not in ("motorway", "trunk", "primary") or not t.get("ref"):
            continue
        refs = [r for r in (route_ref(x) for x in t["ref"].split(";")) if r]
        if not refs:
            continue
        cls = "autoroute" if any(c == "autoroute" for c, _ in refs) else "route"
        k = (cls, tuple(sorted({r for _, r in refs})))
        groups[k].append([[p["lon"], p["lat"]] for p in e["geometry"]])
        if t.get("name"):
            names[k][t["name"]] += 1
    feats = []
    for (cls, refs), lines in sorted(groups.items()):
        ml = [geo.round_coords(geo.simplify(l, 0.00008)) for l in _merge_lines(lines)]
        name = max(names[(cls, refs)].items(), key=lambda kv: kv[1])[0] if names[(cls, refs)] else None
        feats.append({"type": "Feature", "geometry": {"type": "MultiLineString", "coordinates": ml},
                      "properties": {"cls": cls, "ref": " / ".join(refs), "refs": list(refs), **({"name": name} if name else {})}})
    return feats, [{**OSM_SRC, "retrieved": f.retrieved}]


def interchanges_layer() -> tuple[list[dict], list[dict]]:
    q = f'[out:json][timeout:120];nwr["name"~"^(Échangeur|Echangeur)"]({GREATER[1]},{GREATER[0]},{GREATER[3]},{GREATER[2]});out center tags;'
    f = fetch("osm-overpass-interchanges", OVERPASS, post={"data": q}, timeout=240, suffix=".json")
    acc: dict[str, list] = defaultdict(list)
    label: dict[str, str] = {}
    for e in json.loads(f.path.read_text("utf-8"))["elements"]:
        name = re.sub(r"\bSt-", "Saint-", e["tags"]["name"]).replace("PIerre", "Pierre")
        lat = e.get("lat") or e.get("center", {}).get("lat")
        lon = e.get("lon") or e.get("center", {}).get("lon")
        if lat is None:
            continue
        k = normalize_answer(name)
        acc[k].append((lon, lat))
        label.setdefault(k, name)
    # An interchange is mapped as several junction nodes: its marker is their mean position.
    feats = [_pt(sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts), name=label[k], kind="interchange") for k, pts in acc.items()]
    return feats, [{**OSM_SRC, "retrieved": f.retrieved}]


# ---------------------------------------------------------------- transit
RAIL = [("metro", "stm-gtfs", gtfs.URL, {"1"}), ("rem", "rem-gtfs", gtfs.REM_URL, {"0", "1", "2"})]


def transit_layers(ctx) -> tuple[tuple[list[dict], list[dict]], tuple[list[dict], list[dict]]]:
    from .templates.expansion import EXO_SOURCE, EXO_URL

    rail = RAIL + [("exo", "exo-trains-gtfs", EXO_URL, {"2"})]
    lines, stations = [], []
    for system, key, url, types in rail:
        for l in gtfs.rail_lines(key, url, types):
            lines.append({"type": "Feature", "geometry": {"type": "LineString", "coordinates": geo.round_coords(geo.simplify(l["coords"], 0.00003))},
                          "properties": {"system": system, "name": l["long"] or l["short"], "color": l["color"]}})
    exo = gtfs.load_rail("exo-trains-gtfs", EXO_URL, {"2"})
    for system, data in (("metro", ctx.metro), ("rem", ctx.rem), ("exo", exo)):
        for s in data.stations.values():
            if _in(s.lon, s.lat):
                stations.append(_pt(s.lon, s.lat, name=re.sub(r"^gare\s+", "", s.name, flags=re.I), system=system, area=ctx.area_index.locate(s.lon, s.lat)))
    srcs = [ctx.src["gtfs"], ctx.src["rem"], {**EXO_SOURCE, "retrieved": exo.retrieved}]
    return (lines, srcs), (stations, srcs)


# ---------------------------------------------------------------- places
def parks_layer(ctx) -> tuple[list[dict], list[dict]]:
    from .templates import PARK_TYPE_EN  # type: ignore[attr-defined]

    feats = []
    for p in ctx.parks:
        if p.get("lonlat"):
            en = f"{p['specific']} {PARK_TYPE_EN.get(p['type'], 'Park')}"
            feats.append(_pt(*p["lonlat"], name=f"{p['type']} {p['specific']}", name_en=en, kind=p["type"], area=p["area"], ha=round(p["ha"], 1)))
    return feats, [ctx.src["parcs"]]


def gardens_layer(ctx) -> tuple[list[dict], list[dict]]:
    f, src = ckan.resource("jardins-communautaires", fmt="csv")
    feats = [_pt(float(r["longitude"]), float(r["latitude"]), name=re.sub(r"\s+", " ", r["nom"]).strip(), kind="community-garden", area=r["arrondissement"].strip())
             for r in ckan.read_csv(f) if r["latitude"] and r["longitude"]]
    return feats, [src]


LPC_KIND = {"IC": "classified heritage building", "SC": "classified heritage site", "SD": "declared heritage site", "SP": "cited heritage site", "IP": "cited heritage building", "SPC": "cited heritage site"}


def heritage_layer(ctx) -> tuple[list[dict], list[dict]]:
    f, src = ckan.resource("sites-immeubles-proteges-lpc", fmt="geojson")
    feats = []
    for ft in ckan.read_json(f)["features"]:  # type: ignore[index]
        p = ft["properties"]
        name = re.sub(r"\s+", " ", (p["Nom"] or "")).strip()
        c = geo.centroid(ft["geometry"])
        if p["type_zone"] == "AP" or not name or not c:
            continue
        lon, lat = geo.mtm8_to_lonlat(*c)
        if _in(lon, lat):
            feats.append(_pt(lon, lat, name=name, kind="heritage", status=LPC_KIND.get(p["type_zone"], p["type_zone"]), area=ctx.area_index.locate(lon, lat)))
    nhs_txt, nhs_src = wikipedia.page("List of National Historic Sites of Canada in Montreal")
    from .templates.expansion import _coord

    for r in wikipedia.tables(nhs_txt)[0][1:]:
        if len(r) >= 4 and (ll := _coord(r[3])) and _in(*ll):
            feats.append(_pt(*ll, name=wikipedia.plain(r[0]), kind="national-historic-site", area=ctx.area_index.locate(*ll)))
    return feats, [src, nhs_src]


def _wd_points(qids: list[str]) -> dict[str, tuple[float, float]]:
    """QID → P625 coordinate, or the P625 of its P276 location (festivals are held at a place)."""
    import hashlib

    qids = sorted(set(qids))
    out: dict[str, tuple[float, float]] = {}
    for i in range(0, len(qids), 1200):
        chunk = qids[i : i + 1200]
        key = "wd-mappoints-" + hashlib.sha256(" ".join(chunk).encode()).hexdigest()[:12]
        q = ("SELECT ?item ?c ?lc WHERE { VALUES ?item { %s } OPTIONAL { ?item wdt:P625 ?c } OPTIONAL { ?item wdt:P276 ?l . ?l wdt:P625 ?lc } }"
             % " ".join(f"wd:{x}" for x in chunk))
        data, _ = fetch_json(key, wikidata.ENDPOINT, post={"query": q, "format": "json"}, timeout=180)
        for b in data["results"]["bindings"]:  # type: ignore[index]
            qid = b["item"]["value"].rsplit("/", 1)[-1]
            v = (b.get("c") or b.get("lc") or {}).get("value", "")
            if qid not in out and v.startswith("Point("):
                lon, lat = (float(x) for x in v[6:-1].split())
                out[qid] = (lon, lat)
    return out


def _list_points(ctx, cands, kind: str) -> list[dict]:
    rows = []
    for c in cands:
        for a in c.answers:
            q = next((r[9:] for r in a.refs if r.startswith("wikidata:")), None)
            if q:
                rows.append((q, a))
    pts = _wd_points([q for q, _ in rows])
    feats, seen = [], set()
    for q, a in rows:
        if q in pts and q not in seen and _in(*pts[q]):
            seen.add(q)
            feats.append(_pt(*pts[q], name=a.fr or a.en, name_en=a.en if a.fr and a.fr != a.en else None, kind=kind, area=ctx.area_index.locate(*pts[q]), wikidata=q))
    return feats


def culture_layers(ctx) -> dict[str, tuple[list[dict], list[dict]]]:
    """Museums, theatres, festivals, skyscrapers and bridges: Wikipedia lists → Wikidata → P625 (P276 for festivals)."""
    from .templates import wikilists
    from .templates.expansion import museum_templates

    wsrc = {**wikidata.SOURCE, "title": "Wikidata (coordinate location P625)", "retrieved": time.strftime("%Y-%m-%d")}
    spec = {s.key: s for s in wikilists.SPECS}

    def wl(*keys: str):
        cands, srcs = [], []
        for k in keys:
            items, s = spec[k].collect()  # type: ignore[operator]
            info, _ = wikidata.by_wiki([i.title for i in items if i.title], "fr")
            from .model import Answer, Candidate

            ans = []
            for i in items:
                wd = info.get(i.title or "")
                if wd:
                    ans.append(Answer(en=wd.get("en") or i.label, fr=i.label, refs=[f"wikidata:{wd['qid']}"]))
            cands.append(Candidate("x", "x", "x", "x", "x", {}, {}, [], ans, "x"))
            srcs += s
        return cands, list({x["url"]: x for x in srcs}.values())

    museums = [c for c in museum_templates(ctx) if c.id.endswith("all")] or museum_templates(ctx)
    out = {"museums": (_list_points(ctx, museums, "museum"), museums[0].sources[:1] + [wsrc])}
    for layer, keys, kind in (("theatres", ("theatre",), "theatre"), ("festivals", ("fest-any",), "festival"),
                              ("skyscrapers", ("skyscraper-top25", "skyscraper-old"), "skyscraper"),
                              ("bridges", ("bridge-st-lawrence", "bridge-prairies", "bridge-west"), "bridge")):
        cands, srcs = wl(*keys)
        out[layer] = (_list_points(ctx, cands, kind), srcs + [wsrc])
    return out


FOOD_KIND = {"restaurant": "restaurant", "fast_food": "fast-food", "cafe": "café", "ice_cream": "ice-cream", "bar": "bar", "pub": "bar", "brewery": "bar",
             "bakery": "bakery", "pastry": "bakery"}


def food_layer(ctx) -> tuple[list[dict], list[dict]]:
    from .templates.food import open_places

    places, srcs = open_places(ctx)
    pois = {p["id"]: p for p in osm.food_pois()[0]}
    feats, seen = [], set()
    for p in places:
        if p.reg_id in seen or p.osm_id not in pois:
            continue
        seen.add(p.reg_id)
        t = p.tags
        k = t.get("amenity") or t.get("shop") or t.get("craft") or ""
        poi = pois[p.osm_id]
        # Generic kind only: cuisine tags would reproduce the food questions' eligibility lists.
        feats.append(_pt(poi["lon"], poi["lat"], name=p.name, kind=FOOD_KIND.get(k, "food-shop"), area=p.area))
    return feats, srcs


# ---------------------------------------------------------------- write
LAYERS = [  # id, geometry, group
    ("areas", "fill", "boundaries"), ("neighbourhoods", "fill", "boundaries"),
    ("roads", "line", "roads"), ("interchanges", "circle", "roads"), ("bridges", "circle", "roads"),
    ("rail", "line", "transit"), ("stations", "circle", "transit"),
    ("parks", "circle", "parks"), ("gardens", "circle", "parks"),
    ("heritage", "circle", "history"), ("museums", "circle", "culture"), ("theatres", "circle", "culture"),
    ("festivals", "circle", "culture"), ("skyscrapers", "circle", "history"),
    ("food", "circle", "food"),
]


def build_map(ctx, log=print) -> dict:
    OUT.mkdir(parents=True, exist_ok=True)
    built: dict[str, tuple[list[dict], list[dict]]] = {
        "areas": areas_layer(ctx),
        "neighbourhoods": neighbourhoods_layer(ctx),
        "roads": roads_layer(),
        "interchanges": interchanges_layer(),
        "parks": parks_layer(ctx),
        "gardens": gardens_layer(ctx),
        "heritage": heritage_layer(ctx),
        "food": food_layer(ctx),
    }
    built["rail"], built["stations"] = transit_layers(ctx)
    built.update(culture_layers(ctx))
    index = []
    for lid, kind, group in LAYERS:
        feats, srcs = built[lid]
        body = json.dumps({"type": "FeatureCollection", "features": feats}, ensure_ascii=False, separators=(",", ":"))
        (OUT / f"{lid}.geojson").write_text(body, "utf-8")
        index.append({"id": lid, "file": f"/map/{lid}.geojson", "geometry": kind, "group": group, "count": len(feats), "bytes": len(body.encode()),
                      "sources": [{k: s[k] for k in ("title", "url", "license", "retrieved") if k in s} for s in srcs]})
        log(f"map: {lid:15s} {len(feats):5d} features {len(body.encode()) / 1024:8.1f} KB")
    (OUT / "index.json").write_text(json.dumps({"generated": time.strftime("%Y-%m-%d"), "bbox": GREATER, "layers": index}, ensure_ascii=False, indent=1) + "\n", "utf-8")
    return {l["id"]: l["count"] for l in index}
