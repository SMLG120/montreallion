"""City of Montréal open data portal (donnees.montreal.ca, CKAN). Licence checked per dataset via the API."""

from __future__ import annotations

import csv
import io
import json

from ..http import Fetched, fetch, fetch_json

API = "https://donnees.montreal.ca/api/3/action/package_show"
PORTAL = "https://donnees.montreal.ca/dataset/"
ALLOWED_LICENCES = {"cc-by", "CC-BY-4.0", "cc-by-4.0"}


def resource(dataset: str, *, fmt: str, name_contains: str = "", refresh: bool = False) -> tuple[Fetched, dict]:
    """Resolve a dataset's resource via the CKAN API, verify its licence, and download it."""
    meta, _ = fetch_json(f"ckan-meta-{dataset}", API, params={"id": dataset}, refresh=refresh)
    pkg = meta["result"]  # type: ignore[index]
    if pkg.get("license_id") not in ALLOWED_LICENCES:
        raise RuntimeError(f"{dataset}: licence {pkg.get('license_id')!r} is not on the allow-list")
    for r in pkg["resources"]:
        if r["format"].lower() == fmt.lower() and name_contains.lower() in (r.get("name") or "").lower():
            f = fetch(f"ckan-{dataset}-{r['id'][:8]}", r["url"], suffix="." + fmt.lower(), refresh=refresh)
            info = {
                "title": f"{pkg['title']} (Ville de Montréal)",
                "url": PORTAL + dataset,
                "license": pkg.get("license_title") or "CC BY 4.0",
                "retrieved": f.retrieved,
            }
            return f, info
    raise RuntimeError(f"{dataset}: no {fmt} resource matching {name_contains!r}")


def read_csv(f: Fetched) -> list[dict[str, str]]:
    raw = f.path.read_bytes()
    for enc in ("utf-8-sig", "cp1252", "latin-1"):
        try:
            text = raw.decode(enc)
            break
        except UnicodeDecodeError:
            continue
    sample = text[:4096]
    dialect = csv.Sniffer().sniff(sample, delimiters=",;")
    return list(csv.DictReader(io.StringIO(text), dialect=dialect))


def read_json(f: Fetched) -> object:
    return json.loads(f.path.read_text("utf-8-sig"))
