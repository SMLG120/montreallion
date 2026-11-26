"""Phase H helpers: editorial difficulty rules, Wikidata name variants, borough adjacency, answer caps."""

from __future__ import annotations

import json
import unittest
from types import SimpleNamespace

from montreallion_etl import GENERATED_FILE
from montreallion_etl.difficulty import assign_difficulty, for_concept
from montreallion_etl.model import Answer, Candidate
from montreallion_etl.pipeline import dedupe, validate
from montreallion_etl.templates.phaseh import ADJ_MIN_M, LARGE_SET_TEMPLATES, _variants, adjacency

SRC = {"title": "t", "url": "https://example.org", "license": "CC0 1.0", "retrieved": "2026-11-26"}


def cand(template: str, concept: str, n: int, difficulty: str | None = None) -> Candidate:
    return Candidate(
        id="gen-x", template=template, concept=concept, category="sports", scope="city",
        prompt={"en": "Name something here.", "fr": "Nommez quelque chose ici."}, eligibility={"en": "Things.", "fr": "Choses."},
        sources=[SRC], answers=[Answer(en=f"Answer number {i}", signal=i) for i in range(n)], est_basis="x", difficulty=difficulty,
    )


class Difficulty(unittest.TestCase):
    def test_every_published_concept_has_a_rule_or_template_value(self):
        for q in json.loads(GENERATED_FILE.read_text("utf-8"))["questions"]:
            self.assertIn(q.get("difficulty"), ("easy", "medium", "hard"), q["id"])

    def test_rules_cover_examples(self):
        self.assertEqual(for_concept("metro-line:2"), "easy")
        self.assertEqual(for_concept("park-in:Verdun"), "medium")
        self.assertEqual(for_concept("ev:ridm-film"), "hard")
        self.assertEqual(for_concept("nhs-in:__island__"), "medium")
        self.assertEqual(for_concept("nhs-in:Ville-Marie"), "hard")
        self.assertEqual(for_concept("food:cafe-in-Verdun"), "hard")

    def test_template_value_is_kept_and_missing_value_is_an_issue(self):
        c = cand("wikidata-relation", "metro-line:2", 6, "hard")
        assign_difficulty(c)
        self.assertEqual(c.difficulty, "hard")  # a rule never overrides the template
        c2 = cand("wikidata-relation", "unknown:concept", 6)
        assign_difficulty(c2)
        dedupe(c2)
        validate(c2)
        self.assertTrue(any("difficulty" in i for i in c2.issues))

    def test_difficulty_does_not_change_the_content_hash(self):
        a, b = cand("x", "y", 5, "easy"), cand("x", "y", 5, "hard")
        self.assertEqual(a.content_hash(), b.content_hash())


class Variants(unittest.TestCase):
    def test_keeps_name_variants_drops_unrelated(self):
        v = _variants("Maurice Richard", ["Rocket Richard", "The Rocket", "Joseph Henri Maurice Richard", "Q123", "maurice richard", "a/b Richard"])
        self.assertIn("Rocket Richard", v)
        self.assertIn("Joseph Henri Maurice Richard", v)
        self.assertNotIn("The Rocket", v)  # shares no word with the label: could be anyone's nickname
        self.assertNotIn("maurice richard", v)  # same as the label
        self.assertNotIn("Q123", v)
        self.assertNotIn("a/b Richard", v)


class Caps(unittest.TestCase):
    def test_large_relationship_sets_allowed_others_capped(self):
        big = cand("wikidata-relation", "wd:x", 450, "easy")
        dedupe(big)
        validate(big)
        self.assertFalse(any("max" in i for i in big.issues))
        self.assertGreaterEqual(LARGE_SET_TEMPLATES["wikidata-relation"], 900)
        other = cand("museum-list", "museum:x", 450, "easy")
        dedupe(other)
        validate(other)
        self.assertTrue(any("max 400" in i for i in other.issues))


def square(x0: float, y0: float, size_deg: float) -> dict:
    return {"type": "Polygon", "coordinates": [[[x0, y0], [x0 + size_deg, y0], [x0 + size_deg, y0 + size_deg], [x0, y0 + size_deg], [x0, y0]]]}


class Adjacency(unittest.TestCase):
    def ctx(self, *shapes):
        return SimpleNamespace(areas=[SimpleNamespace(name=n, geom=g) for n, g in shapes])

    def test_shared_edge_corner_and_gap(self):
        s = 0.01  # ~780 m wide
        ctx = self.ctx(
            ("A", square(-73.60, 45.50, s)),
            ("B", square(-73.60 + s, 45.50, s)),  # shares A's east edge
            ("C", square(-73.60 + s, 45.50 + s, s)),  # touches A only at a corner; shares B's north edge
            ("D", square(-73.60 - s - 0.002, 45.50, s)),  # ~150 m gap west of A
        )
        adj = adjacency(ctx)  # type: ignore[arg-type]
        self.assertEqual(adj["A"], {"B"})
        self.assertEqual(adj["B"], {"A", "C"})
        self.assertNotIn("D", adj)
        self.assertGreater(780, ADJ_MIN_M)


if __name__ == "__main__":
    unittest.main()
