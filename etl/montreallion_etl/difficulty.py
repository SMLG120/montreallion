"""Editorial question difficulty (easy / medium / hard), by question family.

Difficulty describes the knowledge a question asks for, NOT its answers' rarity scores (those stay per answer):
  * easy   — city-wide sets most Montrealers can draw on (métro lines, boroughs, big festivals, famous dishes);
  * medium — narrower but common local knowledge (one borough's parks or stations, a cuisine, a team's players);
  * hard   — specialist or historical knowledge (prize winners, festival line-ups, heritage registers, districts).

Rules are matched on the generator concept (first match wins). Templates may set `difficulty` themselves; a rule
never overrides that. Every rule here was chosen by reading the family's prompt, and is reviewable like content.
"""

from __future__ import annotations

import re

from .model import Candidate

# (concept regex, difficulty) — first match wins.
RULES: list[tuple[str, str]] = [
    # transit
    (r"^metro-line:", "easy"),
    (r"^metro-terminus", "easy"),
    (r"^metro-transfer", "easy"),
    (r"^metro-in:", "medium"),
    (r"^metro-opened", "hard"),
    (r"^rem-station", "easy"),
    (r"^rem-(terminus|in-city|outside-city)", "medium"),
    (r"^rem-branch", "hard"),
    (r"^exo-", "hard"),
    (r"^stm-bus", "hard"),
    (r"^wl:bridge-st-lawrence", "easy"),
    (r"^wl:bridge-prairies", "medium"),
    (r"^wl:bridge-west", "hard"),
    # boroughs / neighbourhoods
    (r"^city-borough", "easy"),
    (r"^island-municipality", "medium"),
    (r"^(hood|neighbourhood)-in:", "medium"),
    (r"^wl:mall", "easy"),
    # parks
    (r"^park-in:", "medium"),
    (r"^park-kind:nature", "easy"),
    (r"^park-kind:", "medium"),
    (r"^garden-in:", "hard"),
    # culture & history
    (r"^museum:(all|art)", "easy"),
    (r"^museum:", "medium"),
    (r"^culture:espace-pour-la-vie", "easy"),
    (r"^culture:library", "medium"),
    (r"^culture:", "hard"),
    (r"^library-in:", "hard"),
    (r"^public-art-artist", "hard"),
    (r"^heritage-kind:site", "medium"),
    (r"^heritage-", "hard"),
    (r"^nhs-in:__island__", "medium"),
    (r"^nhs-in:", "hard"),
    (r"^wl:theatre", "medium"),
    (r"^wl:skyscraper-top25", "medium"),
    (r"^wl:skyscraper-old", "hard"),
    # festivals & events
    (r"^wl:fest-(music|any)", "easy"),
    (r"^wl:fest-", "medium"),
    (r"^ev:(fireworks|expo67-national|qc-city|qc-music|qc-region|olympics)", "medium"),
    (r"^ev:(f1-|marathon)", "medium"),
    (r"^ev:", "hard"),
    # food
    (r"^wl:food-quebec-cuisine", "easy"),
    (r"^wl:food-", "medium"),
    (r"^food:famous-restaurant", "easy"),
    (r"^food:(pizza|poutine|burger|bagel|italian|chinese|coffee-chain|fast-food-chain|ice-cream|bakery|breakfast|sandwich)$", "easy"),
    (r"^food:(restaurant|fast-food)-in-", "medium"),
    (r"^food:(cafe|bakery|bar)-in-", "hard"),
    (r"^food:", "medium"),
]

def for_concept(concept: str) -> str | None:
    for pattern, level in RULES:
        if re.search(pattern, concept):
            return level
    return None


def assign_difficulty(c: Candidate) -> None:
    if c.difficulty is None:
        c.difficulty = for_concept(c.concept)
