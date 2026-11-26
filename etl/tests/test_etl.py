"""ETL unit tests (stdlib unittest). Run from etl/:  python3 -m unittest discover -s tests -v"""

from __future__ import annotations

import json
import unittest

from montreallion_etl import CACHE_DIR, PROJECT_ROOT, geo
from montreallion_etl.model import Answer, Candidate
from montreallion_etl.normalize import normalize_answer, slugify
from montreallion_etl.difficulty import assign_difficulty
from montreallion_etl.pipeline import assign_est, dedupe, validate, verify_seed
from montreallion_etl.review import apply_decisions
from montreallion_etl.templates import de

SRC = {"title": "t", "url": "https://example.org", "license": "CC BY 4.0", "retrieved": "2026-11-21"}


def cand(answers: list[Answer], **kw) -> Candidate:
    base = dict(
        id="gen-test",
        template="test",
        concept="test",
        category="parks",
        difficulty="medium",
        scope="city",
        prompt={"en": "Name a test thing.", "fr": "Nommez une chose test."},
        eligibility={"en": "Things.", "fr": "Choses."},
        sources=[SRC],
        answers=answers,
        est_basis="test",
    )
    base.update(kw)
    return Candidate(**base)


class NormalizeParity(unittest.TestCase):
    def test_matches_typescript_fixtures(self):
        fixtures = json.loads((PROJECT_ROOT / "data" / "normalize-fixtures.json").read_text("utf-8"))
        self.assertGreater(len(fixtures), 20)
        for f in fixtures:
            self.assertEqual(normalize_answer(f["input"]), f["key"], f["input"])

    def test_slugify(self):
        self.assertEqual(slugify("Côte-des-Neiges–Notre-Dame-de-Grâce"), "cote-des-neiges-notre-dame-de-grace")
        self.assertEqual(slugify("Parc Jolicœur"), "parc-jolicoeur")


class Geo(unittest.TestCase):
    square = {"type": "Polygon", "coordinates": [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]], [[4, 4], [6, 4], [6, 6], [4, 6], [4, 4]]]}

    def test_point_in_polygon_with_hole(self):
        self.assertTrue(geo.contains(self.square, 1, 1))
        self.assertFalse(geo.contains(self.square, 5, 5))  # in the hole
        self.assertFalse(geo.contains(self.square, 11, 1))

    def test_area_index_and_boundary(self):
        left = {"type": "Polygon", "coordinates": [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]]}
        right = {"type": "Polygon", "coordinates": [[[1, 0], [2, 0], [2, 1], [1, 1], [1, 0]]]}
        idx = geo.AreaIndex([("L", left), ("R", right)])
        self.assertEqual(idx.locate(0.5, 0.5), "L")
        self.assertEqual(idx.locate(1.5, 0.5), "R")
        self.assertIsNone(idx.locate(3, 3))
        self.assertTrue(idx.near_boundary(0.9995, 0.5))
        self.assertFalse(idx.near_boundary(0.5, 0.5))

    def test_centroid(self):
        c = geo.centroid({"type": "Polygon", "coordinates": [[[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]]]})
        self.assertAlmostEqual(c[0], 1)
        self.assertAlmostEqual(c[1], 1)


class Pipeline(unittest.TestCase):
    def test_dedupe_merges_same_key_and_assigns_unique_slugs(self):
        c = cand([Answer("Parc Jarry", signal=1, refs=["a"]), Answer("Jarry Park", signal=3, refs=["b"]), Answer("Parc Molson", signal=2)])
        dedupe(c)
        self.assertEqual(len(c.answers), 2)
        jarry = next(a for a in c.answers if a.key() == "jarry")
        self.assertEqual(jarry.signal, 3)
        self.assertEqual(jarry.refs, ["a", "b"])
        self.assertEqual(len({a.id for a in c.answers}), 2)

    def test_alias_collisions_become_ambiguous(self):
        c = cand([Answer("Maurice Richard", aliases=["Richard"]), Answer("Henri Richard", aliases=["Richard"]), Answer("Jean Béliveau")])
        dedupe(c)
        validate(c)
        self.assertEqual(c.ambiguous, ["richard"])
        self.assertTrue(all("Richard" not in a.aliases for a in c.answers))
        self.assertEqual(c.issues, [])

    def test_rejects_small_sets_bad_licences_and_missing_french(self):
        c = cand([Answer("A1"), Answer("B2")], sources=[{**SRC, "license": "All rights reserved"}], prompt={"en": "Q", "fr": ""})
        dedupe(c)
        validate(c)
        self.assertEqual(len(c.issues), 3)

    def test_est_is_rank_based_and_bounded(self):
        c = cand([Answer("Alpha", signal=0), Answer("Bravo", signal=5), Answer("Charlie", signal=9), Answer("Delta", signal=9)])
        assign_est(c)
        est = {a.en: a.est for a in c.answers}
        self.assertEqual(est["Alpha"], 5)
        self.assertLess(est["Alpha"], est["Bravo"])
        self.assertEqual(est["Charlie"], est["Delta"])
        self.assertTrue(all(1 <= v <= 100 for v in est.values()))

    def test_flat_signal_warns(self):
        c = cand([Answer("Alpha"), Answer("Bravo"), Answer("Charlie")])
        dedupe(c)
        validate(c)
        self.assertTrue(any("flat" in w for w in c.warnings))

    def test_seed_concepts_are_verified_not_duplicated(self):
        orange = [Answer(n) for n in ["Berri-UQAM", "Jarry", "Snowdon"]]
        gen = cand(orange, concept="metro-line:2", id="gen-metro-line-orange")
        kept, report = verify_seed([gen])
        self.assertEqual(kept, [])
        r = report[0]
        self.assertEqual(r["seed"], "stm-orange-line-station")
        self.assertEqual(r["data_count"], 3)
        self.assertEqual(len(r["only_in_seed"]), 28)
        self.assertEqual(r["only_in_data"], [])


