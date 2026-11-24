# Deploying Montréallion (Vercel + Postgres)

**Live:** https://montreallion.vercel.app (Vercel project `smlg120s-projects/montreallion`).

**Database:** Neon Postgres `montreallion-db` (free plan, iad1), provisioned via the Vercel Marketplace and connected to **Production only**.
- Supabase was the first choice, but the account was at Supabase's 2-free-project limit.
- The app is plain Postgres (postgres.js), so any provider works.
- It reads `DATABASE_URL`, falling back to `POSTGRES_URL`.
- Provider query params (`sslmode`, `channel_binding`, `supa`, `pgbouncer`) are stripped in `src/lib/server/db-url.ts`.

**Migrate or seed production:**
```sh
vercel env pull <private-file> --environment production
DATABASE_URL="$DATABASE_URL_UNPOOLED" npm run db:migrate   # and db:seed
```
- Use the *unpooled* URL for migrations.
- Seeding over the network takes roughly 10 minutes, because it makes many small round trips inside one transaction.

**Production env:**
- Set by Neon: `DATABASE_URL` (pooled) and friends.
- Added by hand: `DATABASE_POOL_MAX=1`, `RATE_LIMIT_SALT` (sensitive), `ADMIN_TOKEN` (sensitive; a local copy is in `.vercel/admin-token.txt`, mode 600).

**Previews:** preview deployments have no DB env, so they refuse to run game requests. This is on purpose: previews must not write production data.

## Generic setup (Supabase or any Postgres)

## 1. Supabase
1. Create a project. The region **ca-central-1 (Montréal)** keeps the data in Québec. Save the database password.
2. Under Project Settings → Database → Connection string, copy two URLs:
   - **Session pooler / direct (port 5432)**, for migrations and seeding from your machine.
   - **Transaction pooler (port 6543)**, for Vercel (`DATABASE_URL`).
3. From this folder:
   ```sh
   DATABASE_URL='<5432 url>' npm run db:migrate
   DATABASE_URL='<5432 url>' npm run db:seed
   ```
   - The app never uses supabase-js or the anon key.
   - Every table has RLS enabled with no policies, so the auto-generated REST API exposes nothing.
   - Only the server, which holds the connection string, can read or write.

## 2. Vercel
1. Import the project, either from a git repo or with `npx vercel` in this folder. The framework is Next.js and the build command is the default.
2. Set the **Function Region** to the one closest to the Supabase region (e.g. `iad1` for ca-central-1). Each request makes several DB round trips.
3. Environment variables (Production, and Preview if you want previews to work):

   | Variable | Value |
   |---|---|
   | `DATABASE_URL` | transaction-pooler URL (port 6543) |
   | `DATABASE_POOL_MAX` | `1` |
   | `RATE_LIMIT_SALT` | `openssl rand -base64 32` |
   | `ADMIN_TOKEN` | `openssl rand -base64 32` (optional; the admin console stays disabled without it) |

   - Without `DATABASE_URL`, a Vercel deployment throws rather than falling back to the memory store.
4. Deploy.

## 3. Verify (required before calling it live)
```sh
npm run smoke -- https://<deployment-url>
```
- `/api/health` must report `ok: true`, `store: "postgres"` and `db: "ok"`, plus at least 7 approved questions.
- If anything is misconfigured, it returns 503 and lists which settings are wrong, without showing their values.
- The smoke test never writes rarity stats or leaderboard rows. It creates one throwaway party room, which expires, and one empty Unlimited session.

## Operations
- **Content:** generated questions arrive `in_review` and only become playable once approved.
  - Approve them either with `npm run etl:review -- approve <id> --reviewer <you>` followed by `npm run etl:build && db:seed`, or in `/admin`.
  - To keep console decisions in the ETL file, run `db:export-reviews`.
- **Migrations** are forward-only and tracked in `app_migrations`. Run `db:migrate` before deploying code that needs them.
- **Party polling** costs about 1 request/s per player in a room. Keep an eye on Vercel function invocations.

## Accounts (phase F): Supabase Auth project
1. Create a Supabase project, ideally in us-east-1, near the Neon database in iad1. It holds only auth users and profiles.
2. Apply the schema: `npx supabase link --workdir auth --project-ref <ref>`, then `npx supabase db push --workdir auth`. Alternatively, paste `auth/supabase/migrations/*.sql` into the SQL editor.
3. In Auth → URL Configuration:
   - Site URL: `https://montreallion.vercel.app`
   - Redirect URL: `https://montreallion.vercel.app/auth/callback`
4. In Auth → SMTP, set a custom SMTP provider (e.g. Resend). Supabase's default sender only delivers to project team members and is heavily rate-limited.
5. In Vercel → Production env, set `SUPABASE_URL` and `SUPABASE_ANON_KEY` (or `SUPABASE_PUBLISHABLE_KEY`). Never add a service-role key; the app doesn't use one, and `/api/health` flags it.
6. Run the Neon migration `20261123000002_accounts.sql` with `npm run db:migrate`, using the env-pull recipe above.
