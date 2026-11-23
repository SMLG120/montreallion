"""Phase C helpers: MTM-8 projection, Wikipedia wikitext parsing, registry name keys, MIN-5 rule."""

from __future__ import annotations

import unittest

from montreallion_etl import geo
from montreallion_etl.model import Answer, Candidate
from montreallion_etl.pipeline import dedupe, validate
from montreallion_etl.sources import wikipedia
from montreallion_etl.templates.expansion import _same_thing
from montreallion_etl.templates.wikilists import _bullet_item, _registry_key, compact

SRC = {"title": "t", "url": "https://example.org", "license": "CC BY 4.0", "retrieved": "2026-11-23"}


class Mtm8(unittest.TestCase):
    def test_known_points(self):
        # The central meridian at the false easting maps to −73.5°; latitude from a published MTM-8 example point.
        lon, lat = geo.mtm8_to_lonlat(304800.0, 5040000.0)
        self.assertAlmostEqual(lon, -73.5, places=6)
        self.assertTrue(45.4 < lat < 45.6)
        # ~1 km east of the meridian is ~0.0128° of longitude at Montréal's latitude.
        lon2, lat2 = geo.mtm8_to_lonlat(305800.0, 5040000.0)
        self.assertAlmostEqual(lon2 - lon, 1000 / (111320 * 0.7), delta=0.0005)
        self.assertAlmostEqual(lat2, lat, places=4)


    def test_habitat_67_lands_on_its_real_location(self):
        import json as _json
        import math

        from montreallion_etl.http import _load_manifest

        entry = next((v for k, v in _load_manifest().items() if k.startswith("ckan-sites-immeubles-proteges-lpc")), None)
        if not entry:
            self.skipTest("LPC dataset not cached")
        feats = _json.loads(open(entry["path"], encoding="utf-8-sig").read())["features"]
        hab = next(f for f in feats if f["properties"]["Nom"] == "Habitat 67")
        lon, lat = geo.mtm8_to_lonlat(*geo.centroid(hab["geometry"]))
        # Habitat 67, 2600 av. Pierre-Dupuy: ≈ 45.4996 N, 73.5440 W.
        d = math.hypot((lon + 73.5440) * 111320 * math.cos(math.radians(45.5)), (lat - 45.4996) * 110540)
        self.assertLess(d, 300)


class Wikitext(unittest.TestCase):
    def test_plain_strips_markup(self):
        s = "[[Fichier:X.jpg|25px|link=Parcs Canada]] [[Notre-Dame Basilica (Montreal)|Notre-Dame]]<ref>{{cite|a}}</ref> ''x''"
        self.assertEqual(wikipedia.plain(s), "Notre-Dame x")
        self.assertEqual(wikipedia.link_targets("[[Montreal Museum of Fine Arts#Pavilion|Erskine]]"), ["Montreal Museum of Fine Arts"])

    def test_tables_row_headers_and_attributes(self):
        wt = '{| class="wikitable"\n! Name !! Type\n|-\n! scope="row" | [[Musée A]]\n| style="x" | Art\n|-\n| B || History\n|}'
        rows = wikipedia.tables(wt)[0]
        self.assertEqual([wikipedia.plain(c) for c in rows[1]], ["Musée A", "Art"])
        self.assertEqual([wikipedia.plain(c) for c in rows[2]], ["B", "History"])

    def test_bullets(self):
        self.assertEqual(_bullet_item("* [[Festival international de jazz de Montréal]] (FIJM)").label, "Festival international de jazz de Montréal")
        self.assertEqual(_bullet_item("* [[Black & Blue (festival)|Black & Blue]]").title, "Black & Blue (festival)")
        self.assertEqual(_bullet_item("* Festival d'art vocal de Montréal").label, "Festival d'art vocal de Montréal")
        self.assertIsNone(_bullet_item("* [http://example.org lien]"))


class Matching(unittest.TestCase):
    def test_registry_key(self):
        self.assertEqual(_registry_key("RESTAURANT JOE BEEF (NOTRE-DAME)"), _registry_key("Joe Beef"))
        self.assertEqual(_registry_key("CASSE-CROUTE WILENSKY'S"), _registry_key("Wilensky's"))
        self.assertEqual(_registry_key("RESTAURANT LA BANQUISE INC."), _registry_key("La Banquise"))

    def test_compact_alias_keys(self):
        self.assertEqual(compact("Pont Jacques-Cartier"), "pontjacquescartier")
        self.assertEqual(compact("Festival international de jazz de Montréal"), "festivalinternationaldejazzdemontreal")

    def test_same_thing_guards_wrong_links(self):
        self.assertFalse(_same_thing("Erskine and American United Church", "Montreal Museum of Fine Arts"))
        self.assertTrue(_same_thing("Notre-Dame Roman Catholic Church / Basilica", "Notre-Dame Basilica"))


class FoodAndEvents(unittest.TestCase):
    def test_lien_template_and_bold_are_cleaned(self):
        from montreallion_etl.templates.events import _link_or_text

        r = _link_or_text("{{Lien|langue=de|trad=Heidi Genee|fr=Heidi Genée}}", "fr")
        self.assertEqual(r[0].label, "Heidi Genée")
        self.assertEqual(_link_or_text("\'\'\'[[Valence (groupe)|Valence]]\'\'\'", "fr")[0].label, "Valence")

    def test_food_answers_merge_restaurant_prefix_and_chains(self):
        from montreallion_etl.templates.food import Place, _answers

        ps = [
            Place("Restaurant Amir", {}, "Verdun", "node/1", "11", "Restaurant"),
            Place("Amir", {"brand:wikidata": "Q1"}, "Verdun", "node/2", "12", "Restaurant"),
            Place("Chez Lien", {}, "Verdun", "node/3", "13", "Restaurant"),
        ]
        out = {a.en: a for a in _answers(ps)}
        self.assertEqual(set(out), {"Amir", "Chez Lien"})
        self.assertIn("Restaurant Amir", out["Amir"].aliases)
        self.assertIn("wikidata:Q1", out["Amir"].refs)
        self.assertGreater(out["Amir"].signal, out["Chez Lien"].signal)  # 2 open locations + brand

    def test_duplicate_sources_collapse(self):
        c = Candidate(
            id="gen-y", template="wikipedia-event", concept="y", category="festivals", scope="island",
            prompt={"en": "Name a thing.", "fr": "Nommez une chose."}, eligibility={"en": "e", "fr": "f"}, sources=[SRC, dict(SRC)],
            answers=[Answer(en=n) for n in ["Alpha", "Bravo", "Charlie", "Delta", "Echo"]], est_basis="x",
        )
        dedupe(c)
        self.assertEqual(len(c.sources), 1)


class MinFive(unittest.TestCase):
    def test_phase_c_templates_need_five_answers(self):
        c = Candidate(
            id="gen-x", template="museum-list", concept="x", category="history", scope="island",
            prompt={"en": "Name a thing.", "fr": "Nommez une chose."}, eligibility={"en": "e", "fr": "f"}, sources=[SRC],
            answers=[Answer(en=n, signal=i) for i, n in enumerate(["Alpha", "Bravo", "Charlie", "Delta"])], est_basis="x",
        )
        validate(c)
        self.assertTrue(any("5+" in i for i in c.issues))


if __name__ == "__main__":
    unittest.main()