class Review(unittest.TestCase):
    def test_decisions_are_pinned_to_content(self):
        c = cand([Answer("Alpha", est=10), Answer("Bravo"), Answer("Charlie")])
        dedupe(c)
        h = c.content_hash()
        apply_decisions([c], {"gen-test": {"status": "approved", "contentHash": h, "date": "2026-11-21"}})
        self.assertEqual(c.review_status, "approved")
        c2 = cand([Answer("Alpha"), Answer("Bravo"), Answer("Charlie"), Answer("Delta")])
        dedupe(c2)
        apply_decisions([c2], {"gen-test": {"status": "approved", "contentHash": h, "date": "2026-11-21"}})
        self.assertEqual(c2.review_status, "in_review")
        self.assertTrue(any("needs re-review" in w for w in c2.warnings))

    def test_validation_issues_force_rejection(self):
        c = cand([Answer("Alpha")])
        c.issues.append("only 1 answers")
        apply_decisions([c], {"gen-test": {"status": "approved", "contentHash": c.content_hash()}})
        self.assertEqual(c.review_status, "rejected")


class French(unittest.TestCase):
    def test_de_elision_and_contraction(self):
        self.assertEqual(de("Verdun"), "de Verdun")
        self.assertEqual(de("Anjou"), "d'Anjou")
        self.assertEqual(de("Outremont"), "d'Outremont")
        self.assertEqual(de("Le Plateau-Mont-Royal"), "du Plateau-Mont-Royal")
        self.assertEqual(de("Le Sud-Ouest"), "du Sud-Ouest")
        self.assertEqual(de("Ville-Marie"), "de Ville-Marie")


@unittest.skipUnless((CACHE_DIR / "manifest.json").exists(), "needs cached source data (run `build` once)")
class CachedData(unittest.TestCase):
    """Regression checks on the real (cached) datasets — no network needed once cached."""

    @classmethod
    def setUpClass(cls):
        from montreallion_etl.pipeline import load_context
        from montreallion_etl.templates import ALL

        cls.ctx = load_context(log=lambda *_: None)
        cls.cands = [c for t in ALL for c in t(cls.ctx)]
        for c in cls.cands:
            dedupe(c)
            assign_difficulty(c)
            validate(c)
            assign_est(c)

    def test_stm_lines_match_known_station_counts(self):
        counts = {ln: sum(1 for s in self.ctx.metro.stations.values() if ln in s.lines) for ln in "1245"}
        self.assertEqual(counts, {"1": 27, "2": 31, "4": 3, "5": 12})
        self.assertEqual(len(self.ctx.metro.stations), 68)

    def test_termini_exclude_short_turns(self):
        names = {s.name for s in self.ctx.metro.stations.values() if s.termini_of}
        self.assertNotIn("Henri-Bourassa", names)
        self.assertEqual(len(names), 8)

    def test_boroughs_vs_municipalities(self):
        kinds = [a.kind for a in self.ctx.areas]
        self.assertEqual(kinds.count("borough"), 19)
        self.assertEqual(kinds.count("municipality"), 15)

    def test_seed_lists_agree_with_open_data(self):
        _, report = verify_seed(self.cands)
        self.assertEqual(len(report), 6)
        for r in report:
            self.assertEqual((r["only_in_seed"], r["only_in_data"]), ([], []), r["seed"])

    def test_every_candidate_is_valid_and_bilingual(self):
        for c in self.cands:
            self.assertEqual(c.issues, [], c.id)
            self.assertTrue(c.prompt["fr"] and c.prompt["en"] != c.prompt["fr"], c.id)
            self.assertGreaterEqual(len(c.answers), 3, c.id)



class ReviewFixesTest(unittest.TestCase):
    """Regressions found in the first human review (2026-11-21)."""

    def test_gtfs_station_names(self):
        from montreallion_etl.sources.gtfs import _clean

        self.assertEqual(_clean("STATION LONGUEUIL- U. de SHERBROOKE"), "Longueuil–Université-de-Sherbrooke")
        self.assertEqual(_clean("Station Cartier -Zone B"), "Cartier")
        self.assertEqual(_clean("Station Berri-UQAM - Quai 1"), "Berri-UQAM")

    def test_library_network_keeps_only_city_branches(self):
        from montreallion_etl.templates import _in_network

        lib = lambda name: {"name": name, "networks": ["Bibliothèque"]}  # noqa: E731
        self.assertTrue(_in_network(lib("Bibliothèque Frontenac"), "Bibliothèque"))
        self.assertFalse(_in_network(lib("Grande Bibliothèque - Bibliothèque et Archives nationales du Québec"), "Bibliothèque"))
        self.assertFalse(_in_network(lib("Maison culturelle et communautaire de Montréal-Nord"), "Bibliothèque"))
        self.assertTrue(_in_network({"name": "Maison culturelle et communautaire de Montréal-Nord", "networks": ["Salle de spectacle"]}, "Salle de spectacle"))


if __name__ == "__main__":
    unittest.main()
