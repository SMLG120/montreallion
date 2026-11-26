"""Question-bank audit (Phase H): counts per category vs targets, difficulty mix, duplicates, rejected candidates, gaps.

  python3 -m montreallion_etl audit [--before REF]   → docs/QUESTION_AUDIT.md

"Before" counts come from the bank files at a git ref (default HEAD), "after" from the working tree. Only
`approved` questions are playable; `in_review` ones are counted separately and never as part of the live total.
"""

from __future__ import annotations

import json
import subprocess
from collections import Counter, defaultdict
from pathlib import Path

from . import GENERATED_FILE, OUT_DIR, SEED_FILE
from .normalize import normalize_answer

TARGETS = {"transit": 75, "boroughs": 65, "parks": 75, "food": 100, "history": 70, "festivals": 70, "sports": 45}
TOTAL_TARGET = 500
MIX_TARGET = {"easy": 0.40, "medium": 0.40, "hard": 0.20}
NEAR_DUP = 0.8  # answer-set overlap (Jaccard) above which two questions in one category are flagged


def _bank(ref: str | None) -> list[dict]:
    out = []
    for f in (SEED_FILE, GENERATED_FILE):
        if ref:
            rel = f.relative_to(f.parents[2])
            try:
                txt = subprocess.run(["git", "show", f"{ref}:{rel}"], cwd=f.parents[2], capture_output=True, text=True, check=True).stdout
            except subprocess.CalledProcessError:
                continue
        else:
            txt = f.read_text("utf-8")
        out += json.loads(txt)["questions"]
    return out


def _counts(qs: list[dict], status: str) -> Counter:
    return Counter(q["category"] for q in qs if q["reviewStatus"] == status)


def _keys(q: dict) -> set[str]:
    return {normalize_answer(a["en"]) for a in q["answers"]}


def audit(before_ref: str = "HEAD") -> str:
    before, after = _bank(before_ref), _bank(None)
    b_ok, a_ok, a_rev = _counts(before, "approved"), _counts(after, "approved"), _counts(after, "in_review")
    cats = list(TARGETS) + sorted({q["category"] for q in after} - set(TARGETS))
    lines = ["# Question bank audit", "", f"Before = bank files at `{before_ref}`; after = working tree. Only **approved** questions are playable.", ""]

    # --- counts
    lines += ["## Counts by category", "", "| Category | Approved before | Approved now | In review (new + held) | Approved + in review | Target | Gap if all in-review were approved |", "|---|---|---|---|---|---|---|"]
    for c in cats:
        tgt = TARGETS.get(c)
        pot = a_ok[c] + a_rev[c]
        gap = "" if tgt is None else (str(max(0, tgt - pot)) if pot < tgt else "met")
        lines.append(f"| {c} | {b_ok[c]} | {a_ok[c]} | {a_rev[c]} | {pot} | {tgt or '—'} | {gap} |")
    tot_b, tot_a, tot_r = sum(b_ok.values()), sum(a_ok.values()), sum(a_rev.values())
    lines += [f"| **total** | **{tot_b}** | **{tot_a}** | **{tot_r}** | **{tot_a + tot_r}** | **{TOTAL_TARGET}** | **{max(0, TOTAL_TARGET - tot_a - tot_r) or 'met'}** |", ""]
    hidden = {c: n for c, n in a_ok.items() if c not in TARGETS}
    if hidden:
        lines += [f"Approved questions in categories without a target (not listed on the homepage while under the minimum per category): {', '.join(f'{c} {n}' for c, n in sorted(hidden.items()))}. "
                  "This explains a homepage total that is larger than the sum of the listed categories.", ""]

    # --- difficulty
    def mix(qs: list[dict]) -> str:
        d = Counter(q.get("difficulty") or "unset" for q in qs)
        n = len(qs) or 1
        return ", ".join(f"{k} {d[k]} ({100 * d[k] / n:.0f}%)" for k in ("easy", "medium", "hard", "unset") if d[k])

    approved = [q for q in after if q["reviewStatus"] == "approved"]
    pool = [q for q in after if q["reviewStatus"] in ("approved", "in_review")]
    lines += ["## Difficulty", "", f"Target mix: 40% easy / 40% medium / 20% hard. Difficulty is editorial (see `etl/montreallion_etl/difficulty.py`) and independent of answer rarity.", "",
              f"- Approved now: {mix(approved)}", f"- Approved + in review: {mix(pool)}", ""]
    lines += ["| Category | Easy | Medium | Hard |", "|---|---|---|---|"]
    for c in cats:
        d = Counter(q.get("difficulty") for q in pool if q["category"] == c)
        lines.append(f"| {c} | {d['easy']} | {d['medium']} | {d['hard']} |")
    lines.append("")

    # --- duplicates
    by_prompt = defaultdict(list)
    for q in pool:
        by_prompt[normalize_answer(q["prompt"]["en"])].append(q["id"])
    exact = [ids for ids in by_prompt.values() if len(ids) > 1]
    near = []
    by_cat = defaultdict(list)
    for q in pool:
        by_cat[q["category"]].append(q)
    for c, qs in by_cat.items():
        keys = [(q, _keys(q)) for q in qs]
        for i, (q1, k1) in enumerate(keys):
            for q2, k2 in keys[i + 1:]:
                if k1 and k2:
                    j = len(k1 & k2) / len(k1 | k2)
                    if j >= NEAR_DUP:
                        near.append((q1["id"], q2["id"], j))
    lines += ["## Duplicates", "", f"- Identical prompts: {len(exact)}" + ("".join(f"\n  - {', '.join(ids)}" for ids in exact) if exact else ""),
              f"- Near-duplicate answer sets (same category, overlap ≥ {NEAR_DUP:.0%}): {len(near)}"]
    lines += [f"  - `{a}` ~ `{b}` ({j:.0%})" for a, b, j in sorted(near, key=lambda x: -x[2])]
    lines.append("")

    # --- rejected candidates
    cand_file = OUT_DIR / "candidates.json"
    if cand_file.exists():
        cands = json.loads(cand_file.read_text("utf-8"))
        bad = [c for c in cands if c["issues"]]
        reasons = Counter(i.split(" (")[0].split(":")[0] for c in bad for i in c["issues"])
        lines += ["## Rejected candidates (not published)", "", f"{len(bad)} of {len(cands)} generated candidates failed validation:", ""]
        lines += [f"- {r}: {n}" for r, n in reasons.most_common()]
        lines += [""] + [f"  - `{c['id']}`: {'; '.join(c['issues'])}" for c in bad]
        lines.append("")
        rejected_by_review = [c["id"] for c in cands if not c["issues"] and c["reviewStatus"] == "rejected"]
        if rejected_by_review:
            lines += [f"Rejected in human review: {len(rejected_by_review)} ({', '.join(rejected_by_review)})", ""]

    # --- gaps
    lines += ["## Remaining gaps", ""]
    for c, tgt in TARGETS.items():
        pot = a_ok[c] + a_rev[c]
        if pot < tgt:
            lines.append(f"- **{c}**: {pot} of {tgt} even if every in-review question is approved (short {tgt - pot}).")
    if tot_a + tot_r < TOTAL_TARGET:
        lines.append(f"- **Total**: {tot_a + tot_r} of {TOTAL_TARGET} (short {TOTAL_TARGET - tot_a - tot_r}).")
    lines.append("")
    text = "\n".join(lines)
    out = Path(SEED_FILE.parents[2]) / "docs" / "QUESTION_AUDIT.md"
    out.write_text(text, "utf-8")
    return text
