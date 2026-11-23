# Montréallion — Project State

_Last updated: 2026-11-21 · Phases 1–8 complete · LIVE at https://montreallion.vercel.app (Vercel + Neon Postgres); smoke test passed against production — see docs/DEPLOY.md_

## What it is
Original, bilingual (EN/FR) Montréal rarity trivia game. 7 open-ended questions per ride, 25 s each, rarer valid answers score more (10–100). It borrows the general rarity-quiz idea only; no Krillion branding, code, art or content.

## Stack (installed versions)
Next.js 16.4 (App Router, Turbopack) · React 19.3 · TypeScript · Tailwind 4.3 · shadcn/ui (base-nova, Base UI) · motion · zod 4 · Vitest 5 · Playwright. Node 24.
postgres.js 3 (server-only DB client). Python 3 ETL (stdlib only) in `etl/`. Not yet added: Supabase Auth (optional, later), Vercel deploy (Phase 8).

## Architecture
```
data/seed/questions.json      Hand-built seed bank (15 approved questions)
data/generated/questions.generated.json  ETL output (61 candidates, all in_review); same schema + provenance
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
- Only 15 questions (target 500+ via Phase 4 ETL).

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
  - `npm run smoke -- https://montreallion.vercel.app`: all 16 checks passed. Health reports postgres/ok, 15 approved questions, no config problems.
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

## Blockers
- Content: 49 playable questions; 13 generated ones await review (7 fixed, 6 need borough checks); neighbourhood template needs a new source.
- Repo: own git repo, remote https://github.com/SMLG120/montreallion (public, `main`). The Vercel project is Git-connected: pushes to `main` deploy to production, other branches get preview URLs.
