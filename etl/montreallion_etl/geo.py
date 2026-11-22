"""Minimal planar geometry for GeoJSON (WGS84). Adequate at city scale for point-in-polygon tests."""

from __future__ import annotations

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
