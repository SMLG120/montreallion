"""OpenStreetMap food & drink POIs on/around Montréal Island via the Overpass API (ODbL 1.0, © OpenStreetMap contributors).

Only names, tags and coordinates are reused; every POI used as an answer is additionally required to be OPEN in the
City of Montréal food-establishment registry (name + location match), so OSM never decides eligibility alone.
"""

from __future__ import annotations

import json

from ..http import fetch

URL = "https://overpass-api.de/api/interpreter"
LICENSE = "ODbL 1.0 (© OpenStreetMap contributors)"
BBOX = "45.40,-73.98,45.71,-73.47"  # Montréal Island and the waters around it
QUERY = f"""[out:json][timeout:180];
(
  nwr["amenity"~"^(restaurant|cafe|fast_food|ice_cream|bar|pub)$"]["name"]({BBOX});
  nwr["shop"~"^(bakery|pastry|cheese|chocolate|butcher|seafood|deli|confectionery|coffee|tea|greengrocer|wine)$"]["name"]({BBOX});
  nwr["craft"~"^(brewery|distillery)$"]["name"]({BBOX});
);
out center tags;"""


def food_pois(refresh: bool = False) -> tuple[list[dict], dict]:
    f = fetch("osm-overpass-food", URL, post={"data": QUERY}, refresh=refresh, timeout=240, suffix=".json")
    data = json.loads(f.path.read_text("utf-8"))
    out = []
    for e in data["elements"]:
        lat = e.get("lat") or (e.get("center") or {}).get("lat")
        lon = e.get("lon") or (e.get("center") or {}).get("lon")
        if lat is None or lon is None:
            continue
        out.append({"id": f"{e['type']}/{e['id']}", "lat": float(lat), "lon": float(lon), "tags": e.get("tags", {})})
    src = {
        "title": "OpenStreetMap (Overpass API): food and drink places on Montréal Island",
        "url": "https://www.openstreetmap.org/copyright",
        "license": LICENSE,
        "retrieved": f.retrieved,
    }
    return out, src
