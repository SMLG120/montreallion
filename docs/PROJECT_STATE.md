# Montréallion — Project State

_Last updated: 2026-11-23 · Phases 1–8 complete · **Expansion phase B (answer double-check) deployed 2026-11-23 (a8b6928; Neon migrated first)** · 49 approved questions live · LIVE at https://montreallion.vercel.app (Vercel + Neon Postgres) — see docs/DEPLOY.md_

## What it is
Original, bilingual (EN/FR) Montréal rarity trivia game. 7 open-ended questions per ride, 25 s each, rarer valid answers score more (10–100). It borrows the general rarity-quiz idea only; no Krillion branding, code, art or content.

## Stack (installed versions)
Next.js 16.4 (App Router, Turbopack) · React 19.3 · TypeScript · Tailwind 4.3 · shadcn/ui (base-nova, Base UI) · motion · zod 4 · Vitest 5 · Playwright. Node 24.
postgres.js 3 (server-only DB client). Python 3 ETL (stdlib only) in `etl/`. Not yet added: Supabase Auth (optional, later), Vercel deploy (Phase 8).

## Architecture
```
data/seed/questions.json      Hand-built seed bank (15 approved questions)
data/generated/questions.generated.json  ETL output (47 questions: 34 approved, 13 in_review; rejected ones removed after review #1); same schema + provenance
data/normalize-fixtures.json  Shared TS/Python normalizer parity fixtures (regenerate: node scripts/make-normalize-fixtures.ts)
etl/                          Open-data ETL (see etl/README.md); review decisions in etl/review/decisions.json
supabase/migrations/          SQL migrations (Supabase CLI layout; also applied by scripts/db.ts)
scripts/db.ts                 migrate | seed | reset (Node 24 native TS; reset only on local *_dev/*_test DBs)
src/lib/game/
  types.ts                    Domain types (QuestionDef, PublicQuestion, Tier…)
  normalize.ts                Accent/case/punctuation-insensitive keys + OSA edit distance + typo budget
  match.ts                    Server-side answer validation: exact → conservative fuzzy; ambiguous ⇒ retry
  scoring.ts                  Rarity models "estimated-v1" + "observed-v1" (rarityTable), tiers
  names.ts                    Leaderboard display-name validation
  board.ts                    Leaderboard date parsing + loader (server-only)
  daily.ts                    America/Toronto date key, seeded daily pick (7 distinct categories)
  schema.ts                   zod schema for the bank file (plain module, shared with scripts)
  bank.ts        (server-only) getBank(): Postgres (5-min per-instance cache) or seed file when no DB
  engine.ts      (server-only) Sessions, server timer, submit, per-session lock, reveal, summary
  store.ts                    SessionStore interface (mutate = locked, atomic) + memory impl + defaultStore()
  store-postgres.ts           Postgres impl: one transaction per mutation, SELECT … FOR UPDATE, stats upserts
src/lib/server/db.ts          getSql(): postgres.js singleton from DATABASE_URL (prepare:false for the pooler); required on Vercel
src/lib/server/rate-limit-pg.ts  Atomic fixed-window counter (upsert) keyed by scope + salted IP hash
src/lib/server/http.ts        Anonymous player cookie (httpOnly UUID), rate limit (DB or memory), JSON helpers
src/app/api/game/             POST /api/game (start/resume) · POST /:id/next · POST /:id/answer · GET /:id (finished only)
src/app/                      / · /play/[daily|unlimited] · /results/[id] · /how-to-play · /leaderboard · /admin
src/components/               providers (locale+sound), site-header, game/ (game-client, metro-line), pages/
```

