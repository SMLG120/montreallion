# Question bank audit

Before = bank files at `HEAD`; after = working tree. Only **approved** questions are playable.

## Counts by category

| Category | Approved before | Approved now | In review (new + held) | Approved + in review | Target | Gap if all in-review were approved |
|---|---|---|---|---|---|---|
| transit | 29 | 35 | 0 | 35 | 75 | 40 |
| boroughs | 3 | 74 | 0 | 74 | 65 | met |
| parks | 34 | 34 | 0 | 34 | 75 | 41 |
| food | 97 | 103 | 4 | 107 | 100 | met |
| history | 22 | 32 | 6 | 38 | 70 | 32 |
| festivals | 39 | 41 | 2 | 43 | 70 | 27 |
| sports | 4 | 24 | 0 | 24 | 45 | 21 |
| universities | 1 | 1 | 0 | 1 | — |  |
| winter | 1 | 1 | 0 | 1 | — |  |
| **total** | **230** | **345** | **12** | **357** | **500** | **143** |

Approved questions in categories without a target (not listed on the homepage while under the minimum per category): universities 1, winter 1. This explains a homepage total that is larger than the sum of the listed categories.

## Difficulty

Target mix: 40% easy / 40% medium / 20% hard. Difficulty is editorial (see `etl/montreallion_etl/difficulty.py`) and independent of answer rarity.

- Approved now: easy 35 (10%), medium 180 (52%), hard 130 (38%)
- Approved + in review: easy 39 (11%), medium 186 (52%), hard 132 (37%)

| Category | Easy | Medium | Hard |
|---|---|---|---|
| transit | 9 | 13 | 13 |
| boroughs | 2 | 49 | 23 |
| parks | 2 | 21 | 11 |
| food | 15 | 64 | 28 |
| history | 4 | 15 | 19 |
| festivals | 4 | 14 | 25 |
| sports | 1 | 10 | 13 |
| universities | 1 | 0 | 0 |
| winter | 1 | 0 | 0 |

## Duplicates

- Identical prompts: 0
- Near-duplicate answer sets (same category, overlap ≥ 80%): 0

## Rejected candidates (not published)

0 of 355 generated candidates failed validation:



Rejected in human review: 13 (gen-neighbourhood-in-ahuntsic-cartierville, gen-neighbourhood-in-cote-des-neiges-notre-dame-de-grace, gen-neighbourhood-in-le-plateau-mont-royal, gen-neighbourhood-in-le-sud-ouest, gen-neighbourhood-in-mercier-hochelaga-maisonneuve, gen-neighbourhood-in-montreal-nord, gen-neighbourhood-in-riviere-des-prairies-pointe-aux-trembles, gen-neighbourhood-in-rosemont-la-petite-patrie, gen-neighbourhood-in-saint-laurent, gen-neighbourhood-in-verdun, gen-neighbourhood-in-ville-marie, gen-neighbourhood-in-villeray-saint-michel-parc-extension, gen-culture-venue)

## Remaining gaps

- **transit**: 35 of 75 even if every in-review question is approved (short 40).
- **parks**: 34 of 75 even if every in-review question is approved (short 41).
- **history**: 38 of 70 even if every in-review question is approved (short 32).
- **festivals**: 43 of 70 even if every in-review question is approved (short 27).
- **sports**: 24 of 45 even if every in-review question is approved (short 21).
- **Total**: 357 of 500 (short 143).
