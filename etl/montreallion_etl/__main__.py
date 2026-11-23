"""CLI.

  python3 -m montreallion_etl build [--refresh]          fetch → … → publish data/generated/questions.generated.json
  python3 -m montreallion_etl review list [--status S] [--template T]
  python3 -m montreallion_etl review show ID
  python3 -m montreallion_etl review approve|reject ID... --reviewer NAME [--note TEXT]
(then `npm run db:seed` loads seed + generated questions into Postgres)
"""

from __future__ import annotations

import argparse
import json
import sys

from . import OUT_DIR


def _candidates() -> list[dict]:
    path = OUT_DIR / "candidates.json"
    if not path.exists():
        sys.exit("no candidates yet — run `python3 -m montreallion_etl build` first")
    return json.loads(path.read_text("utf-8"))


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(prog="montreallion_etl")
    sub = ap.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("build")
    b.add_argument("--refresh", action="store_true", help="re-download all sources (ignores cache)")
    r = sub.add_parser("review")
    r.add_argument("action", choices=["list", "show", "approve", "reject"])
    r.add_argument("ids", nargs="*")
    r.add_argument("--status")
    r.add_argument("--template")
    r.add_argument("--reviewer")
    r.add_argument("--note", default="")
    a = ap.parse_args(argv)

    if a.cmd == "build":
        from .pipeline import build

        stats = build(refresh=a.refresh)
        print(json.dumps({k: v for k, v in stats.items() if k != "seed_report"}))
        return

    cands = _candidates()
    if a.action == "list":
        for c in cands:
            st = "rejected" if c["issues"] else c["reviewStatus"]
            if (a.status and st != a.status) or (a.template and c["generator"]["template"] != a.template):
                continue
            print(f"{st:10} {len(c['answers']):4} answers  {c['id']}")
    elif a.action == "show":
        for c in cands:
            if c["id"] in a.ids:
                print(json.dumps(c, ensure_ascii=False, indent=1))
    else:
        if not a.reviewer:
            sys.exit("--reviewer is required (a human name or handle)")
        from .review import decide

        done = decide(a.ids, "approved" if a.action == "approve" else "rejected", a.reviewer, a.note, cands)
        print(f"{'approved' if a.action == 'approve' else 'rejected'} {len(done)}; re-run `build` to publish")


if __name__ == "__main__":
    main()
