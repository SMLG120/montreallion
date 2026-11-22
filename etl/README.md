# Montréallion ETL

Builds Montréal trivia questions from open data. It is pure Python standard library with no installs, and was tested on CPython 3.15.

```
fetch → parse → normalize → deduplicate → validate → templates → review → publish
```

```bash
npm run etl:build                     # or: cd etl && python3 -m montreallion_etl build [--refresh]
npm run etl:review -- list [--status in_review] [--template park-in-area]
npm run etl:review -- show gen-rem-terminus
npm run etl:review -- approve gen-rem-terminus --reviewer <your-name> [--note "checked vs rem.info"]
npm run etl:build && npm run db:seed  # publish decisions → data/generated → Postgres
npm run etl:test
```

## Outputs
- `data/generated/questions.generated.json`: committed. It uses the same schema as the seed file, plus `estBasis`, `generator` and per-answer `refs`. Only `reviewStatus: "approved"` questions are playable.
- `etl/out/report.md`: the reviewer report. It covers the seed cross-check, every candidate with its most familiar and rarest answers, and warnings.
- `etl/out/candidates.json`: all candidates, including rejected ones, with their issues.
- `etl/.cache/`: raw downloads plus `manifest.json` (URL, sha256, retrieval date). It is not committed.

## Sources (all licences checked)
| Source | Licence | Used for |
|---|---|---|
| STM GTFS (stm.info) | CC BY 4.0 | métro stations, lines, transfers, termini (authority for "in service") |
| REM GTFS (via donnees.artm.quebec) | CC BY 4.0 (licence file in feed) | REM stations, branches, termini |
| donnees.montreal.ca: limites administratives | CC BY 4.0 (licence verified via CKAN API) | 19 boroughs vs 15 other municipalities; point-in-polygon |
| donnees.montreal.ca: quartiers de référence | CC BY 4.0 | neighbourhoods per borough |
| donnees.montreal.ca: grands parcs / parcs / espaces publics | CC BY 4.0 | named parks per borough, park area |
| donnees.montreal.ca: lieux culturels | CC BY 4.0 | libraries, venues, municipal museums, Espace pour la vie |
| donnees.montreal.ca: art public | CC BY 4.0 | public-art artists |
| Wikidata | CC0 | EN labels and sitelink counts (familiarity signal only, never eligibility) |

## Rules
- **Eligibility comes only from the datasets.** Prompts state the dataset's definition, for example "termini = ends of the longest scheduled trips".
- **Familiarity is a labelled estimate.** The `est` value is rank-scaled (5–95) from a data signal such as Wikidata sitelinks, park area, or routes served, and `estBasis` records which one.
- **Ambiguous aliases are never guessed.** If an alias maps to two answers, it is removed from both and listed in `ambiguous`. The game then asks the player to be more specific.
- **Seed lists are cross-checked, not duplicated.** Templates that cover a seed question's concept are compared with it instead (see the report).
- **Reviews are pinned to content.** Each review decision stores a content hash, so any data change sends the question back to review.
- **Borderline answers are flagged.** Stations within about 150 m of an area boundary get a warning for reviewers.

## Considered and excluded (with reasons)
- **Toponym'Elles:** every row is a name *bank* (proposed names), not places actually named. A question built on it would be false.
- **Municipal pools:** facility names are inconsistent ("Hochelaga", "Port de Plaisance"), so the answers wouldn't be fair.
- **Bus routes at métro stations (GTFS proximity):** the answer sets came out incomplete. Berri–UQAM got 0 routes at 150–250 m.
- **OpenStreetMap:** not used yet. Its ODbL share-alike terms apply to a derived answer database, and business points of interest churn too fast to stay verifiable.
- **Wikidata as an eligibility source for métro:** it includes the planned Pink Line and the Blue Line extension. GTFS is authoritative for what is in service.
