"""STM static GTFS: the authority for which métro stations are in service and on which line."""

from __future__ import annotations

import csv
import io
import re
import zipfile
from dataclasses import dataclass, field

from ..http import fetch

URL = "https://www.stm.info/sites/default/files/gtfs/gtfs_stm.zip"
SOURCE = {
    "title": "STM — GTFS static schedule data",
    "url": "https://www.stm.info/en/about/developers",
    "license": "CC BY 4.0 (STM open data)",
}
REM_URL = "https://gtfs.gpmmom.ca/gtfs/gtfs.zip"
REM_SOURCE = {
    "title": "REM — GTFS scheduled service (via ARTM open data)",
    "url": "https://donnees.artm.quebec/catalogue/dataset/offres-de-service-planifie-du-reseau-express-metropolitain",
    "license": "CC BY 4.0 (licence file in feed)",
}
LINE_NAMES = {"1": ("Green", "verte"), "2": ("Orange", "orange"), "4": ("Yellow", "jaune"), "5": ("Blue", "bleue")}


@dataclass
class Station:
    parent_id: str
    name: str  # without the "Station " prefix
    lat: float
    lon: float
    lines: set[str] = field(default_factory=set)
    termini_of: set[str] = field(default_factory=set)


@dataclass
class MetroData:
    stations: dict[str, Station]
    feed_version: str
    feed_window: tuple[str, str]
    retrieved: str


# Feed names that no cleanup rule can turn into the official station name.
NAME_FIXES = {"LONGUEUIL- U. de SHERBROOKE": "Longueuil–Université-de-Sherbrooke"}


def _clean(stop_name: str) -> str:
    """'Station Cartier -Zone B' → 'Cartier'; bus stops may add a street in parentheses."""
    s = re.sub(r"^station\s+", "", stop_name, flags=re.IGNORECASE)
    s = re.sub(r"\s*\(.*\)$", "", s)
    s = re.sub(r"\s*-?\s*[Qq]uai \d+$", "", s)
    s = re.sub(r"\s*-\s*Zone [A-Z]$", "", s).strip()
    return NAME_FIXES.get(s, s)


def _rows(z: zipfile.ZipFile, name: str):
    with z.open(name) as fh:
        yield from csv.DictReader(io.TextIOWrapper(fh, "utf-8-sig"))


def load_metro(refresh: bool = False) -> MetroData:
    return load_rail("stm-gtfs", URL, {"1"}, refresh)


def load_rem(refresh: bool = False) -> MetroData:
    return load_rail("rem-gtfs", REM_URL, {"0", "1", "2"}, refresh)


def load_rail(key: str, url: str, route_types: set[str], refresh: bool = False) -> MetroData:
    """Stations (parent stops) served by rail routes of the given GTFS route_types, with lines and termini."""
    f = fetch(key, url, suffix=".zip", refresh=refresh, timeout=600)
    z = zipfile.ZipFile(f.path)
    feed = next(_rows(z, "feed_info.txt"))
    routes = {r["route_id"]: r for r in _rows(z, "routes.txt")}
    metro_routes = {rid for rid, r in routes.items() if r["route_type"] in route_types}
    trip_route = {t["trip_id"]: t["route_id"] for t in _rows(z, "trips.txt") if t["route_id"] in metro_routes}

    stops = {s["stop_id"]: s for s in _rows(z, "stops.txt")}
    stations: dict[str, Station] = {}

    def station_for(stop_id: str) -> Station:
        s = stops[stop_id]
        pid = s.get("parent_station") or stop_id
        if pid not in stations:
            p = stops.get(pid, s)
            # Prefer the parent's name unless it's upper-case (STM), then the child's.
            pname = p["stop_name"]
            name = _clean(s["stop_name"] if pname.isupper() else pname)
            stations[pid] = Station(pid, name, float(p["stop_lat"]), float(p["stop_lon"]))
        return stations[pid]

    # One pass over stop_times (large) collecting each metro trip's endpoints and length.
    first_last: dict[str, list] = {}
    trip_len: dict[str, int] = {}
    for st in _rows(z, "stop_times.txt"):
        route = trip_route.get(st["trip_id"])
        if route is None:
            continue
        station = station_for(st["stop_id"])
        station.lines.add(route)
        seq = int(st["stop_sequence"])
        trip_len[st["trip_id"]] = trip_len.get(st["trip_id"], 0) + 1
        fl = first_last.setdefault(st["trip_id"], [seq, station, seq, station])
        if seq < fl[0]:
            fl[0], fl[1] = seq, station
        if seq > fl[2]:
            fl[2], fl[3] = seq, station
    # Line termini = endpoints of the longest trips on each route (ignores short-turn service).
    longest: dict[str, int] = {}
    for trip, n in trip_len.items():
        longest[trip_route[trip]] = max(longest.get(trip_route[trip], 0), n)
    for trip, (_, first, _, last) in first_last.items():
        if trip_len[trip] == longest[trip_route[trip]]:
            first.termini_of.add(trip_route[trip])
            last.termini_of.add(trip_route[trip])

    return MetroData(stations, feed.get("feed_version", ""), (feed.get("feed_start_date", ""), feed.get("feed_end_date", "")), f.retrieved)


def rail_lines(key: str, url: str, route_types: set[str]) -> list[dict]:
    """One drawable line per rail route: the longest GTFS shape, or (feeds without shapes.txt) the stop
    sequence of the longest trip. Returns [{route_id, short, long, color, coords:[[lon,lat],…]}]."""
    f = fetch(key, url, suffix=".zip", timeout=600)
    z = zipfile.ZipFile(f.path)
    routes = {r["route_id"]: r for r in _rows(z, "routes.txt") if r["route_type"] in route_types}
    trips = [t for t in _rows(z, "trips.txt") if t["route_id"] in routes]
    out = []
    names = set(z.namelist())
    if "shapes.txt" in names and any(t.get("shape_id") for t in trips):
        wanted = {t["shape_id"]: t["route_id"] for t in trips if t.get("shape_id")}
        pts: dict[str, list] = {}
        for r in _rows(z, "shapes.txt"):
            if r["shape_id"] in wanted:
                pts.setdefault(r["shape_id"], []).append((int(r["shape_pt_sequence"]), float(r["shape_pt_lon"]), float(r["shape_pt_lat"])))
        best: dict[str, list] = {}
        for sid, p in pts.items():
            rid = wanted[sid]
            if len(p) > len(best.get(rid, [])):
                best[rid] = p
        lines = {rid: [[x, y] for _, x, y in sorted(p)] for rid, p in best.items()}
    else:
        stops = {s["stop_id"]: s for s in _rows(z, "stops.txt")}
        trip_route = {t["trip_id"]: t["route_id"] for t in trips}
        seqs: dict[str, list] = {}
        for st in _rows(z, "stop_times.txt"):
            if st["trip_id"] in trip_route:
                s = stops[st["stop_id"]]
                seqs.setdefault(st["trip_id"], []).append((int(st["stop_sequence"]), float(s["stop_lon"]), float(s["stop_lat"])))
        lines = {}
        for trip, p in seqs.items():
            rid = trip_route[trip]
            if len(p) > len(lines.get(rid, [])):
                lines[rid] = [[x, y] for _, x, y in sorted(p)]
    for rid, coords in lines.items():
        r = routes[rid]
        color = (r.get("route_color") or "").strip()
        out.append({"route_id": rid, "short": r.get("route_short_name", ""), "long": r.get("route_long_name", ""),
                    "color": f"#{color}" if color else None, "coords": coords})
    return out
