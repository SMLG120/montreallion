"""Answer coordinates for the map (phase D).

Every point comes from the answer's own source record, never from a name lookup or a guess:
  1. a coordinate carried by the template from the source row (park polygon centroid, LPC heritage centroid, …)
  2. its provenance refs: GTFS stop (STM/REM/exo), City food registry, community gardens, OSM node
  3. Wikidata P625 (coordinate location) of its QID

Output: data/generated/answer-geo.json, {questionId: {answerSlug: [lon, lat, basis]}}.
It is SERVER-ONLY (read by the /api/game/:id/map route, which only returns answers the player has already been
shown). Never copy it to public/ — together with the question ids it would be an answer catalog.
"""

from __future__ import annotations

import json

from . import PROJECT_ROOT
from .http import fetch_json
from .model import Candidate
from .sources import ckan, gtfs, osm, wikidata

GEO_FILE = PROJECT_ROOT / "data" / "generated" / "answer-geo.json"
# Québec, generously: anything outside is a data error and is dropped.
QC_BBOX = (-80.0, 44.9, -57.0, 63.0)
# Greater Montréal: island/city/agglomeration/greater-scope answers outside it are dropped too.
MTL_BBOX = (-74.4, 45.2, -73.1, 45.95)


def _inside(lon: float, lat: float, box: tuple[float, float, float, float]) -> bool:
    return box[0] <= lon <= box[2] and box[1] <= lat <= box[3]


def _wd_coords(qids: list[str]) -> dict[str, tuple[float, float]]:
    import hashlib

    qids = sorted(set(qids))
    out: dict[str, tuple[float, float]] = {}
    for i in range(0, len(qids), 1500):
        chunk = qids[i : i + 1500]
        key = "wd-coords-" + hashlib.sha256(" ".join(chunk).encode()).hexdigest()[:12]
        q = "SELECT ?item ?c WHERE { VALUES ?item { %s } ?item wdt:P625 ?c . }" % " ".join(f"wd:{x}" for x in chunk)
        data, _ = fetch_json(key, wikidata.ENDPOINT, post={"query": q, "format": "json"}, timeout=180)
        for b in data["results"]["bindings"]:  # type: ignore[index]
            qid = b["item"]["value"].rsplit("/", 1)[-1]
            pt = b["c"]["value"]  # "Point(lon lat)"
            if qid in out or not pt.startswith("Point("):
                continue
            lon, lat = (float(v) for v in pt[6:-1].split())
            out[qid] = (lon, lat)
    return out


def _ref_tables(ctx) -> dict[str, dict[str, tuple[float, float]]]:
    from .templates.expansion import EXO_URL
    from .templates.wikilists import _registry_open

    t: dict[str, dict[str, tuple[float, float]]] = {}
    t["gtfs"] = {s.parent_id: (s.lon, s.lat) for s in ctx.metro.stations.values()}
    t["gtfs-rem"] = {s.parent_id: (s.lon, s.lat) for s in ctx.rem.stations.values()}
    t["gtfs-exo"] = {s.parent_id: (s.lon, s.lat) for s in gtfs.load_rail("exo-trains-gtfs", EXO_URL, {"2"}).stations.values()}
    reg, _ = _registry_open()
    t["mtl-food"] = {r["business_id"]: (float(r["longitude"]), float(r["latitude"])) for r in reg if r["latitude"] and r["longitude"]}
    f, _ = ckan.resource("jardins-communautaires", fmt="csv")
    t["mtl-jardin"] = {r["id"]: (float(r["longitude"]), float(r["latitude"])) for r in ckan.read_csv(f) if r["latitude"] and r["longitude"]}
    pois, _ = osm.food_pois()
    t["osm"] = {p["id"]: (p["lon"], p["lat"]) for p in pois}
    return t


def write_answer_geo(cands: list[Candidate], ctx, log=print) -> dict:
    tables = _ref_tables(ctx)
    qids = [r.split(":", 1)[1] for c in cands for a in c.answers for r in a.refs if r.startswith("wikidata:")]
    wd = _wd_coords(qids)
    out: dict[str, dict[str, list]] = {}
    stats = {"answers": 0, "located": 0, "dropped_outside": 0}
    for c in cands:
        box = QC_BBOX if c.scope == "province" else MTL_BBOX
        for a in c.answers:
            stats["answers"] += 1
            pt, basis = (a.geo, a.geo_basis) if a.geo else (None, None)
            if pt is None:
                for r in a.refs:
                    kind, _, rid = r.partition(":")
                    if kind in tables and rid in tables[kind]:
                        pt, basis = tables[kind][rid], kind
                        break
            if pt is None:
                for r in a.refs:
                    if r.startswith("wikidata:") and r[9:] in wd:
                        pt, basis = wd[r[9:]], "wikidata-P625"
                        break
            if pt is None:
                continue
            if not _inside(pt[0], pt[1], box):
                stats["dropped_outside"] += 1
                continue
            out.setdefault(c.id, {})[a.id] = [round(pt[0], 6), round(pt[1], 6), basis]
            stats["located"] += 1
    GEO_FILE.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":"), sort_keys=True) + "\n", "utf-8")
    log(f"answer geo: {stats['located']}/{stats['answers']} answers located ({stats['dropped_outside']} outside their scope's box dropped)")
    return stats
