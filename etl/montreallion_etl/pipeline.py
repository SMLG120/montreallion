"""fetch → parse → normalize → deduplicate → validate → (templates) → review → publish."""

from __future__ import annotations

import json
import re
import time
from collections import defaultdict

from . import GENERATED_FILE, OUT_DIR, SEED_FILE, geo
from .model import Answer, Candidate
from .normalize import normalize_answer, slugify
from .review import apply_decisions, load_decisions
from .sources import gtfs, montreal, wikidata
from .difficulty import assign_difficulty
from .templates import ALL, Context
from .templates.phaseh import LARGE_SET_TEMPLATES

MAX_ANSWERS = 400
# Phase C templates: open-ended questions must keep at least 5 valid answers after deduplication.
MIN5_TEMPLATES = {
    "heritage-in-area", "heritage-kind", "community-garden-in-area", "museum-list", "national-historic-site", "exo-line", "exo-island",
    "stm-bus-network", "park-kind", "neighbourhood-in-borough", "metro-opened", "wikipedia-list", "wiki-restaurant-open",
    "food-open-place", "wikipedia-event", "wikidata-relation", "street-in-borough",
}
LICENCE_ALLOW = ("CC BY 4.0", "Creative Commons Attribution 4.0", "CC0", "CC BY-SA 4.0 (facts only reused)", "ODbL 1.0 (© OpenStreetMap contributors)")

# Seed questions that cover the same concept as a template: we verify them instead of duplicating.
SEED_CONCEPTS = {
    "stm-orange-line-station": "metro-line:2",
    "stm-green-line-station": "metro-line:1",
    "stm-blue-line-station": "metro-line:5",
    "stm-transfer-station": "metro-transfer",
    "city-borough": "city-borough",
    "island-reconstituted-municipality": "island-municipality",
}

PAREN = re.compile(r"\s*\([^)]*\)")


# ---------------------------------------------------------------- fetch + parse
def load_context(refresh: bool = False, log=print) -> Context:
    log("fetch/parse: STM GTFS")
    metro = gtfs.load_metro(refresh)
    log("fetch/parse: REM GTFS (ARTM)")
    rem = gtfs.load_rem(refresh)
    log("fetch/parse: City of Montréal datasets")
    areas, limites = montreal.areas(refresh)
    hoods, quartiers = montreal.neighbourhoods(refresh)
    # Official display names (en dashes) come from the neighbourhood file; boundaries use plain hyphens.
    official = {normalize_answer(h["area"]): h["area"] for h in hoods}
    for a in areas:
        a.name = official.get(normalize_answer(a.name), a.name)
    index = geo.AreaIndex([(a.name, a.geom) for a in areas])
    parks, parcs = montreal.parks(index, refresh)
    culture, cult = montreal.cultural_places(refresh)
    art, art_src = montreal.public_art(refresh)
    for rows in (hoods, culture, art):
        for r in rows:
            r["area"] = official.get(normalize_answer(r.get("area", "")), r.get("area", ""))
    log("fetch: Wikidata (rate-limited, cached)")
    wd_places, wd_date = wikidata.places(refresh)
    wd_stations, _ = wikidata.stations(refresh)
    artists = sorted({a for w in art for a in w["artists"]})
    wd_people, _ = wikidata.people(artists, "wd-visual-artists", refresh)
    gtfs_src = {**gtfs.SOURCE, "retrieved": metro.retrieved}
    return Context(
        metro=metro,
        rem=rem,
        areas=areas,
        area_index=index,
        neighbourhoods=hoods,
        parks=parks,
        culture=culture,
        art=art,
        wd_places=wd_places,
        wd_stations=wd_stations,
        wd_people=wd_people,
        src={
            "gtfs": gtfs_src,
            "rem": {**gtfs.REM_SOURCE, "retrieved": rem.retrieved},
            "limites": limites,
            "quartiers": quartiers,
            "parcs": parcs,
            "culture": cult,
            "art": art_src,
            "wikidata": {**wikidata.SOURCE, "retrieved": wd_date},
        },
    )


