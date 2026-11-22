"""Human-readable build report for reviewers: etl/out/report.md."""

from __future__ import annotations

from collections import Counter

from . import OUT_DIR
from .scoring import score


def write_report(cands, seed_report, ctx, version: str) -> dict:
    status = Counter(c.review_status for c in cands)
    by_tpl = Counter(c.template for c in cands)
    lines = [
        f"# ETL build report — {version}",
        "",
        f"STM GTFS feed {ctx.metro.feed_version} (valid {ctx.metro.feed_window[0]}–{ctx.metro.feed_window[1]}).",
        "",
        "## Summary",
        f"- Candidates: **{len(cands)}** · " + " · ".join(f"{k}: {v}" for k, v in sorted(status.items())),
        f"- Total eligible answers: {sum(len(c.answers) for c in cands)}",
        "- By template: " + ", ".join(f"{k} ({v})" for k, v in sorted(by_tpl.items())),
        "",
        "## Seed cross-check (hand-entered seed lists vs. open data)",
        "",
        "| Seed question | Seed | Data | Only in seed | Only in data |",
        "|---|---|---|---|---|",
    ]
    for r in seed_report:
        lines.append(f"| {r['seed']} | {r['seed_count']} | {r['data_count']} | {', '.join(r['only_in_seed']) or '—'} | {', '.join(r['only_in_data']) or '—'} |")
    lines += ["", "## Candidates", ""]
    for c in sorted(cands, key=lambda c: (c.template, c.id)):
        top = sorted(c.answers, key=lambda a: -a.est)
        lines.append(f"### `{c.id}` — {c.review_status}")
        lines.append(f"**EN:** {c.prompt['en']}  \n**FR:** {c.prompt['fr']}  \n*{c.eligibility['en']}*")
        lines.append(f"- {len(c.answers)} answers · est basis: {c.est_basis} · ambiguous keys: {', '.join(c.ambiguous) or 'none'}")
        lines.append("- Most familiar: " + ", ".join(f"{a.en} ({score(a.est, top[0].est)})" for a in top[:5]))
        lines.append("- Rarest: " + ", ".join(f"{a.en} ({score(a.est, top[0].est)})" for a in top[-3:]))
        for i in c.issues:
            lines.append(f"- ❌ {i}")
        for w in c.warnings:
            lines.append(f"- ⚠️ {w}")
        lines.append("")
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    (OUT_DIR / "report.md").write_text("\n".join(lines) + "\n", "utf-8")
    return {"candidates": len(cands), **status, "seed_report": seed_report}
