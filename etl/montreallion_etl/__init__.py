"""Montréallion open-data ETL.

fetch → parse → normalize → deduplicate → validate → generate question templates → review → publish.

Stdlib only (no third-party dependencies) so it runs on any recent CPython.
"""

from pathlib import Path

ETL_ROOT = Path(__file__).resolve().parent.parent
PROJECT_ROOT = ETL_ROOT.parent
CACHE_DIR = ETL_ROOT / ".cache"
OUT_DIR = ETL_ROOT / "out"
REVIEW_FILE = ETL_ROOT / "review" / "decisions.json"
GENERATED_FILE = PROJECT_ROOT / "data" / "generated" / "questions.generated.json"
SEED_FILE = PROJECT_ROOT / "data" / "seed" / "questions.json"

USER_AGENT = "MontreallionETL/0.1 (open-data trivia pipeline; stdlib urllib)"
