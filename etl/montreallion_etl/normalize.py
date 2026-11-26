"""Python port of src/lib/game/normalize.ts — MUST stay byte-for-byte equivalent.

Parity is enforced by tests on both sides against data/normalize-fixtures.json.
"""

from __future__ import annotations

import re
import unicodedata

_COMBINING = re.compile("[̀-ͯ]")
_APOS = re.compile("['’`´]")
_NON_ALNUM = re.compile(r"[^a-z0-9]+")
_FILLER_PREFIX = re.compile(r"^(the|le|la|les|l|station|metro|pont|parc|park|ville de|city of)\s+")
_FILLER_SUFFIX = re.compile(r"\s+(station|metro|bridge|park)$")


def normalize_answer(raw: str) -> str:
    s = unicodedata.normalize("NFKD", raw)
    s = _COMBINING.sub("", s).lower()
    s = s.replace("œ", "oe").replace("æ", "ae").replace("&", " and ")
    s = _APOS.sub(" ", s)
    s = _NON_ALNUM.sub(" ", s).strip()
    s = re.sub(r"\bsainte\b", "ste", s)
    s = re.sub(r"\bsaint\b", "st", s)
    s = re.sub(r"\bmount\b", "mont", s)
    s = re.sub(r"\b(av|ave)\b", "avenue", s)
    s = re.sub(r"\b(boul|blvd|bd)\b", "boulevard", s)
    s = re.sub(r"\bmt\b", "mont", s)
    s = re.sub(r"\bmtl\b", "montreal", s)
    for _ in range(3):
        before = s
        s = _FILLER_SUFFIX.sub("", _FILLER_PREFIX.sub("", s, count=1), count=1)
        if s == before:
            break
    return re.sub(r"\s+", "", s)


def slugify(raw: str) -> str:
    s = unicodedata.normalize("NFKD", raw)
    s = _COMBINING.sub("", s).lower().replace("œ", "oe").replace("æ", "ae")
    s = re.sub(r"[^a-z0-9]+", "-", s).strip("-")
    return s[:60].strip("-") or "x"
