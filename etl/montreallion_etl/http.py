"""Cached, reproducible HTTP fetching.

Every raw download is stored under .cache/raw/ with a manifest entry recording the
URL, retrieval time and sha256, so a build can be re-run offline and audited.
"""

from __future__ import annotations

import hashlib
import json
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path

from . import CACHE_DIR, USER_AGENT

RAW_DIR = CACHE_DIR / "raw"
MANIFEST = CACHE_DIR / "manifest.json"
MAX_BYTES = 200 * 1024 * 1024


@dataclass(frozen=True)
class Fetched:
    key: str
    url: str
    path: Path
    sha256: str
    retrieved: str  # ISO date


def _load_manifest() -> dict:
    if MANIFEST.exists():
        return json.loads(MANIFEST.read_text("utf-8"))
    return {}


def _save_manifest(m: dict) -> None:
    MANIFEST.parent.mkdir(parents=True, exist_ok=True)
    MANIFEST.write_text(json.dumps(m, indent=2, sort_keys=True), "utf-8")


# Polite per-host minimum spacing between requests (WDQS currently allows ~1 req/min).
MIN_INTERVAL = {"query.wikidata.org": 62.0}
_last_request: dict[str, float] = {}


def _throttle(host: str) -> None:
    gap = MIN_INTERVAL.get(host)
    if not gap:
        return
    stamp = CACHE_DIR / f".last-{host}"
    last = _last_request.get(host) or (float(stamp.read_text()) if stamp.exists() else 0.0)
    wait = last + gap - time.time()
    if wait > 0:
        print(f"  … waiting {wait:.0f}s for {host} rate limit")
        time.sleep(wait)
    _last_request[host] = time.time()
    stamp.parent.mkdir(parents=True, exist_ok=True)
    stamp.write_text(str(_last_request[host]))


def fetch(
    key: str,
    url: str,
    *,
    refresh: bool = False,
    suffix: str = "",
    params: dict | None = None,
    post: dict | None = None,
    timeout: int = 120,
) -> Fetched:
    """Download `url` once into the cache under a stable `key` (re-used unless refresh=True)."""
    manifest = _load_manifest()
    entry = manifest.get(key)
    if entry and not refresh and Path(entry["path"]).exists():
        return Fetched(key, entry["url"], Path(entry["path"]), entry["sha256"], entry["retrieved"])

    full = url + ("?" + urllib.parse.urlencode(params) if params else "")
    body = urllib.parse.urlencode(post).encode() if post else None
    headers = {"User-Agent": USER_AGENT, "Accept": "application/sparql-results+json, application/json, */*"}
    if body:
        headers["Content-Type"] = "application/x-www-form-urlencoded"
    host = urllib.parse.urlparse(full).hostname or ""
    last_err: Exception | None = None
    for attempt in range(4):
        _throttle(host)
        try:
            req = urllib.request.Request(full, data=body, headers=headers)
            with urllib.request.urlopen(req, timeout=timeout) as resp:  # follows redirects
                data = resp.read(MAX_BYTES + 1)
            break
        except urllib.error.HTTPError as e:
            last_err = e
            if e.code in (429, 503):
                retry = e.headers.get("Retry-After")
                time.sleep(float(retry) if retry and retry.isdigit() else 65)
            elif e.code >= 500:
                time.sleep(5 * (attempt + 1))
            else:
                break
        except Exception as e:  # network hiccup: back off and retry
            last_err = e
            time.sleep(5 * (attempt + 1))
    else:
        raise RuntimeError(f"fetch failed for {key}: {last_err}")
    if last_err is not None and "data" not in locals():
        raise RuntimeError(f"fetch failed for {key}: {last_err}")
    if len(data) > MAX_BYTES:
        raise RuntimeError(f"{key}: response exceeds {MAX_BYTES} bytes")
    if data[:15].lower().startswith(b"<!doctype html") and not suffix.endswith("html"):
        raise RuntimeError(f"{key}: got an HTML page instead of data from {full[:120]}")

    RAW_DIR.mkdir(parents=True, exist_ok=True)
    digest = hashlib.sha256(data).hexdigest()
    path = RAW_DIR / f"{key}{suffix}"
    path.write_bytes(data)
    retrieved = time.strftime("%Y-%m-%d")
    if post:
        full += "#post:" + hashlib.sha256(body or b"").hexdigest()[:12]
    manifest[key] = {"url": full, "path": str(path), "sha256": digest, "retrieved": retrieved, "bytes": len(data)}
    _save_manifest(manifest)
    return Fetched(key, full, path, digest, retrieved)


def fetch_json(key: str, url: str, **kw) -> tuple[object, Fetched]:
    f = fetch(key, url, suffix=kw.pop("suffix", ".json"), **kw)
    return json.loads(f.path.read_text("utf-8")), f