### Key decisions
- **Server-authoritative timing.** `/next` stamps `servedAt`; re-serving never resets it. Answers after 25 s + 1.5 s network grace score 0 (`expired`). An abandoned question is expired automatically on the next `/next` call.
- **One answer per question.** Index must match `session.index`. Postgres: each serve/submit is one transaction holding a row lock on the session, plus `unique (session_id, position)` on submissions. Memory: per-session promise lock. Ambiguous input (e.g. "Richard" for Habs retired numbers, or a typo equidistant to two answers) returns `retry` and does NOT consume the question.
- **No answer leakage.** The client gets `PublicQuestion` (prompt, eligibility, answer count) only. After answering, it sees the matched answer + 3 most common + 2 rarest. Full results are only readable once a session is finished.
- **Matching.** Keys strip accents, case, punctuation, spaces, filler words (le/la/the/station/pont/parc…), and map saint→st, sainte→ste, mount→mont. Fuzzy: 0 typos for keys < 5 chars, 1 for 5–8, 2 for ≥ 9; never fuzzy onto short keys; reject ties. No LLM anywhere in validation.
- **Rarity (bootstrap).** `score = round(100 − 90 × est / maxEst)`, clamped 10–100. `est` values are **editor estimates**, labelled as such in UI and data.
- **Frozen daily scoring.** The first daily start of the day inserts `daily_challenges` with the 7 question ids and a `score_snapshot` (every answer's score/share). Daily sessions score and reveal from that snapshot, so weight changes mid-day don't affect a ranked day (integration-tested). Unlimited uses live weights.
- **Data access model.** No supabase-js / PostgREST: route handlers connect directly with a server-only `DATABASE_URL`. Every table has RLS enabled with no policies (only `categories` has a read policy), and grants to `anon`/`authenticated` are revoked, so the public Supabase API can't read answers, sessions or players even with the anon key. Integration tests check this with real `anon`/`authenticated` roles.
- **Answer frequencies.** Every server-validated submission upserts `question_stats` (attempts/correct) and `answer_stats` (correct_count) in the same transaction. This is input for the Phase 5 statistical model.
- **Daily.** Date key in America/Toronto; FNV-1a + mulberry32 seeded shuffle; greedy pick of 7 distinct categories. One daily session per anonymous player per day (resume, no replay).
- **Locale.** `ml_locale` cookie read in root layout; switching is client-side state, so the game is not reset (covered by E2E). Prompts carry both languages.
- **Dark-only métro identity.** STM-inspired line accents (green/orange/yellow/blue), enamel "tile" cards, 7-stop line progress. Fonts: Bricolage Grotesque (display) + Atkinson Hyperlegible (body). Respects `prefers-reduced-motion`.
- `cacheComponents` from the scaffold was turned off: every route is dynamic (cookies/sessions), simpler mental model.

### Seed data provenance
11 lists are **source-checked** (compared against the cited page on 2026-11-21): STM Orange/Green/Blue stations, transfer stations, line colours, 19 boroughs, 15 reconstituted municipalities, Mount Royal summits, South Shore road crossings, Canadiens retired numbers (18 players; checked from page summary, not the table verbatim), mayors 1960–2020.
4 lists are **editor-curated** (well-known, non-exhaustive; UI shows "Curated list"): universities, festivals, winter festivals, traditional Québécois dishes. They should be re-verified or replaced by ETL output in Phase 4.
Category 10 (slang & hidden gems) has no questions yet.

### Database tables (migration 20261121000001)
categories · sources · questions · question_sources · answers · answer_aliases (normalized_key unique per question, is_label) · rarity_models · answer_stats · question_stats · players · daily_challenges · sessions (partial unique: one daily per player/day) · submissions · appeals · rate_limits · app_migrations (runner bookkeeping).

## Known limitations
- Without `DATABASE_URL` the app falls back to in-memory sessions/rate limits (dev only; `getSql()` throws on Vercel).
- Streaks are per-device (localStorage).
- `scripts/db.ts` tracks migrations in `app_migrations`. If you use the Supabase CLI (`supabase db push`) instead, pick ONE tool per database so migrations aren't applied twice.
- Display names: blocklist on write, plus manual reset in /admin/names (no automated moderation queue).
- Base map tiles and fonts come from OpenFreeMap (free, no uptime guarantee), which stalls intermittently; see "Map smoke de-flake".
- Only 49 approved questions (15 seed + 34 generated), 13 more in review; target 500+.

## Commands
```
npm run dev            # http://localhost:3000
npm run build && npm start
npm test               # Vitest unit tests (35), no DB needed
npm run test:db        # Postgres integration tests (8); needs TEST_DATABASE_URL=postgres://localhost:5432/montreallion_test
npm run test:e2e       # Playwright, desktop + Pixel 7 (builds and serves on :3100); set DATABASE_URL to run against Postgres
npm run db:migrate     # apply supabase/migrations (DATABASE_URL)
npm run db:seed        # upsert data/seed/questions.json (idempotent)
npm run db:reset       # drop+migrate+seed, local *_dev/*_test only
npm run etl:build      # run the open-data ETL (cached after first run; WDQS limited to 1 req/min)
npm run etl:review -- list|show|approve|reject … --reviewer NAME
npm run db:export-reviews   # console reviews of generated questions → etl/review/decisions.json
npm run etl:test       # Python unit + cached-data regression tests (19)
npm run typecheck
npm run lint
```

## Local database setup
Homebrew Postgres 18 on :5432 with databases `montreallion_dev` and `montreallion_test`. NOLOGIN roles `anon` and `authenticated` were created cluster-wide to mimic Supabase for the RLS tests. Docker Desktop was paused, so the Supabase CLI local stack was not used.
```
DATABASE_URL=postgres://localhost:5432/montreallion_dev npm run db:reset
DATABASE_URL=postgres://localhost:5432/montreallion_dev npm run dev
```

## Test status (2026-11-21, end of Phase 7)
- Unit (Vitest): 120/120 passing (Phase 7: party state machine — lobby rules, hidden answers, early close, deadline/reveal ticks, host skip and failover, away players, store rollback; Phase 6: admin cookie signing, locale detection, EN/FR dictionary parity, Unlimited categories and no-repeat, content hash; (incl. 38 TS↔Python normalizer parity fixtures; observed-v1 model, leaderboard ranking, day counts, display names).
- ETL (Python unittest): 19/19 passing (incl. regression checks on real cached datasets).
- Postgres integration: 14/14 passing. Covers party rooms (3 concurrent answers under row locks, duplicate code/answer rejection), admin reviews (stale refusal, survive reseed, export to ETL decisions), appeals (ownership, alias acceptance makes input match and survives reseed, past scores unchanged), recent-question lookup, distinct-player answer stats loaded into the bank, the SQL leaderboard (ties, abandoned rides excluded, no ids leaked) and day counts, plus DB bank = seed bank, a full daily game persisted with stats, a 5-way submit race giving exactly 1 row, 5 concurrent daily starts giving 1 session and 1 challenge, frozen daily scores after a weight change, ownership and malformed ids, the rate-limit window, and RLS/grant denial for anon/authenticated.
- E2E: memory mode 18 passed + 2 skipped (admin needs DB); Postgres mode (`montreallion_test`) 18 passed + 1 skipped (admin spec runs on desktop only). Phase 7: two browser contexts create/join/play 3 live party rounds (no answer leak before close, clashing names refused, late joiner blocked), unknown code page. Phase 6: FR Accept-Language detection, Unlimited category line, admin login → review → player appeal → admin resolve. Earlier: daily results → rank → leaderboard → set/reject a name), both in memory mode and against Postgres (`montreallion_dev`).
- `tsc` and `eslint` clean.

## To finish hosting Phase 3 (needs user)
1. Create a Supabase project and provide the connection strings (direct/session for migrations, transaction pooler for the app).
2. `DATABASE_URL=<direct> npm run db:migrate && npm run db:seed`.
3. Set `DATABASE_URL` (pooler, 6543), `DATABASE_POOL_MAX=1` and `RATE_LIMIT_SALT` in Vercel env (Phase 8).

## Phase 4: ETL (done 2026-11-21)
- Pipeline: fetch (cached, sha256 manifest, rate-limited for WDQS) → parse → normalize (Python port, parity-tested) → dedupe → validate → 10 templates → content-pinned human review → `data/generated/…json` → `npm run db:seed` (also retires generated questions that disappear).
- Sources used: STM GTFS, REM GTFS (ARTM), 5 City of Montréal CC BY datasets, Wikidata (CC0, familiarity only). Exclusions and reasons are in etl/README.md: Toponym'Elles is a name *bank*; pools and bus proximity were unreliable; OSM was deferred for ODbL reasons.
- Output: **61 candidate questions / ~1,300 answers, all `in_review`** (0 approved). Covers métro (yellow line, termini, stations per borough), REM (stations, branches, termini, inside/outside the City), neighbourhoods per borough, parks per borough (19), libraries per borough, cultural networks, public-art artists.
- Seed cross-check: all 6 overlapping seed lists (Orange/Green/Blue stations, transfers, 19 boroughs, 15 municipalities) match open data exactly.
- `est` for generated questions = rank-scaled 5–95 from a data signal (`estBasis`). Still an estimate; the UI keeps the "estimated" label.
- Migration `20261121000002_etl_provenance.sql`: questions.est_basis, questions.generator, answers.refs.
- **Gap vs. target:** 61 + 15 = 76 questions, against the 500+ target. Quality filters dropped weak sources. Paths to more: OSM (after an ODbL decision), exo commuter-rail GTFS, more City datasets (rinks: no machine-readable resource found), Wikidata lists with occupation/type constraints.

## Phase 5: daily stats, rarity, leaderboard (done 2026-11-21)
- **Rarity `observed-v1`** (`scoring.ts › rarityTable`). For each question it uses estimated-v1 *exactly* until 30 distinct players have answered correctly. After that, share = (players_a + 20·estShare_a)/(n + 20) and score = 100 − 90·share/maxShare, the same scale as before. Constants: `MIN_SAMPLE = 30`, `PRIOR_WEIGHT = 20`.
- **Counting people, not plays.** The new `answer_players` table (PK answer+player) feeds `answer_stats.players`, so replaying Unlimited can't inflate an answer. Limitation: player ids are anonymous cookies, so clearing cookies creates a new "player". A per-IP cap or accounts would be the fix if abuse shows up.
- **Freezing.** The daily snapshot now stores `basis` and `n` per answer. Unlimited uses live stats, which refresh with the 5-minute bank cache. Memory mode (no DB) has no stats and always uses estimates.
- **What the player sees.** Each submission records `rarity_basis`/`rarity_sample`. The UI says either "Est. x%" (estimated) or "About x% of N players' answers" (observed), always labelled.
- **Leaderboard** (`/leaderboard?date=`, `GET /api/leaderboard`):
  - Only finished daily rides count. Ranking is score desc, then total answer time asc; ties share a rank.
  - Shows the top 50 plus the caller's own row, with previous/next day navigation.
  - Anonymous players show as "Anonymous #1234". The tag is a hash, and player ids are never sent.
- **Display names.** `GET/PUT /api/player` accepts 2–20 Unicode letters/digits plus `. ' _ -`. It blocks links, impersonation (admin/official/montreallion) and common EN/FR profanity, including leetspeak, and is rate-limited to 10/min.
- **Results.** Daily results show your rank ("#3 of 41 today" → leaderboard) and, for each correct answer, how many other players gave the same answer that day.
- Migration `20261121000003_rarity_stats_leaderboard.sql`: `observed-v1` model row, `answer_players` (backfilled), `answer_stats.players`, `submissions.rarity_basis/rarity_sample`, `sessions.total_elapsed_ms` (backfilled) and the leaderboard index.

## Phase 6: localization, Unlimited, admin review (done 2026-11-21)
- **Admin auth decision:** a shared `ADMIN_TOKEN` secret (24+ chars) plus a reviewer name. Login sets an HMAC-signed, httpOnly, SameSite=Strict cookie that lasts 12 h; rotating the token signs everyone out. Login is rate-limited (5/min). Every page and server action re-checks the cookie, and Next checks Origin on actions. The console is disabled when the token is unset. It's swappable for Supabase Auth later, because `requireAdmin()` is the only gate.
- **Console** (`/admin`, noindex):
  - Overview counts.
  - Question queue by status with search.
  - Question detail: EN/FR prompts, eligibility, sources, answers with est, players and aliases, and review history; approve, reject or send back to review.
  - Appeals queue: player input, normalized key, closest answers by edit distance; accept as alias, accept as "noted", or reject.
  - Display-name list with reset.
- **Reviews are pinned to content.** `questions.content_hash` (TS `questionContentHash`) is stored with each `question_reviews` row. A review only applies while the content is unchanged, and a stale form is refused. `db:seed` re-applies console reviews whose hash still matches, so reseeding no longer undoes approvals. `npm run db:export-reviews` writes console decisions for generated questions back to `etl/review/decisions.json` (ETL hashes), so the committed file stays the source of truth for memory mode.
- **Appeals** (`POST /api/appeals`, rate-limited 10/min):
  - Only for your own finished session, an incorrect non-empty answer, once per answer. Results show an Appeal button and its status to the owner only.
  - Accepting as an alias adds the normalized input as an alias (`answer_aliases.source = 'appeal'`, kept across reseeds; a file label with the same key wins). It's refused if the key is ambiguous or already used by any answer.
  - **No retroactive rescoring:** frozen dailies stay equal for everyone. Genuinely new answers must go through data source → ETL → review, not appeals.
- **Unlimited:** category lines via `/play/unlimited?category=…` (home chips for categories with ≥3 approved questions; smaller categories return 422). Avoids questions from the player's last 4 sessions while fresh ones exist.
- **Localization:**
  - Locale comes from the cookie, else Accept-Language (q-weighted), else EN. `<html lang>` follows it.
  - Page titles, meta description, OG locale, skip link and nav landmarks are localized. The admin console is fully bilingual.
  - A unit test enforces FR parity for every EN string and function and flags untranslated copies. Another asserts every bundled question is bilingual.
- Migration `20261121000004_admin_review_appeals.sql`: `content_hash`, `question_reviews`, `answer_aliases.source`, appeal resolution columns, `players.name_updated_at`, indexes.

## Phase 7: Party mode (done 2026-11-21)
- **Realtime decision: polling** (~1 s) with ETag/304. It works on Vercel serverless with no extra service; Supabase Realtime needs hosted credentials and SSE runs into function duration limits. The client owns no clock: it renders countdowns from server deadlines plus a measured clock offset (`X-Server-Now`). Polls that started before an action are discarded. Swapping in Realtime later only changes how clients learn about a new view.
- **State machine:** `src/lib/game/party.ts` is pure and fully unit-tested. Stores keep one `RoomState` per room: memory map, or Postgres `party_rooms` jsonb under `SELECT … FOR UPDATE`. Time-based transitions (deadline → reveal 12 s → next round) are applied lazily by `tick` on any read or write, so no cron or background worker is needed. GET only writes when a transition is due or the caller's presence is stale (~7 s).
- **Rules:**
  - 5-character codes from an unambiguous alphabet, made with crypto randomness.
  - Up to 12 players; unique names per room (accent- and case-insensitive), validated like leaderboard names.
  - Joining is lobby-only; rejoining keeps your seat.
  - Host picks 3/5/7/10 questions and an optional category (≥3 questions).
  - The question set and scores are frozen at start, like the daily.
  - 25 s per answer (+1.5 s grace); ambiguous input asks for more detail without using up your answer.
  - A round closes early once every active player has answered.
  - Answers are hidden from others until the round closes.
  - The reveal shows everyone's answer, score, tier, and how many others said the same thing.
  - The host can skip the reveal; the host role moves on after 30 s of host silence.
  - Away players (no poll for 20 s) don't block rounds.
  - Rooms expire after 3 h of inactivity; dead rows are cleaned up opportunistically.
- **Party answers don't feed rarity stats.** Friends copying each other would skew the frequencies; only solo daily and Unlimited count.
- **API:** `POST /api/party` (create, 6/min), `GET /api/party/:code` (view, ETag, 240/min), `POST /api/party/:code {action: join|start|answer|next|leave}` (60/min). Views never include player ids.
- **UI:** `/party` (create/join; name prefilled from the leaderboard name), `/party/:code` (lobby with big code and invite link → question → reveal → final standings plus round-by-round recap). Bilingual; "Party" / "Entre amis" added to the nav.
- Migration `20261121000005_party_rooms.sql`.
- **Polling cost note:** each client makes ~1 request/s while in a room. That's fine at small scale; with heavy use, move to Supabase Realtime broadcast with the same view payloads.

## Phase 8: Tests + deploy (done 2026-11-21)
- **`GET /api/health`:** reports store, DB ping, approved-question count, today's date key, commit SHA and config problem *names* (no values). Returns 503 if anything is wrong. Config rules are in `src/lib/server/env.ts`:
  - On Vercel, `DATABASE_URL` and a 16+ character `RATE_LIMIT_SALT` are required.
  - Pool size must be 1–3.
  - Flags the session pooler (5432) being used on serverless.
  - Flags an `ADMIN_TOKEN` that is too short.
  - Locally, `REQUIRE_PROD_CONFIG=1` turns these checks on.
- **`npm run smoke -- <url>`** (`scripts/smoke.ts`): checks health, EN/FR pages, headers, the leaderboard API, Unlimited start, and party create/view/404. It never writes rarity stats or leaderboard rows.
- `npm run check` runs typecheck, lint, unit and ETL tests. A GitHub Actions workflow runs everything, including the DB tests and both E2E modes, on a Postgres service on every push and PR to GitHub.
- `.vercelignore` added; deploy steps are in `docs/DEPLOY.md`.
- **Verified locally:** production build, then `next start` on `montreallion_test` with production config. Smoke test: all checks pass.
- **Final test pass:**
  - Unit 123/123.
  - DB 14/14.
  - ETL 19/19.
  - E2E memory: 18 passed, 2 skipped.
  - E2E Postgres: 19 passed, 1 skipped.
  - typecheck and lint clean.
- **Deployed (2026-11-21):** https://montreallion.vercel.app, Vercel production.
  - Database: Neon Postgres (free plan, iad1) via the Vercel Marketplace, Production env only. Supabase was blocked by the account's 2-free-project limit, and the user chose Neon.
  - Migrated (5 migrations) and seeded with the unpooled URL.
  - `npm run smoke -- https://montreallion.vercel.app`: all 16 checks passed. Health reports postgres/ok, 15 approved questions, no config problems. After review #1 (commit `2924eeb`, 2026-11-22), health reports 49.
  - `/admin/login` is enabled.
- Code changes for hosting:
  - `POSTGRES_URL` fallback.
  - `src/lib/server/db-url.ts` strips provider query params; used by both the app and `scripts/db.ts`.
  - `scripts/db.ts` falls back to `POSTGRES_URL_NON_POOLING`.

## Content review #1 (2026-11-21, reviewer: Samuel)
The first human review of the 61 generated questions; decisions are in `etl/review/decisions.json`, pinned to content hashes.
- **Approved (34):**
  - Métro by borough: CDN–NDG, Plateau, Sud-Ouest, MHM, Verdun, Ville-Marie.
  - All 4 REM questions about stations, termini and branches.
  - Parks in 18 boroughs (all but Rosemont).
  - Libraries in 6 boroughs.
  - Playable bank is now 49 (15 seed + 34).
- **Rejected (13 + 1 dropped):**
  - All 12 `neighbourhood-in-area` questions: the source is the City's housing-reference zones, not real neighbourhood names (rework needed).
  - `gen-culture-venue`: galleries mixed into "performance venues".
  - `gen-library-in-ville-marie` is no longer generated: it fell to 2 answers after BAnQ was excluded.
- **ETL fixes (these 7 are back in review):**
  - Longueuil station name from the feed (`gtfs.NAME_FIXES`, case-insensitive "Station" prefix): yellow line and terminus.
  - Park names with ", suffix" (Parc Maisonneuve): Rosemont parks.
  - The library network keeps only the City's "Bibliothèque …" branches (drops BAnQ and the duplicate Montréal-Nord entry): network and Montréal-Nord library questions.
  - Everyday short forms for Espace pour la vie and the museums (Biodome, Insectarium, Planetarium, Botanical Garden, MEM…).
- **Pending a borough-line check (6):**
  - Fabre station (Rosemont vs Villeray) and Crémazie (Ahuntsic vs Villeray): affects 3 métro questions.
  - REM inside/outside the City (Canora, Côte-de-Liesse, Sunnybrooke).
  - Public-art artists: Riopelle missing, an architecture firm listed, unreliable estimates.

## Expansion B: answer double-check (deployed 2026-11-23)
Flow: type → **Check** (Enter) → MATCH FOUND / POSSIBLE MATCH / NOT RECOGNIZED panel → pick entity → **Confirm** (Enter) → reveal.
- `match.ts › checkAnswer`: same deterministic keys and conservative typo budget as `matchAnswer`.
  - Exact single entity ⇒ `match`. Typo or several entities ⇒ `possible`, and the player picks one.
  - A listed ambiguous input (e.g. "Richard") ⇒ the answers that contain it as whole words.
  - More than 4 candidates ⇒ `vague` (nothing listed). No prefix/autocomplete results, ever.
- `engine.check()` + `POST /api/game/:id/check`:
  - Never consumes the question. Returns labels only (no ids, scores, rarity or `est`).
  - State lives server-side in `sessions.precheck` (jsonb, migration `20261123000001`): key, candidate slugs, `at`, count.
  - `MAX_CHECKS = 3` distinct inputs per question (enumeration bound); re-checking the same input is free. Rate limit 120/min/IP (flood only).
- Final submit accepts `choice` (an index into the server's own candidate list).
  - It is refused (`bad_choice`, 409) unless the normalized input equals the checked key.
  - Declining every suggestion scores the input as typed (never swaps in another entity).
  - Unchecked submits (the timer ran out first) keep the old `matchAnswer` path.
- **Timer:** a check is accepted only before 25 s + 1.5 s. A timely check can be confirmed until `check.at + 6 s` (`CONFIRM_GRACE_MS`), and only for that same input. `serve()` doesn't auto-expire during the grace. Stored `elapsedMs` is capped at 26.5 s.
- Unknown-but-valid answers: the NOT RECOGNIZED panel points to the existing appeal flow on results.
- UI: `CheckPanel` in `game-client.tsx`. Radio group for disambiguation; buttons are at least 44 px; `aria-live` status; Edit refocuses the input; grace countdown shown. EN/FR strings added; how-to-play updated.
- **Party mode still uses one-shot submit** (retry on ambiguity). Follow-up if wanted.
- Tests:
  - Unit 181 (+17 in `tests/unit/precheck.test.ts`: accents/aliases/FR, typo, disambiguation, no-autocomplete, candidate cap, no leakage, forged/edited choices, check limit, duplicates, grace bounds, serve during grace).
  - DB 18 (+4 in `tests/integration/precheck.test.ts`: cross-instance confirm, concurrent checks ≤ MAX under row lock, 4 concurrent confirms ⇒ 1 row, grace across instances).
  - E2E memory: 22 passed, 2 skipped. E2E Postgres: 23 passed, 1 skipped. That includes 2 new double-check specs; full-daily specs got 60–90 s timeouts.
  - ETL 21 OK, typecheck/lint clean, `next build` OK.
- **Deployed:** migration `20261123000001` applied to Neon (unpooled URL), then a8b6928 was pushed to main. Health reports commit a8b6928, postgres ok, 49 questions. The smoke test passed. A live `/check` returned `none` without consuming the question, and a forged `choice` got `bad_choice`.

## Expansion C: content (2026-11-23): 201 / 200 new questions, all `in_review`
Generated by the ETL in `etl/montreallion_etl/templates/`: `expansion.py`, `wikilists.py`, `food.py` and `events.py`. No answer data is hand-written; every answer comes from a cited dataset or a revision-pinned list.

| Category | Spec target | Built |
|---|---|---|
| Food / restaurants | 50 | 106 |
| Festivals / cultural events | 35 | 31, plus 5 event questions filed as `sports` and the 1976 Olympic venues filed as `history` |
| History / museums / landmarks | 35 | 23 |
| Parks | 35 | 13 |
| Roads / bridges / transit | 30 | 13 |
| Neighbourhoods | 15 | 10 |

The category mix differs from the spec, as requested ("keep going on food and festivals"). The total is 5,842 answers, with at least 5 per question.

- **Food (`food.py`):**
  - An OpenStreetMap place counts only if the City food registry lists it as `Ouvert`, with the same cleaned name within 150 m. 2,090 places qualify.
  - Island-wide questions by cuisine or shop type: 38.
  - Per-borough or per-municipality questions: cafés, bakeries, restaurants, bars and fast food.
  - Chains count as one answer. "Restaurant X" and "X" are merged. Familiarity comes from the number of open locations plus a Wikidata brand.
- **Events (`events.py`):**
  - Fireworks Jupiter countries.
  - Francouvertes winners and podium finishers.
  - World Film Festival (FFM) Grand Prix des Amériques films and directors.
  - Documentary festival (RIDM) prize films and directors.
  - Fantasia films, in 3 eras.
  - Heavy Montréal lineups, in 4 eras.
  - Igloofest DJs.
  - Expo 67 pavilions: national, and other.
  - Québec City and Québec-region festivals, plus Québec music and film festivals.
  - Sports events: F1 drivers and teams at Gilles-Villeneuve, Grand Prix Cycliste winners and podium finishers, and the marathon.
- **Documented exclusions:**
  - The Judaism pavilion (typed "national" in the source).
  - Les Sommets du cinéma d'animation (a Montréal festival in the Québec City category).
  - 2 non-film italic links in the Fantasia article.
  - Olympic venues outside the Montréal area.
- **Pipeline:** sources are now de-duplicated by URL. A duplicate made the first seed attempt fail, and the transaction rolled back cleanly.
- **Tests:**
  - ETL: 33 OK, including Phase C helpers, Habitat 67 within 300 m, food merging, `{{Lien}}` cleaning and source de-duplication.
  - Vitest: 387. The content suite runs per question: provenance, licences, bilingual text, at least 5 unique answers, each answer matching itself, `in_review` only, and every food answer backed by the registry.
  - DB: 18. Typecheck and lint are clean.
  - Seeding `montreallion_test` twice gave 263 questions and 7,259 answers both times.
- **Deployed:**
  - Commits 8fc56b0 (7 review approvals) and 8c3b83a (Phase C) were pushed to main. Vercel built them, and health reports 8c3b83a with postgres ok.
  - Neon was seeded with `DATABASE_URL_UNPOOLED`. Before: 76 questions and 1,516 answers. After: 277 questions and 7,358 answers (56 approved, 207 in review, 14 rejected). The seed takes over 10 minutes over the network; each file goes in one transaction.
  - The prod smoke test passed 16/16.
  - The 201 Phase C questions are in review and not served yet.
- **Next:**
  1. Human review: `npm run etl:review -- --reviewer NAME` or `/admin`. Food questions only stay accurate while the registry and OSM snapshots are fresh, so re-run `etl:build` with `--refresh` before each release.
  2. Approved questions go live after `db:seed` against Neon. Admin-console approvals apply directly.

## Expansion D: map (2026-11-23)
- **`/map`** (`src/components/map/map-view.tsx`):
  - MapLibre GL 6.17.0 (pinned) on the OpenFreeMap `dark` basemap (OSM data, ODbL, no key). If the basemap fails, the page falls back to a plain local style.
  - 15 filterable layers in 7 groups. Clustering covers food, parks, heritage and gardens. Layers lazy-load: a layer's GeoJSON is fetched only when it's switched on (food is off by default).
  - Accent-insensitive search across the point layers. Popups show name, kind, area and size. The panel is responsive (overlay on mobile, side panel on desktop) and there's no sideways scroll.
- **Layers** (`python3 -m montreallion_etl map` → `public/map/*.geojson` + `index.json`, about 875 KB):
  - Boroughs and towns (34), neighbourhoods (91).
  - Autoroutes and numbered routes from OSM: refs ≤99 or ≥400 are A-, 100–399 are R-. Lines are merged and simplified.
  - Interchanges (OSM), bridges and tunnels (Wikipedia list → Wikidata P625).
  - Métro, REM and exo lines and 191 stations (GTFS).
  - Parks (815, centroid of the largest polygon), community gardens.
  - Heritage (City LPC sites plus national historic sites).
  - Museums, theatres, festivals (P625, or the P276 location's P625), skyscrapers.
  - 2,062 open food places. Each shows a generic kind only; no cuisine, which would reproduce food-question catalogs.
  - No layer carries question IDs, rarity or scores.
- **Gameplay link:**
  - `GET /api/game/:id/map` serves finished rides only, the same visibility as public results. For each stop it returns only the answers the results page reveals (match, 3 most common, 2 rarest) that have a position. Labels and coordinates only.
  - Positions come from the server-only `data/generated/answer-geo.json`, written by `etl:build`. 4,919 of 7,065 answers have one, each from its own source record: registry, GTFS, LPC, park, OSM or Wikidata P625. Nothing comes from name geocoding.
  - The results page has a "See this ride on the map" link, and there's a Map link in the header.
- **Tests:**
  - Unit 400 (+16): layer integrity, licences and bbox; no question-linked fields; all 19+15 areas; A-10/13/15/20/25/40/520 plus routes; landmark accuracy for 7 places; Berri inside Ville-Marie; answer-geo never imported by client code; pins ⊆ the revealed set, nothing for unfinished rides, no IDs or scores.
  - ETL 36 (+3). E2E 26 passed, 2 skipped (+4: map load, lazy layer, search popup, ride pins and 404, desktop and mobile). DB 18.
- **Refresh:** `npm run etl:build` (answer positions), then `cd etl && python3 -m montreallion_etl map` (layers; about 10 Wikidata queries at 1 per minute when not cached).

## Expansion E: Mount Royal climber (2026-11-23)
- **Model (`src/lib/game/climb.ts`, pure):**
  - Each correct answer climbs exactly its score in "steps". A miss or timeout climbs 0 and never falls back.
  - The lookout is at `SUMMIT_STEPS` = 350 (7 stops averaging 50 points). Position along the switchback staircase is proportional up to there.
  - Move style by tier: tourist and regular are short, expert and gem big, legend a leap.
  - Steps are labelled as gamified progress, not altitude.
- **Scene (`src/components/game/mount-royal-climb.tsx`):**
  - Original SVG art: mountain, switchback stairs, three parallax layers (stars and generic skyline, tree line, world), and a stylized lookout pavilion whose windows light up at the summit.
  - The camera follows the climber. Walking bob and leg swing; a leap arc and particle burst for legend answers and the summit.
  - With reduced motion, positions update instantly with no bob or burst.
  - Fixed aspect ratio, so there's no layout shift or cropping on mobile.
  - Shows steps out of 350, a progress bar and the best tier. It has a screen-reader description and a polite live region.
- **Placement:** on the game page (under the métro line) and the results page.
- **Persistence:**
  - Appearance (5 skin tones, 6 jackets, tuque, cap or no hat) is saved in localStorage `ml_look` and parsed defensively.
  - Climb progress comes from the server-side ride, so a reload restores it without replaying the animation.
  - Account sync is phase F.
- **Tests:** unit 405 (+5 climb: proportionality, no fall, move tiers, monotone staircase, look parsing). E2E 30 passed, 2 skipped (+4: steps == running score, a miss holds, look and progress survive reload, no sideways scroll, reduced-motion aria; desktop and mobile). DB 18.
- **Test harness:** the Playwright projects send distinct `x-forwarded-for` client addresses. The suite now starts more than 20 games a minute, the per-IP start limit. Production limits are unchanged.

## Expansion F: accounts + avatar (deployed 2026-11-24; auth switched from Supabase to Neon Auth on 2026-11-25)
- **Why the switch:** the Supabase account was at the 2-free-project limit. The user chose Neon Auth (managed Better Auth) on the existing Neon project: free up to 60k MAU, and no second provider.
- **Auth (`src/lib/server/auth.ts`):** email plus a 6-digit code. Sign-up, sign-in and recovery are one flow. Magic links aren't used because Neon's shared sender doesn't deliver them; codes need no SMTP.
  - Uses the `@neon/auth` 0.8.2 server SDK (`createNeonAuth`) from route handlers only. There's no client SDK and no proxy.
  - Session cookies are `__Secure-neon-auth.*`, signed with `NEON_AUTH_COOKIE_SECRET`.
  - The SDK's types omit the email-OTP methods, so `EmailOtpServer` types the runtime endpoints (`email-otp/send-verification-otp`, `sign-in/email-otp`).
  - Routes: `POST /api/auth/login` (5/min, no account enumeration), `POST /api/auth/verify` (10/min; links this device's guest player), `POST /api/auth/logout`, and `GET/PUT /api/me`.
  - The magic-link `/auth/callback` route is gone.
- **Test backend:** `AUTH_DEV_BACKEND=1` turns on an in-memory backend for E2E, since there's no local Neon Auth emulator.
  - It issues single-use 6-digit codes with a 10-minute TTL and 5 tries, readable at `/api/auth/dev-code`, which returns 404 otherwise.
  - `authConfig` refuses it on Vercel, and health reports it as a problem there. Playwright's web server sets it.
- **Profiles on Neon (migration `20261125000001_account_profiles.sql`):** `account_profiles(user_id text, display_name 2–20, appearance jsonb object < 2KB)`.
  - All reads and writes run inside a transaction under `set local role montreallion_account` with `montreallion.user_id` set to the verified user, so Postgres RLS enforces ownership.
  - The role can't log in or bypass RLS. It may select, insert its own row, and update only `display_name`, `appearance` and `updated_at`. It can't delete and can't touch any other table.
  - `account_players.user_id` is now text, because Better Auth ids aren't UUIDs. There's still no email column on the game database.
- **Avatar and stats:** unchanged. 8 layers, guest/account/achievement tiers, locked items rejected with 422, guest look carried over on first sign-in, stats aggregated across linked devices.
- **Tests:**
  - Unit 420, including `auth.test.ts` (config gating, code issue/verify/expiry/brute force) and Neon Auth env checks.
  - DB 20, including the profile RLS test: other users' rows invisible, update affects 0 rows, insert refused by RLS, delete/`user_id`/`created_at`/other tables refused, constraints.
  - E2E: 46 passed, 4 skipped (memory store); 47 passed, 3 skipped (Postgres store). Covers email code sign-in, wrong and reused codes, second device, carry-over, cosmetics, logout.
- **Removed:** `@supabase/*`, the `supabase` CLI, the `auth/` workdir, `auth:*` scripts, Supabase env checks and the CI role step. `supabase/migrations/` is still the game database's migration folder; it's just a name.
- **Blocked on the user (prod):**
  1. Enable Neon Auth on the production branch, with Email OTP and the domain.
  2. Set `NEON_AUTH_BASE_URL` and `NEON_AUTH_COOKIE_SECRET` in Vercel.
  3. Run `db:migrate` for `20261125000001`.
  Done 2026-11-25: migration applied, Neon Auth enabled, env set, redeployed. Production verified: `/api/me` reports configured, a real code send returns 200, a wrong code returns 400, `/api/auth/dev-code` returns 404, the email form renders on desktop and mobile, and both smoke tests pass. The first real sign-in (user's own inbox) is the only check left.

## Expansion G: polish, optimization, tests (deployed 2026-11-24 as e54a31d)
- **Visual:**
  - Forest-green and warm city-light accents: body glows plus the `--forest`, `--forest-deep` and `--glow` tokens.
  - Original mountain-and-skyline backdrop (`mountain-backdrop.tsx`) on the home hero and the 404 page.
  - Global `:focus-visible` outline.
- **Climb:**
  - The scene bleeds past both sides, so there's no letterboxing on wide screens.
  - The in-game (compact) view is a 144px strip with the title and progress overlaid on the sky, and the footnote is screen-reader only.
  - Result: the question, timer and answer box fit on the first screen at 1280×720 and on a Pixel 7.
- **Avatar panel:**
  - Larger preview on a small lookout scene, sticky on desktop.
  - The selected item shows a check in the primary colour; locked items are dashed.
  - Each layer lists what unlocks its locked items.
- **States:**
  - Themed bilingual `not-found`, route `error` (retry, no details shown), self-contained `global-error`, and root `loading`.
  - `OfflineBanner`: a fixed overlay, so no layout shift.
- **Bugs fixed:**
  - A network failure during check or answer left the game spinning forever; `post()` now resolves with status 0 and shows the offline message.
  - Account name save, look save and sign-out had the same uncaught failure.
  - The answer input wasn't focused when a question appeared: the effect ran before the input mounted after the AnimatePresence exit. Fixed with `autoFocus`.
- **Accessibility:**
  - The timer announces 10 and 5 seconds left to screen readers. The visual timer stays `aria-hidden`.
  - The game error view has a labelled retry button.
- **Performance:**
  - Measured on a Pixel 7 profile: CLS 0.000 on home, game, leaderboard, account and map. LCP is at most 0.5s locally.
  - About 690KB raw JS on home, mostly the React, Next and motion runtime. MapLibre (1MB) loads on `/map` only, and no server-only code is in client chunks.
  - `/map/*` and `/vendor/*` are cached 1h with stale-while-revalidate (they were `max-age=0`); pages are unaffected.
- **Tests:**
  - `tests/e2e/polish.spec.ts`: 404 in both languages, offline recovery, no horizontal overflow or layout shift on 6 pages, above-the-fold answer box with focus, keyboard customizer and skip link, timer screen-reader announcement, cache headers.
  - Totals: unit 414, ETL 36, DB/RLS 26, E2E 46 passed and 4 skipped with local auth. Typecheck and lint are clean.
- **Prod verified:** health ok (e54a31d, problems []), `smoke` and `smoke:map` pass, themed 404, map asset cache headers live (pages stay no-store). **Next:** account enablement steps under F (user).

## Content review #2 (2026-11-24, reviewer: "Samuel (via Claude)")
Claude read all 207 in-review questions at Samuel's request. For each one it checked whether the answers fit the prompt, looked for junk entries and checked whether well-known correct answers were missing. Decisions are in `etl/review/decisions.json`, pinned to content hashes.
- **Approved 174:** 230 playable questions after `db:seed` (15 seed + 215 generated). These include most Phase C food, festival, event, heritage, garden, museum, park, exo/bus, skyscraper, mall, bridge and Québec-region questions.
- **Held in review (33), with what to fix:**
  - Métro by borough (Ahuntsic-Cartierville, Rosemont, Villeray): fewer than 5 answers, or borderline-boundary stations (Jean-Talon, Fabre) still need the borough check.
  - Neighbourhoods (9): lists mix neighbourhoods with electoral districts, parks (Parc Jarry) and business parks (Montreal Technoparc, Cité de la Mode). Needs a real neighbourhood source.
  - Métro opening years (3): correct answers are missing: Berri-UQAM (1966), Charlevoix (1978), Côte-Sainte-Catherine (1982).
  - F1 winners: Gilles Villeneuve, Jacques Laffite and Alan Jones are missing from the drivers; Ligier is missing from the teams.
  - `gen-ev-ffm-gp-film`: answers include raw wiki markup (`[[…`, `{{Lien|…`).
  - Film festivals and festivals (any): "2022/2023/2024/2025 International Festival of Film on Art" appear as separate answers.
  - Québec film festivals outside Montréal: includes the Ottawa International Short Film Festival (Ontario).
  - Heritage churches: includes the Masonic temple; "Cathédrale Chris Church" is a typo.
  - National Historic Sites in Le Sud-Ouest: Bank of Montreal (Q4856154) is placed in this borough; check its location.
  - Food:
    - Bagel: St-Viateur and Fairmount are missing.
    - Ramen: only 5 answers, and Kinton and Misoya are missing.
    - Hot dog: Décarie Hot Dog and Montreal Pool Room are missing.
    - Wrong-cuisine answers: Portuguese has Biryani & co; chicken has Dairy Queen; seafood has 3 Brasseurs and Les Enfants Terribles; Korean has Misoya and Onigiri Shop; bubble tea has Frite & Bulle and Sandwicherie Sue; vegan has B12 Burger and Jonnyboy.
    - The Plateau restaurants question has a junk answer, "325 F | Cuisine malgache".
- Known limit of the approved food questions: answers are OSM places matched to the City's open-food registry, so some well-known places are absent and an answer is accepted only if it's in the list. Players can appeal a rejected answer from the results page.

## Map smoke de-flake (2026-11-25, 7edcb99)
- **Symptom:** `smoke:map` failed now and then: 1 in 5 local runs, 1 in 12 local runs, and CI on ca62252.
- **Root causes** (found with 27 instrumented page loads plus direct `curl` timing):
  1. MapLibre cancels in-flight OpenFreeMap tiles on zoom and pan (`net::ERR_ABORTED`). The smoke counted those as failed requests; that was the CI failure.
  2. OpenFreeMap (third-party) sometimes leaves tile and font requests hanging for 25s+. It's always the zoom-9 tiles over Montréal plus a Noto Sans glyph range: 4 of 15 rapid loads, likely worse under burst load. The same URLs via `curl` answer in about 0.13s (Cloudflare HIT), so the stall is intermittent and connection-level. The map's `data-rendered` summary was written only on MapLibre `idle`, which waits for every tile, so one stalled tile hid that our own layers had drawn.
- **Fixes:**
  - `map-view.tsx` also writes the summary 500 ms after any render.
  - `smoke-map.ts`:
    - Ignores OpenFreeMap tile aborts.
    - Splits the render check into "our layers rendered (transit lines, stations)", which must pass, and "base map + clusters (OpenFreeMap tiles and fonts)", which reloads once on a stall before failing.
    - Logs OpenFreeMap requests still pending after 10s.
- **Verified:**
  - Simulated stall (`page.route` holding the z9 tiles and fonts): the old code never reports; the new code reports 20 rail lines and 179 stations within 2s.
  - A stall that clears passes after one reload. A persistent stall fails with diagnostics.
  - 18 normal local runs and 3 prod runs pass; post-deploy CI is green on 7edcb99.
- **Player impact (open):** during an OpenFreeMap stall the base map and cluster counts stay blank until a refresh. Our layers are unaffected. If the smoke's stall warnings become frequent, move to a tile provider with an uptime guarantee or self-host the tiles (PMTiles).

## Start flow + full-screen 3D Mount Royal climb (deployed 2026-11-24 as 050a1f9, PR #3)
- **Pre-game screen (both modes):** `/play/*` shows rules, mode and the climber and a **Start game** button. No ride is created and no clock runs until Start.
  - `GET /api/game?mode=daily|session=<id>` → `engine.peek`: read-only and never creates or serves. `live` is true only while the served question can still be answered.
  - On open: a finished daily redirects to results. A *live* question resumes directly, with its server clock unchanged (refresh can't reset it). Anything else shows the pre-game screen with **Continue: stop n of 7**, which serves the next question without a new start. If the served question's window already closed, `peek` records it as expired first (exactly what the next serve would do; no clock starts), so Continue never offers a stop that can't be answered, and a lapsed last stop shows as finished.
  - Start is idempotent: the client sends `requestId` (a UUID), which becomes the session id. Retries and double clicks return the same ride, it can't claim another player's ride, and the daily stays one per player per day. A daily retried after midnight starts today's ride under a fresh id. Postgres `createSession` uses `on conflict do nothing` for both the id and the daily index. A conflict never hands back a ride of another mode or day: the engine and the store both refuse it, and the store throws instead of returning null.
  - The Unlimited ride id is kept per tab in `sessionStorage` (`ml_ride:<mode>:<category>`), so a refresh resumes it. "New ride instead" drops it.
- **Full-viewport game:** `game-client.tsx` renders a fixed overlay. The canvas sits under the translucent site header (which keeps language, sound and account). The HUD has leave, stop, score, climb readout and customizer, reset camera and display settings; the métro line has 7 stops. The question/answer panel is a left column on desktop and a bottom sheet (≤62dvh) on phones. The scene stays mounted from the pre-game screen through every round. Page scroll is locked while playing.
- **3D (`src/components/game/three/`, three 0.187.0 + @react-three/fiber 9.8.2; no drei, no physics):**
  - `stair3d.ts` (pure, unit-tested): 7 switchback flights of 24 treads (rise 0.17 m, run 0.34 m) with flat landings and a lookout plaza. `sampleStair(s)` puts the feet exactly on tread tops. `terrainHeight` is carved or embanked under the path, and the camera uses it to stay above ground. Tree and rock placement is seeded. `progressToPath(climbFraction(steps))` keeps the existing score→steps model (350 = top of the stairs): normalized progress, not altitude.
  - `climb-scene.tsx`: everything instanced (treads, landings, posts, rails, walls, lamps, trees ×3, rocks, ~150 city towers with a shared window texture). Dusk sky dome, stars, river, and an original stylized plaza and pavilion. About 45–53 draw calls. `frameloop="demand"`: frames render only while climbing, the camera settles, particles fly or the player orbits.
  - Climbing: the climber travels node by node toward the server-confirmed goal (gait phase = one tread per half cycle). Speed and effects depend on the move tier (legend: hops plus a particle burst). A miss gives a head shake and no gain. Only the stop answered live in this tab animates (`liveIndex` → `animate`); a restored ride (reload) is placed directly without replaying. At the summit the climber walks onto the plaza and celebrates.
  - Camera: behind and above, exponential damping. Limited orbit (drag), zoom (wheel/pinch) when idle, re-framing during movement, reset button, and a terrain floor. `setViewOffset` centres the climber in the area not covered by the panel or HUD. Portrait screens pull back.
  - `climber-3d.tsx`: builds the saved `Appearance` (skin, hair ×5, hair colour, jacket, pants, hat ×6, pack ×4, accessory ×7) in 3D from shared primitives, so existing looks carry over. Customizing (HUD palette) saves through the existing `useLook` (guest localStorage / account).
  - `climb-stage.tsx`: lazy `next/dynamic` chunk (~251 KB gzip, not in any page's initial JS). Settings `ml_gfx` = auto/low/high/2d. Auto picks low on coarse pointers, small screens or ≤4 cores, and drops to low if measured climb fps stays under 28 (three samples in a row of 45 consecutive moving frames; the first frame after an idle gap is skipped and the sample resets between climbs). Without WebGL, on a render error or after a second context loss, it falls back to the existing SVG climb. Reduced motion: no hops, bursts or celebration wave, faster and steadier camera.
  - QA hooks on the canvas: `data-s` (settled path position), `data-geometries`, `data-textures`. On the stage: `data-fps`, `data-calls` (written directly to the DOM, not React state, so telemetry never re-renders the scene).
  - **fps readout (b6de6c4):** `?fps=1` on any game page shows an overlay with the latest and lowest sampled climb fps, draw calls, mode, quality ("(auto)" when picked automatically) and the GPU name when the browser exposes it. Remembered per device (`localStorage` `ml_fps`); `?fps=0` turns it off. It's portaled to `<body>` (the stage's stacking context sits under the site header), sits top-left over the logo so it hides no game content, and is `aria-hidden` and `pointer-events-none`. It reads "climb to measure" until the first climb (fps is sampled only while moving). E2E in `polish.spec`.
- **Tests:**
  - Unit 607 (+`start-flow.test.ts` 8, +`stair3d.test.ts` 5). DB 21 (+ concurrent idempotent Start).
  - E2E memory 54 passed / 4 skipped; Postgres 55 / 3.
  - New `start.spec` (no start/serve before Start, double click = one ride, refresh keeps the clock, Continue after refresh) and `scene3d.spec`.
  - Playwright's desktop/mobile projects now run with `--disable-webgl`. That exercises the 2D fallback and keeps parallel workers from starving on software GL. The `webgl` project (SwiftShader) runs `scene3d.spec` after them. `map-render.spec` (MapLibre) re-enables WebGL.
- **Performance, measured honestly:** in headless SwiftShader (CPU rendering, no GPU) the climb runs at 9–14 fps with about 50 draw calls; that says nothing about GPU devices. Measured 2026-11-25 on an Apple M4 laptop (Chrome, Metal GPU), local prod build, 7 climbs per config: desktop 1440×900 @2x High (61 calls) and Auto (stayed High, 58 calls) held 60 fps (vsync cap; p95 frame 17.4–17.6 ms). Low (46 calls) got 55–60. Pixel 7 emulation on the same GPU, Auto→Low (45 calls), got 60. There was one first-climb hitch of 117–201 ms in two runs (likely shader warm-up). No phone measured yet.
- **Code review (2026-11-24), 8 findings fixed in 2293cca:** false Auto→low degrade (idle gap counted in fps), replayed climb after reload, Continue offering a lapsed stop, daily retry after midnight resuming yesterday, a conflicting create returning the wrong ride, scene re-render on every fps sample, "New ride" hard-coding 7 stops, unencoded ride id.
- **CI fix (139cb54):** `test:db` had failed on main since the Neon switch (803d804 removed the step creating `anon`/`authenticated`, which the schema lock-out and its RLS test still need). Restored. The admin-review integration test runs ~15 s against a 20 s limit and timed out once in CI (passed on rerun); raise its timeout if it recurs.
- **Deploy (050a1f9, merge of PR #3):** CI green. Prod verified: health ok (problems []), `smoke` and `smoke:map` pass. On desktop and Pixel 7 the lobby loads, the scene runs in 3D, Start serves a question, and there are no page errors. No DB migration was needed.
- **Open:** phone fps still unmeasured: open `/play/unlimited?fps=1` on a phone and play 2–3 stops. The local E2E suite flakes under 5 workers on software GL (baseline had 3 failures too; every failing test passes alone). three's console notes a `THREE.Clock` deprecation from R3F 9.8 (harmless).

## Phase H: question bank rebalancing (2026-11-25, deployed as 0e6c634; Neon seeded 2026-11-26)

- **230 vs 228 on the homepage:** the 230 total includes Universities (1) and Winter (1); `src/app/page.tsx` hides categories below `MIN_CATEGORY_QUESTIONS`, so the listed categories sum to 228. Counts already come from the live DB bank; nothing was wrong with the data.
- **Difficulty (easy / medium / hard), editorial and independent of rarity:** `etl/montreallion_etl/difficulty.py` (rules by question family; templates may set their own), `difficulty` on the ETL Candidate (not part of the content hash, so existing approvals survive), hand-set on the 15 seed questions, zod `questionSchema.difficulty`, migration `20261126000001_question_difficulty.sql` (additive, idempotent: nullable column + check constraint + index), written by `scripts/db.ts`. Validation rejects a candidate without one.
- **New verified templates** (`etl/montreallion_etl/templates/phaseh.py`), all from factual relationships:
  - Wikidata (CC0), 31 queries → 29 questions: Canadiens / Expos / Alouettes / CF Montréal / Maroons / Wanderers / Royals / Manic players, Hall of Fame members, Montréal-born athletes and people by occupation, mayors (P39), burials at Notre-Dame-des-Neiges and Mount Royal cemeteries, newspapers (P291), companies founded (P740), twin cities (P190), teams based in Montréal. Each answer keeps its QID, EN/FR labels, name variants that share a word with the label, and a sitelink signal; namesake French labels are dropped. The query URL is the cited source.
  - City open data (CC BY 4.0): borough/municipality neighbours from the official limits polygons (shared boundary ≥ 200 m; areas with < 3 neighbours skipped), areas each métro line serves (GTFS stations in polygons), streets per borough (Géobase), 2025 electoral districts per borough.
  - Answer cap raised for these large sets only (Wikidata relations 1000, streets 700; others stay 400).
- **Audit** (`npm run etl:audit` → `docs/QUESTION_AUDIT.md`), approved before → now / in review / approved + in review / target:

  | Category | Approved | In review | Approved + in review | Target |
  |---|---|---|---|---|
  | transit | 29 → 29 | 6 | 35 | 75 |
  | boroughs | 3 → 3 | 71 | 74 | 65 |
  | parks | 34 → 34 | 0 | 34 | 75 |
  | food | 97 → 97 | 10 | 107 | 100 |
  | history | 22 → 22 | 16 | 38 | 70 |
  | festivals | 39 → 39 | 4 | 43 | 70 |
  | sports | 4 → 4 | 20 | 24 | 45 |
  | total (incl. universities 1, winter 1) | 230 → 230 | 127 | 357 | 500 |

  Difficulty of approved + in review: easy 11%, medium 52%, hard 37% (target 40/40/20; too few easy questions). Duplicates: 0 identical prompts, 0 near-duplicate answer sets. Validation failures: 0 of 355 candidates. Rejected in human review: 13 (earlier reviews).
- **Playable count is unchanged (230):** all 94 new questions are `in_review` until a human approves them in `etl/review/decisions.json`. Spot-check flags for review: "companies founded in Montréal" includes Suncor, Siemens Canada and Tommy Hilfiger B.V.; twin cities include "Honolulu County"; the newspaper list is mostly obscure titles.
- **Remaining gaps** even if all in-review questions are approved: transit −40, parks −41, history −32, festivals −27, sports −21; total −143. No verified source has been found yet for the parks and transit shortfall; easy questions are the biggest difficulty gap.
- **Tests:** ETL 43/43 (new `etl/tests/test_phase_h.py`: difficulty rules, name variants, answer caps, adjacency on synthetic shapes; existing tests updated for the difficulty step). Vitest: new `tests/unit/phase-h-content.test.ts` + Phase C content + bank suites, 537 passed. `TEST_DATABASE_URL=postgres://localhost:5432/montreallion_test npm run test:db` 21/21; the test DB then holds 357 questions, all with a difficulty (230 approved). Typecheck and lint clean. Note: `test:db` silently skips every test without `TEST_DATABASE_URL`.
- **Neon (2026-11-26):** both migrations applied and `db:seed` run. Verified on Neon: 230 approved / 127 in review / 14 rejected (kept from earlier reviews), every approved and in-review question has a difficulty (approved: easy 34, medium 110, hard 86), 36 people questions, 21,153 answers. The ETL build takes ~40 min cold (Wikidata rate limit, ~1 query/min); cached rebuilds take ~1 min.

## Phase I: smart answer matching (2026-11-25, deployed as 2583851)

Most of the spec already existed from Expansion B: the double-check (preview never uses up the answer; 3 checks per question; rate-limited route), candidates held on the server and confirmed by index within the question's confirm window (the "short-lived candidate ids"; re-validated on submit), no rarity before the final submission, never swapping in an entity the player didn't pick, server-side timers, and appeals for valid unlisted answers. Added:

- **Surname-only answers for people** (`src/lib/game/match.ts`, `surnameKeys`): on questions marked `answerType: "person"`, the surname ("Lafleur", "Van Avermaet" / "Avermaet", hyphenated surnames kept whole) and first initial + surname ("G. Lafleur", "M. Richard") are accepted when **exactly one** eligible person has it. A shared surname is never accepted: the double-check lists the people to pick from (≤ 3), or says "be more specific" if more share it. Surnames are exact-only (no typo matching, prefixes or substrings); a full name or listed alias of another answer always wins. Duos, groups, single names and "(…)" labels get no surname.
- **People marker:** `answerType` on the question (zod, types, migration `20261126000002_question_answer_type.sql`, written by `db:seed`, read by `bank.ts`, which now also reads `difficulty`). Not in the content hash, so no approval changed. Set on the 2 people seed questions (retired Canadiens numbers, mayors 1960–2020), the 28 Wikidata people questions (in review), and 6 event/art questions: public-art artists, FFM Grand Prix directors, Grand Prix Cycliste winners and podium, marathon winners (approved) and F1 Canadian GP winners (in review). Bands and acts (Francouvertes, Igloofest, Heavy Montréal) and the RIDM directors (duos in labels) are deliberately not marked.
- **Abbreviations** in both normalizers (TS + Python, shared fixtures): av./ave → avenue, boul./blvd/bd → boulevard, Mt → Mont, Mtl → Montréal. The cached rebuild left every approval unchanged (215 / 127).
- **Candidates capped at 3** (was 4).
- **Deploy order:** `bank.ts` reads `difficulty` / `answer_type` through `to_jsonb(questions)`, so code deployed before Neon is migrated keeps working (both null, surname matching off). Surname matching goes live on production only after `db:migrate` (migrations `20261126000001` and `…02`) and `db:seed` on Neon.
- **Labels:** "Exact match" (typed the canonical name), "Match found" + "Did you mean …?" (alias or surname), "Possible match", "No verified match" (was "Not recognized"); FR equivalents.
- **Not done, deliberately:** pg_trgm / full-text search. Matching runs in memory on the cached bank (≤ 1000 answers per question), so per-check database search would add latency without changing results.
- **Tests:** new `tests/unit/smart-match.test.ts` (11: unique and shared surnames, initials, accents, too-many → vague, no typo/substring on surnames, full name beats surname, non-people questions unaffected, real seed questions, abbreviations). `npm run check` 725 unit tests, typecheck, lint clean. Parity 46/46 + ETL 43/43. `test:db` 21/21 (36 people questions in the test DB). E2E play + polish (desktop + mobile): 28 passed, 2 skipped on the second run; the first combined run had 5 desktop failures in `play.spec` that did not reproduce (6/6 alone, then 28/28 combined); errors not captured.

## Phase J: map popup readability (2026-11-25, deployed as 492dd4d)

- **Cause:** popups had no styling of their own. maplibre-gl.css paints them white, and they inherited the app's light text, so names were light-on-white.
- **Fix:** semantic tokens `--map-pop-bg/-heading/-text/-muted/-accent/-border` (the spec's palette) and popup rules in `src/app/globals.css`, unlayered and scoped to `.maplibregl-popup.ml-popup` so the MapLibre defaults can't win. Measured WCAG contrast on `#17212F`: heading 15.5:1, body 10.9:1, secondary 6.3:1, accent links 11.0:1 (AA is 4.5:1). Popup markup (`map-view.tsx`) uses `ml-pop-title / -sub / -meta` classes instead of utility opacity; the tip follows the border colour on every anchor; long names wrap (`overflow-wrap: anywhere`); width `min(18rem, 100vw − 2rem)`; 36 px close button with hover and focus-visible states, labelled in the current language ("Close" / "Fermer").
- **Unchanged:** the layer panel and search results already pass AA (dimmed text 6.5:1 or higher), so they weren't touched. Map data, layers and interactions are unchanged.
- **Tests:** `tests/e2e/map-render.spec.ts` adds two tests (desktop and a 412 px phone viewport, both run in the desktop and mobile projects): computed popup background, title/meta contrast ≥ 4.5:1, popup inside the viewport, no horizontal overflow, close button ≥ 32 px with its label, and closing works. 6/6 pass. Screenshots checked on desktop and Pixel 7. Typecheck and lint clean.
- **Gotcha:** the first test run served a stale build without the new CSS (popup still white); a clean `npm run build` fixed it. If a CSS change doesn't show up in E2E, rebuild first.

## Phase K: question selection (2026-11-26, deployed as 03cc6dc)

- **Daily and Unlimited picking** (`src/lib/game/daily.ts`, `pickQuestions`): weighted random order (seeded, over a pool sorted by id), then up to 4 passes that relax one rule at a time: difficulty quota (40/40/20 by largest remainder, 3/3/1 for 7 questions), then one question per category, then no near-duplicates (answer-set overlap ≥ 0.6 of the smaller set). A game is always filled if the pool allows it. `CATEGORY_WEIGHTS` (empty = equal) tunes how often a category appears. Dailies already played stay frozen in `daily_challenges`.
- **Measured on the real bank** (approved easy/medium/hard 34/110/86): 364 of 365 simulated Dailies got exactly 3/3/1 (one got 4/3/0), averaging 7 categories a day.
- **Unlimited difficulty filter:** `?difficulty=easy|medium|hard` (API body field, Unlimited only, combines with `?category=`), filtered on the stored difficulty; a filtered pool needs ≥ `MIN_CATEGORY_QUESTIONS`. Homepage chips with live counts (`difficulty-<id>`), lobby label, EN/FR labels.
- **Tests:** new `tests/unit/selection.test.ts` (quota, category + mix, determinism, near-duplicates, fallback, weights, 120 real Dailies, Unlimited filter). `npm run check` 734 unit tests, typecheck, lint clean. New E2E test in `phase6.spec.ts` (chip count = approved hard questions; both questions played are hard). E2E phase6 + play (desktop + mobile): the first run had 1 desktop failure in the full-Daily test that passed alone and did not recur; next full run 20 passed, 2 skipped (admin needs Postgres). Note: `--repeat-each` trips the game-start rate limit (20/min per IP), so repeated runs fail with "Slow down a little".

## Phase L: regression tests and live verification (2026-11-26)

- **Coverage map** (spec item → suite): category totals and the 500 target, unique questions and provenance → `phase-l`, `phase-h-content`; 40/40/20 mix → `selection`; exact/fuzzy, accents, surnames, ambiguous surnames, candidate choice and confirmation, false positives → `precheck`, `smart-match`, `normalize-match`; rate limiting and enumeration → `phase-l` (memory), `test:db` (shared Postgres window), `precheck` (MAX_CHECKS); Daily timer and attempt limits → `engine`, `precheck`; migration safety → `phase-l` + `test:db`; popup contrast/responsive → `map-render.spec`; homepage counts → `phase6.spec`; rarity integrity → `scoring-daily`, `rarity-board`, `test:db`; auth and 3D → `account`/`auth`, `scene3d`/`climb` specs.
- **New tests:** `tests/unit/phase-l.test.ts` (9: rate limit per window/scope/client; migrations timestamped, never destructive, Phase H+ statements re-runnable; `QUESTION_AUDIT.md` counts equal the bank files per category and total; the 500 gap is computed, not padded; only approved questions playable). `test:db`: re-applying the Phase H/I migrations and `migrate()` again leaves every question, difficulty, answer type and answer count unchanged. E2E: homepage total and every category chip equal the approved bank; categories under the minimum are hidden.
- **Results:** `npm run check` 743 unit tests, typecheck, lint clean; `test:db` 22/22; production build OK; full Playwright (desktop, mobile, webgl) 67 passed, 5 skipped. These ran with the uncommitted character-save fix in the working tree.
- **Live check (montreallion.vercel.app, after 03cc6dc):** "230 reviewed questions in service"; category chips transit 29, boroughs 3, parks 34, food 97, history 22, festivals 39, sports 4 (universities and winter hidden); difficulty chips 34 / 110 / 86, all equal to the approved bank and to Neon. `/`, `/play/daily`, `/play/unlimited?difficulty=hard`, `/map`, `/account`, `/leaderboard`, `/how-to-play` return 200 in 0.12–0.24 s. No live game was played (it would write to production).
- **Optimization:** none needed for these phases. Matching and selection run in memory on the 5-minute cached bank, and response times above are unchanged; no new dependencies.
- **Still open:** 127 questions await human review; 143 short of 500 even if all are approved (see Phase H). Phase L adds tests and docs only, so pushing it changes no runtime code.

## Content review #3 (2026-11-26, reviewer: "Samuel (via Claude)")

- **Approved 115** of the 127 in-review questions (89 of the 94 Phase H questions and 26 of the 33 held from review #2), recorded in `etl/review/decisions.json` pinned to each content hash and applied by a cached `etl:build` (only `reviewStatus` changed). Approved now 345 (was 230): transit 35, boroughs 74, parks 34, food 103, history 32, festivals 41, sports 24, universities 1, winter 1. Difficulty of approved: easy 35 (10%), medium 180 (52%), hard 130 (38%).
- **Kept in review (12), to fix before approval:** festivals and film festivals in Montréal (yearly editions listed as separate answers); companies founded in Montréal (subsidiaries/holding companies, Suncor, Siemens Canada, Tommy Hilfiger B.V.); twin cities ("Honolulu County", formal twinnings mixed with cooperation agreements); protected churches (typo "Cathédrale Chris Church"); seafood, chicken, hot-dog and bagel spots (answers in the wrong category, e.g. 3 Brasseurs, B12 Burger Acadie, Café Dépôt); newspapers (mostly obscure titles); actors and singers born in Montréal (labelled easy despite long, obscure answer lists).
- **Tests:** unit 858 passed (bank-dependent suites re-checked on the larger bank, including the Daily mix on ≥ 95% of days).
- **Not yet live:** needs a commit and `db:seed` on Neon.

## Blockers
- Content: 345 approved in the bank files (230 on Neon until the next `db:seed`); 12 held in review with known defects (see Content review #3). Reaching 500 needs 143 more from new verified sources (see Phase H gaps).
- Repo: own git repo, remote https://github.com/SMLG120/montreallion (public, `main`). The Vercel project is Git-connected: pushes to `main` deploy to production, other branches get preview URLs.
