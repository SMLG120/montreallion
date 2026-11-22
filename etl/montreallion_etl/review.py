"""Human review workflow.

Decisions live in etl/review/decisions.json (committed). Each decision is pinned to the
candidate's content hash: if a later data refresh changes the question or its answers,
the decision no longer applies and the question returns to the review queue.
"""

from __future__ import annotations

import json
import time

from . import REVIEW_FILE


def load_decisions() -> dict:
    if REVIEW_FILE.exists():
        return json.loads(REVIEW_FILE.read_text("utf-8"))
    return {}


def save_decisions(d: dict) -> None:
    REVIEW_FILE.parent.mkdir(parents=True, exist_ok=True)
    REVIEW_FILE.write_text(json.dumps(d, ensure_ascii=False, indent=2, sort_keys=True) + "\n", "utf-8")


def apply_decisions(cands, decisions: dict) -> None:
    for c in cands:
        if c.issues:
            c.review_status = "rejected"
            continue
        d = decisions.get(c.id)
        if not d:
            c.review_status = "in_review"
        elif d.get("contentHash") != c.content_hash():
            c.review_status = "in_review"
            c.warnings.append(f"content changed since it was {d['status']} on {d.get('date')}; needs re-review")
        else:
            c.review_status = d["status"]


def decide(ids: list[str], status: str, reviewer: str, note: str, candidates: list[dict]) -> list[str]:
    by_id = {c["id"]: c for c in candidates}
    decisions = load_decisions()
    done = []
    for qid in ids:
        c = by_id.get(qid)
        if not c:
            raise SystemExit(f"unknown candidate id: {qid}")
        if c.get("issues"):
            raise SystemExit(f"{qid} has validation issues and cannot be {status}: {c['issues']}")
        decisions[qid] = {
            "status": status,
            "contentHash": c["generator"]["contentHash"],
            "reviewer": reviewer,
            "date": time.strftime("%Y-%m-%d"),
            **({"note": note} if note else {}),
        }
        done.append(qid)
    save_decisions(decisions)
    return done