# ---------------------------------------------------------------- normalize + dedupe
def clean_label(s: str) -> str:
    s = PAREN.sub("", s).replace("’", "'")
    return re.sub(r"\s+", " ", s).strip(" -")


def dedupe(c: Candidate) -> None:
    """Merge answers that normalize to the same key (e.g. a park split into several polygons); one entry per source URL."""
    c.sources = list({s["url"]: s for s in c.sources}.values())
    merged: dict[str, Answer] = {}
    for a in c.answers:
        a.en = clean_label(a.en)
        a.fr = clean_label(a.fr) if a.fr else None
        a.aliases = [clean_label(x) for x in a.aliases if clean_label(x)]
        k = a.key()
        if not k:
            continue
        if k in merged:
            m = merged[k]
            m.signal = max(m.signal, a.signal)
            m.refs = sorted(set(m.refs + a.refs))
            m.aliases = sorted(set(m.aliases + a.aliases))
            if m.geo is None and a.geo is not None:
                m.geo, m.geo_basis = a.geo, a.geo_basis
        else:
            merged[k] = a
    c.answers = sorted(merged.values(), key=lambda a: a.key())
    used: set[str] = set()
    for a in c.answers:
        base = slugify(a.fr or a.en)
        slug, i = base, 2
        while slug in used:
            slug, i = f"{base}-{i}", i + 1
        used.add(slug)
        a.id = slug


# ---------------------------------------------------------------- validate
def validate(c: Candidate) -> None:
    if not (c.prompt.get("en") and c.prompt.get("fr")) or c.prompt["en"] == c.prompt["fr"]:
        c.issues.append("prompt must exist in EN and FR")
    for s in c.sources:
        if not any(s["license"].startswith(x) for x in LICENCE_ALLOW):
            c.issues.append(f"licence not allow-listed: {s['license']}")
    if c.template in MIN5_TEMPLATES and len(c.answers) < 5:
        c.issues.append(f"only {len(c.answers)} answers (phase C templates need 5+)")
    if len(c.answers) < 3:
        c.issues.append(f"only {len(c.answers)} answers (min 3)")
    cap = LARGE_SET_TEMPLATES.get(c.template, MAX_ANSWERS)
    if len(c.answers) > cap:
        c.issues.append(f"{len(c.answers)} answers (max {cap})")
    if c.difficulty not in ("easy", "medium", "hard"):
        c.issues.append(f"difficulty missing or invalid: {c.difficulty!r}")

    # Conservative alias hygiene: a key that could mean two answers is removed from both and
    # recorded as ambiguous, so the game asks the player to be more specific instead of guessing.
    canonical = {a.key(): a.id for a in c.answers}
    owners: dict[str, set[str]] = defaultdict(set)
    for a in c.answers:
        for form in a.all_forms():
            k = normalize_answer(form)
            if k:
                owners[k].add(a.id)
    clashes = {k for k, ids in owners.items() if len(ids) > 1}
    for a in c.answers:
        keep = []
        for alias in a.aliases:
            k = normalize_answer(alias)
            if not k or k in clashes and canonical.get(k) != a.id:
                continue
            if k == a.key() or (a.fr and k == normalize_answer(a.fr)):
                continue  # redundant with a label
            keep.append(alias)
        a.aliases = sorted(set(keep))
        if a.fr and normalize_answer(a.fr) in clashes and canonical.get(normalize_answer(a.fr)) != a.id:
            c.issues.append(f"FR label of {a.id!r} collides with another answer")
    c.ambiguous = sorted({k for k in clashes if k not in canonical})
    if any(k in canonical and len(owners[k]) > 1 for k in clashes):
        c.warnings.append("a canonical label equals another answer's alias; alias dropped")

    if len({round(a.signal, 6) for a in c.answers}) == 1:
        c.warnings.append("flat familiarity signal: every answer would score the same")
    if sum(1 for a in c.answers if a.signal == 0) > len(c.answers) / 2:
        c.warnings.append("more than half the answers have no familiarity signal")


