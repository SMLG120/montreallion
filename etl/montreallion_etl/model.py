"""Candidate question model — serializes to the same JSON schema as data/seed/questions.json."""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field

from .normalize import normalize_answer, slugify


@dataclass
class Answer:
    en: str
    fr: str | None = None
    aliases: list[str] = field(default_factory=list)
    signal: float = 0.0  # raw familiarity signal (e.g. sitelinks); converted to `est` later
    refs: list[str] = field(default_factory=list)  # provenance ids, e.g. "wikidata:Q123", "gtfs:STATION_M146"
    est: int = 50
    id: str = ""

    def key(self) -> str:
        return normalize_answer(self.en)

    def all_forms(self) -> list[str]:
        return [self.en, *([self.fr] if self.fr else []), *self.aliases]


@dataclass
class Candidate:
    id: str
    template: str
    concept: str  # semantic key used to dedupe against seed/other templates
    category: str
    scope: str
    prompt: dict[str, str]
    eligibility: dict[str, str]
    sources: list[dict]
    answers: list[Answer]
    est_basis: str
    ambiguous: list[str] = field(default_factory=list)
    issues: list[str] = field(default_factory=list)  # validation errors (block publishing)
    warnings: list[str] = field(default_factory=list)
    review_status: str = "in_review"

    def content_hash(self) -> str:
        """Changes whenever the playable content changes, invalidating earlier review decisions."""
        payload = {
            "prompt": self.prompt,
            "eligibility": self.eligibility,
            "answers": sorted([a.id, a.en, a.fr, sorted(a.aliases)] for a in self.answers),  # type: ignore[type-var]
            "ambiguous": sorted(self.ambiguous),
        }
        return hashlib.sha256(json.dumps(payload, sort_keys=True, ensure_ascii=False).encode()).hexdigest()[:16]

    def to_json(self) -> dict:
        return {
            "id": self.id,
            "category": self.category,
            "scope": self.scope,
            "prompt": self.prompt,
            "eligibility": self.eligibility,
            "verification": "source-checked",
            "reviewStatus": self.review_status,
            "sources": self.sources,
            **({"ambiguous": sorted(self.ambiguous)} if self.ambiguous else {}),
            "estBasis": self.est_basis,
            "generator": {"template": self.template, "concept": self.concept, "contentHash": self.content_hash()},
            "answers": [
                {
                    "id": a.id,
                    "en": a.en,
                    **({"fr": a.fr} if a.fr and a.fr != a.en else {}),
                    "aliases": a.aliases,
                    "est": a.est,
                    **({"refs": a.refs} if a.refs else {}),
                }
                for a in self.answers
            ],
        }


def make_id(template: str, *parts: str) -> str:
    return "gen-" + "-".join(slugify(p) for p in (template, *parts) if p)[:76].strip("-")
