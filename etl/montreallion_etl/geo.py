"""Minimal planar geometry for GeoJSON (WGS84). Adequate at city scale for point-in-polygon tests."""

from __future__ import annotations

import math

Ring = list[list[float]]


def _in_ring(x: float, y: float, ring: Ring) -> bool:
    inside = False
    n = len(ring)
    j = n - 1
    for i in range(n):
        xi, yi = ring[i][0], ring[i][1]
        xj, yj = ring[j][0], ring[j][1]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / ((yj - yi) or 1e-18) + xi:
            inside = not inside
        j = i
    return inside


def _polygons(geom: dict) -> list[list[Ring]]:
    if geom["type"] == "Polygon":
        return [geom["coordinates"]]
    if geom["type"] == "MultiPolygon":
        return geom["coordinates"]
    return []


def contains(geom: dict, lon: float, lat: float) -> bool:
    for poly in _polygons(geom):
        if poly and _in_ring(lon, lat, poly[0]) and not any(_in_ring(lon, lat, hole) for hole in poly[1:]):
            return True
    return False


def centroid(geom: dict) -> tuple[float, float] | None:
    """Area-weighted centroid of the largest polygon's outer ring (falls back to vertex mean)."""
    polys = _polygons(geom)
    if not polys:
        return None
    ring = max((p[0] for p in polys if p), key=lambda r: abs(_area(r)), default=None)
    if not ring:
        return None
    a = _area(ring)
    if abs(a) < 1e-14:
        xs = [p[0] for p in ring]
        ys = [p[1] for p in ring]
        return sum(xs) / len(xs), sum(ys) / len(ys)
    cx = cy = 0.0
    for i in range(len(ring) - 1):
        x0, y0 = ring[i][0], ring[i][1]
        x1, y1 = ring[i + 1][0], ring[i + 1][1]
        f = x0 * y1 - x1 * y0
        cx += (x0 + x1) * f
        cy += (y0 + y1) * f
    return cx / (6 * a), cy / (6 * a)


def _area(ring: Ring) -> float:
    return sum(ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1] for i in range(len(ring) - 1)) / 2


class AreaIndex:
    """Assigns points to named administrative areas (boroughs / municipalities)."""

    def __init__(self, features: list[tuple[str, dict]]):
        self.features = features
        self.boxes = []
        for name, geom in features:
            xs = [pt[0] for poly in _polygons(geom) for pt in poly[0]]
            ys = [pt[1] for poly in _polygons(geom) for pt in poly[0]]
            self.boxes.append((min(xs), min(ys), max(xs), max(ys)))

    def locate(self, lon: float, lat: float) -> str | None:
        for (name, geom), (x0, y0, x1, y1) in zip(self.features, self.boxes):
            if x0 <= lon <= x1 and y0 <= lat <= y1 and contains(geom, lon, lat):
                return name
        return None

    def near_boundary(self, lon: float, lat: float, eps: float = 0.0015) -> bool:
        """True if moving ~150 m in any direction changes the assigned area (borderline cases for review)."""
        here = self.locate(lon, lat)
        for dx, dy in ((eps, 0), (-eps, 0), (0, eps), (0, -eps), (eps, eps), (-eps, -eps), (eps, -eps), (-eps, eps)):
            if self.locate(lon + dx, lat + dy * 0.7) != here:
                return True
        return False


