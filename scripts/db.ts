/**
 * Database CLI (runs on Node 24 with native TypeScript stripping).
 *   node scripts/db.ts migrate   apply supabase/migrations/*.sql in order (tracked in app_migrations)
 *   node scripts/db.ts seed      upsert data/seed/questions.json into the question bank
 *   node scripts/db.ts export-reviews  write console reviews of generated questions to etl/review/decisions.json
 *   node scripts/db.ts reset     DROP + recreate the public schema (local *_dev / *_test databases only)
 * Reads DATABASE_URL (use the Supabase *direct* or session connection string for migrations).
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";
import { cleanDbUrl, isLocalDb } from "../src/lib/server/db-url.ts";
import { questionContentHash } from "../src/lib/game/content-hash.ts";
import { normalizeAnswer } from "../src/lib/game/normalize.ts";
import { bankFileSchema } from "../src/lib/game/schema.ts";

const ROOT = join(import.meta.dirname, "..");
const MIGRATIONS = join(ROOT, "supabase", "migrations");

const CATEGORIES: [string, string, string][] = [
  ["transit", "Métro & transit", "Métro et transport"],
  ["boroughs", "Boroughs & neighbourhoods", "Arrondissements et quartiers"],
  ["parks", "Parks & landmarks", "Parcs et repères"],
  ["food", "Food", "Bouffe"],
  ["history", "History", "Histoire"],
  ["festivals", "Festivals & culture", "Festivals et culture"],
  ["sports", "Sports", "Sports"],
  ["universities", "Universities", "Universités"],
  ["winter", "Winter", "Hiver"],
  ["slang", "Slang & hidden gems", "Expressions et trésors cachés"],
];

type Sql = ReturnType<typeof postgres>;

export function connect(url = process.env.DATABASE_URL || process.env.POSTGRES_URL_NON_POOLING): Sql {
  if (!url) throw new Error("DATABASE_URL is not set");
  return postgres(cleanDbUrl(url), { prepare: false, max: 1, onnotice: () => {}, ssl: isLocalDb(url) ? false : "require" });
}

export async function migrate(sql: Sql, log = console.log) {
  await sql`create table if not exists app_migrations (name text primary key, applied_at timestamptz not null default now())`;
  await sql`alter table app_migrations enable row level security`;
  const done = new Set((await sql<{ name: string }[]>`select name from app_migrations`).map((r) => r.name));
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) {
    if (done.has(f)) continue;
    const body = readFileSync(join(MIGRATIONS, f), "utf8");
    await sql.begin(async (tx) => {
      await tx.unsafe(body);
      await tx`insert into app_migrations (name) values (${f})`;
    });
    log(`applied ${f}`);
  }
}

const BANK_FILES = [join(ROOT, "data", "seed", "questions.json"), join(ROOT, "data", "generated", "questions.generated.json")];

export async function seed(sql: Sql, log = console.log) {
  for (const file of BANK_FILES) await seedFile(sql, file, log);
}

async function seedFile(sql: Sql, file: string, log: (m: string) => void) {
  const bank = bankFileSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  const generated = file.includes("generated");
  await sql.begin(async (tx) => {
    await tx`insert into rarity_models (id, kind, description)
             values (${bank.rarityModel}, 'estimated', 'Editor-estimated familiarity weights; score = 100 - 90 * est / max(est)')
             on conflict (id) do nothing`;
    for (const [i, [id, en, fr]] of CATEGORIES.entries()) {
      await tx`insert into categories (id, label_en, label_fr, sort) values (${id}, ${en}, ${fr}, ${i})
               on conflict (id) do update set label_en = excluded.label_en, label_fr = excluded.label_fr, sort = excluded.sort`;
    }
    for (const q of bank.questions) {
      const hash = questionContentHash(q);
      await tx`insert into questions (id, category_id, scope, prompt_en, prompt_fr, eligibility_en, eligibility_fr, verification, review_status, ambiguous_keys, bank_version, est_basis, generator, content_hash)
               values (${q.id}, ${q.category}, ${q.scope}, ${q.prompt.en}, ${q.prompt.fr}, ${q.eligibility.en}, ${q.eligibility.fr},
                       ${q.verification}, ${q.reviewStatus}, ${q.ambiguous ?? []}, ${bank.version}, ${q.estBasis ?? "editor-estimate"},
                       ${q.generator ? tx.json(q.generator) : null}, ${hash})
               on conflict (id) do update set category_id = excluded.category_id, scope = excluded.scope,
                 prompt_en = excluded.prompt_en, prompt_fr = excluded.prompt_fr, eligibility_en = excluded.eligibility_en,
                 eligibility_fr = excluded.eligibility_fr, verification = excluded.verification, review_status = excluded.review_status,
                 ambiguous_keys = excluded.ambiguous_keys, bank_version = excluded.bank_version,
                 est_basis = excluded.est_basis, generator = excluded.generator, content_hash = excluded.content_hash,
                 version = questions.version + 1, updated_at = now()`;

      await tx`delete from question_sources where question_id = ${q.id}`;
      for (const s of q.sources) {
        const [src] = await tx<{ id: number }[]>`
          insert into sources (title, url, license, retrieved) values (${s.title}, ${s.url}, ${s.license}, ${s.retrieved})
          on conflict (url) do update set title = excluded.title, license = excluded.license, retrieved = excluded.retrieved
          returning id`;
        await tx`insert into question_sources (question_id, source_id) values (${q.id}, ${src.id})`;
      }

      // Answers are upserted by slug so existing submissions keep their foreign keys.
      const slugs = q.answers.map((a) => a.id);
      await tx`delete from answers where question_id = ${q.id} and slug <> all(${slugs})`; // fails if a removed answer was ever played
      await tx`delete from answer_aliases where question_id = ${q.id} and source = 'seed'`;
      // A file label/alias always wins over an appeal alias with the same key.
      const fileKeys = q.answers.flatMap((a) => [a.en, a.fr ?? "", ...a.aliases]).map(normalizeAnswer).filter(Boolean);
      await tx`delete from answer_aliases where question_id = ${q.id} and source = 'appeal' and normalized_key = any(${fileKeys})`;
      for (const a of q.answers) {
        const [row] = await tx<{ id: number }[]>`
          insert into answers (question_id, slug, label_en, label_fr, est_weight, refs) values (${q.id}, ${a.id}, ${a.en}, ${a.fr ?? null}, ${a.est}, ${a.refs ?? []})
          on conflict (question_id, slug) do update set label_en = excluded.label_en, label_fr = excluded.label_fr, est_weight = excluded.est_weight, refs = excluded.refs
          returning id`;
        const seen = new Set<string>();
        const forms: [string, boolean][] = [[a.en, true], ...(a.fr ? [[a.fr, true] as [string, boolean]] : []), ...a.aliases.map((x): [string, boolean] => [x, false])];
        for (const [alias, isLabel] of forms) {
          const key = normalizeAnswer(alias);
          if (!key || seen.has(key)) continue;
          seen.add(key);
          // Unique (question_id, normalized_key) rejects a key shared by two answers.
          await tx`insert into answer_aliases (answer_id, question_id, alias, normalized_key, is_label)
                   values (${row.id}, ${q.id}, ${alias}, ${key}, ${isLabel})`;
        }
      }
      // An admin review made in the console survives reseeding as long as the content it reviewed is unchanged.
      await tx`update questions q set review_status = r.status
               from (select distinct on (question_id) question_id, status, content_hash from question_reviews
                     where question_id = ${q.id} order by question_id, created_at desc, id desc) r
               where q.id = r.question_id and r.content_hash = ${hash}`;
    }
    if (generated) {
      // Generated questions that vanished from the ETL output are retired (kept for FK history, never played).
      const ids = bank.questions.map((q) => q.id);
      const retired = await tx`update questions set review_status = 'rejected', updated_at = now()
                               where id like 'gen-%' and id <> all(${ids}) and review_status <> 'rejected' returning id`;
      if (retired.length) log(`retired ${retired.length} generated questions no longer produced by the ETL`);
    }
  });
  const approved = bank.questions.filter((q) => q.reviewStatus === "approved").length;
  log(`seeded ${bank.questions.length} questions from ${file.split("/").slice(-2).join("/")} (${bank.version}; ${approved} approved)`);
}

/** Writes console reviews of generated questions back to etl/review/decisions.json (ETL content hashes). */
export async function exportReviews(sql: Sql, log = console.log, file = join(ROOT, "etl", "review", "decisions.json")) {
  const decisions = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  const rows = await sql<{ question_id: string; status: string; reviewer: string; note: string | null; date: string; etl_hash: string }[]>`
    select distinct on (r.question_id) r.question_id, r.status, r.reviewer, r.note, r.created_at::date::text as date, q.generator->>'contentHash' as etl_hash
    from question_reviews r join questions q on q.id = r.question_id
    where q.generator is not null and r.content_hash = q.content_hash and r.status in ('approved', 'rejected')
    order by r.question_id, r.created_at desc, r.id desc`;
  for (const r of rows) {
    decisions[r.question_id] = { status: r.status, contentHash: r.etl_hash, reviewer: r.reviewer, date: r.date, ...(r.note ? { note: r.note } : {}) };
  }
  const sorted = Object.fromEntries(Object.entries(decisions).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(file, JSON.stringify(sorted, null, 2) + "\n");
  log(`exported ${rows.length} reviews → etl/review/decisions.json (re-run npm run etl:build to publish them to data/generated)`);
}

export async function reset(sql: Sql, url = process.env.DATABASE_URL ?? "") {
  const local = /@(localhost|127\.0\.0\.1)|^postgres:\/\/\/|host=\/tmp|^postgres:\/\/[^@]*\/[^/]*$/.test(url) || !url.includes("@");
  if (!local || !/_(dev|test)(\?|$)/.test(url)) throw new Error("reset is only allowed on local *_dev or *_test databases");
  await sql.unsafe("drop schema public cascade; create schema public;");
}

if (import.meta.main) {
  const cmd = process.argv[2];
  const sql = connect();
  try {
    if (cmd === "migrate") await migrate(sql);
    else if (cmd === "seed") await seed(sql);
    else if (cmd === "export-reviews") await exportReviews(sql);
    else if (cmd === "reset") {
      await reset(sql);
      await migrate(sql);
      await seed(sql);
    } else throw new Error("usage: node scripts/db.ts migrate|seed|reset|export-reviews");
  } finally {
    await sql.end();
  }
}