def assign_est(c: Candidate) -> None:
    """Rank-based estimate in [5, 95]: higher signal → more familiar → lower rarity score."""
    vals = sorted(a.signal for a in c.answers)
    n = len(vals)
    for a in c.answers:
        below = sum(1 for v in vals if v < a.signal)
        equal = sum(1 for v in vals if v == a.signal)
        rank = (below + (equal - 1) / 2) / (n - 1) if n > 1 else 0.5
        a.est = max(1, min(100, round(5 + 90 * rank)))


# ---------------------------------------------------------------- seed cross-check
def verify_seed(cands: list[Candidate]) -> tuple[list[Candidate], list[dict]]:
    seed = json.loads(SEED_FILE.read_text("utf-8"))["questions"]
    by_concept = {c.concept: c for c in cands}
    report, covered = [], set()
    for q in seed:
        concept = SEED_CONCEPTS.get(q["id"])
        if not concept or concept not in by_concept:
            continue
        covered.add(concept)
        gen = by_concept[concept]

        def keys(answers, *, generated: bool):
            out = {}
            for a in answers:
                forms = a.all_forms() if generated else [a["en"], a.get("fr") or "", *a["aliases"]]
                out[a.key() if generated else normalize_answer(a["en"])] = {normalize_answer(f) for f in forms if f}
            return out

        s_keys, g_keys = keys(q["answers"], generated=False), keys(gen.answers, generated=True)
        # An answer "agrees" if any of its forms matches any form of an answer on the other side.
        missing_in_data = [k for k, forms in s_keys.items() if not any(forms & gf for gf in g_keys.values())]
        missing_in_seed = [k for k, forms in g_keys.items() if not any(forms & sf for sf in s_keys.values())]
        report.append({"seed": q["id"], "concept": concept, "seed_count": len(s_keys), "data_count": len(g_keys), "only_in_seed": missing_in_data, "only_in_data": missing_in_seed})
    return [c for c in cands if c.concept not in covered], report


# ---------------------------------------------------------------- build
def build(refresh: bool = False, log=print) -> dict:
    ctx = load_context(refresh, log)
    cands: list[Candidate] = []
    for tpl in ALL:
        cands.extend(tpl(ctx))
    log(f"templates: {len(cands)} raw candidates")
    for c in cands:
        dedupe(c)
        assign_difficulty(c)
        validate(c)
        assign_est(c)
    cands, seed_report = verify_seed(cands)
    ids = defaultdict(int)
    for c in cands:
        ids[c.id] += 1
    for c in cands:
        if ids[c.id] > 1:
            c.issues.append("duplicate question id")

    decisions = load_decisions()
    apply_decisions(cands, decisions)

    publishable = [c for c in cands if not c.issues and c.review_status != "rejected"]
    version = "etl-" + time.strftime("%Y-%m-%d")
    GENERATED_FILE.parent.mkdir(parents=True, exist_ok=True)
    GENERATED_FILE.write_text(
        json.dumps(
            {
                "version": version,
                "rarityModel": "estimated-v1",
                "notes": "GENERATED by etl/ — do not edit by hand. 'est' is a rank-scaled, data-backed familiarity ESTIMATE (see estBasis). Only reviewStatus=approved questions are playable.",
                "questions": [c.to_json() for c in publishable],
            },
            ensure_ascii=False,
            indent=1,
        )
        + "\n",
        "utf-8",
    )
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    (OUT_DIR / "candidates.json").write_text(
        json.dumps([{**c.to_json(), "issues": c.issues, "warnings": c.warnings} for c in cands], ensure_ascii=False, indent=1), "utf-8"
    )
    from .answer_geo import write_answer_geo

    stats_geo = write_answer_geo(publishable, ctx, log)
    from .report import write_report

    stats = write_report(cands, seed_report, ctx, version)
    log(f"wrote {GENERATED_FILE.relative_to(GENERATED_FILE.parents[2])} ({len(publishable)} questions) and etl/out/report.md")
    stats["geo"] = stats_geo
    return stats