def mtm8_to_lonlat(x: float, y: float) -> tuple[float, float]:
    """EPSG:2950 (NAD83(CSRS) / MTM zone 8) → WGS84-ish lon/lat (sub-metre; NAD83≈WGS84 here).

    Inverse transverse Mercator (Snyder 1987, eq. 8-12…8-25): GRS80, lon0 −73.5°, k0 0.9999, FE 304800.
    """
    import math

    a, f = 6378137.0, 1 / 298.257222101
    e2 = f * (2 - f)
    ep2 = e2 / (1 - e2)
    k0, lon0, fe = 0.9999, math.radians(-73.5), 304800.0
    m = y / k0
    mu = m / (a * (1 - e2 / 4 - 3 * e2**2 / 64 - 5 * e2**3 / 256))
    e1 = (1 - math.sqrt(1 - e2)) / (1 + math.sqrt(1 - e2))
    p1 = mu + (3 * e1 / 2 - 27 * e1**3 / 32) * math.sin(2 * mu) + (21 * e1**2 / 16 - 55 * e1**4 / 32) * math.sin(4 * mu)
    p1 += (151 * e1**3 / 96) * math.sin(6 * mu) + (1097 * e1**4 / 512) * math.sin(8 * mu)
    c1 = ep2 * math.cos(p1) ** 2
    t1 = math.tan(p1) ** 2
    n1 = a / math.sqrt(1 - e2 * math.sin(p1) ** 2)
    r1 = a * (1 - e2) / (1 - e2 * math.sin(p1) ** 2) ** 1.5
    d = (x - fe) / (n1 * k0)
    lat = p1 - (n1 * math.tan(p1) / r1) * (
        d**2 / 2 - (5 + 3 * t1 + 10 * c1 - 4 * c1**2 - 9 * ep2) * d**4 / 24 + (61 + 90 * t1 + 298 * c1 + 45 * t1**2 - 252 * ep2 - 3 * c1**2) * d**6 / 720
    )
    lon = lon0 + (d - (1 + 2 * t1 + c1) * d**3 / 6 + (5 - 2 * c1 + 28 * t1 - 3 * c1**2 + 8 * ep2 + 24 * t1**2) * d**5 / 120) / math.cos(p1)
    return math.degrees(lon), math.degrees(lat)


# ---------------------------------------------------------------- map output helpers (phase D)
def _perp(p, a, b) -> float:
    (x, y), (x1, y1), (x2, y2) = p, a, b
    dx, dy = x2 - x1, y2 - y1
    if dx == 0 and dy == 0:
        return math.hypot(x - x1, y - y1)
    t = max(0.0, min(1.0, ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy)))
    return math.hypot(x - (x1 + t * dx), y - (y1 + t * dy))


def simplify(line: list, tol: float) -> list:
    """Douglas–Peucker on [lon, lat] points (tol in degrees, iterative so long lines don't hit the recursion limit)."""
    if len(line) < 3:
        return [list(p) for p in line]
    keep = [False] * len(line)
    keep[0] = keep[-1] = True
    stack = [(0, len(line) - 1)]
    while stack:
        i, j = stack.pop()
        best, idx = -1.0, -1
        for k in range(i + 1, j):
            d = _perp(line[k], line[i], line[j])
            if d > best:
                best, idx = d, k
        if best > tol:
            keep[idx] = True
            stack += [(i, idx), (idx, j)]
    return [list(p) for p, k in zip(line, keep) if k]


def round_coords(obj, nd: int = 5):
    """Round nested coordinate arrays (5 decimals ≈ 1 m) to shrink GeoJSON."""
    if isinstance(obj, (int, float)):
        return round(obj, nd)
    return [round_coords(x, nd) for x in obj]


def simplify_geometry(geom: dict, tol: float) -> dict | None:
    """Simplify (Multi)Polygon / (Multi)LineString; rings that collapse below 4 points are dropped."""
    t = geom["type"]
    if t == "Polygon":
        rings = [r for r in (simplify(r, tol) for r in geom["coordinates"]) if len(r) >= 4]
        return {"type": t, "coordinates": round_coords(rings)} if rings else None
    if t == "MultiPolygon":
        polys = []
        for poly in geom["coordinates"]:
            rings = [r for r in (simplify(r, tol) for r in poly) if len(r) >= 4]
            if rings:
                polys.append(rings)
        return {"type": t, "coordinates": round_coords(polys)} if polys else None
    if t == "LineString":
        return {"type": t, "coordinates": round_coords(simplify(geom["coordinates"], tol))}
    if t == "MultiLineString":
        return {"type": t, "coordinates": round_coords([simplify(l, tol) for l in geom["coordinates"]])}
    return geom
