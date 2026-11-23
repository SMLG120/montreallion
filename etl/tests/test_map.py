"""Phase D map helpers: route classification, line merging, simplification."""

from __future__ import annotations

import unittest

from montreallion_etl import geo
from montreallion_etl.mapdata import _merge_lines, route_ref


class Roads(unittest.TestCase):
    def test_route_refs(self):
        self.assertEqual(route_ref("40"), ("autoroute", "A-40"))
        self.assertEqual(route_ref("A 13"), ("autoroute", "A-13"))
        self.assertEqual(route_ref("520"), ("autoroute", "A-520"))
        self.assertEqual(route_ref("138"), ("route", "R-138"))
        self.assertEqual(route_ref("335"), ("route", "R-335"))
        self.assertIsNone(route_ref("Boulevard"))

    def test_merge_lines_joins_touching_ways(self):
        a = [[0, 0], [1, 0]]
        b = [[1, 0], [2, 0]]
        c = [[5, 5], [6, 6]]
        merged = sorted(_merge_lines([b, c, a]), key=len)
        self.assertEqual(merged, [[[5, 5], [6, 6]], [[0, 0], [1, 0], [2, 0]]])

    def test_simplify_keeps_endpoints_and_drops_collinear(self):
        line = [[0, 0], [1, 0.00001], [2, 0], [3, 0.00001], [4, 0]]
        self.assertEqual(geo.simplify(line, 0.001), [[0, 0], [4, 0]])
        poly = {"type": "Polygon", "coordinates": [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]]}
        self.assertEqual(geo.simplify_geometry(poly, 0.01)["coordinates"][0][0], [0, 0])


if __name__ == "__main__":
    unittest.main()
