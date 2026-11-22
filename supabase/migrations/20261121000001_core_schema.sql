-- Montréallion core schema (Phase 3).
-- Portable Postgres (15+) so it runs on Supabase and on a plain local Postgres.
-- All tables are server-only: RLS is enabled with NO policies for anon/authenticated,
-- and the app connects as the table owner (server only), which RLS does not restrict.

create extension if not exists pgcrypto;

-- ---------- Enums ----------
create type geo_scope as enum ('city', 'island', 'agglomeration', 'greater', 'province');
create type verification_kind as enum ('source-checked', 'editor-curated');
create type review_status as enum ('draft', 'in_review', 'approved', 'rejected');
create type game_mode as enum ('daily', 'unlimited');
create type submission_status as enum ('correct', 'incorrect', 'expired');
create type match_kind as enum ('exact', 'fuzzy');
create type rarity_tier as enum ('legend', 'gem', 'expert', 'regular', 'tourist');
create type appeal_status as enum ('open', 'accepted', 'rejected');

-- ---------- Question bank ----------
create table if not exists categories (
  id text primary key,
  label_en text not null,
  label_fr text not null,
  sort smallint not null default 0
);

create table if not exists sources (
  id bigint generated always as identity primary key,
  title text not null,
  url text not null unique,
  license text not null,
  retrieved date not null
);

create table if not exists questions (
  id text primary key check (id ~ '^[a-z0-9-]+$'),
  category_id text not null references categories (id),
  scope geo_scope not null,
  prompt_en text not null,
  prompt_fr text not null,
  eligibility_en text not null,
  eligibility_fr text not null,
  verification verification_kind not null,
  review_status review_status not null default 'draft',
  ambiguous_keys text[] not null default '{}',
  bank_version text not null,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists questions_published_idx on questions (category_id) where review_status = 'approved';

create table if not exists question_sources (
  question_id text not null references questions (id) on delete cascade,
  source_id bigint not null references sources (id) on delete restrict,
  primary key (question_id, source_id)
);

create table if not exists answers (
  id bigint generated always as identity primary key,
  question_id text not null references questions (id) on delete cascade,
  slug text not null check (slug ~ '^[a-z0-9-]+$'),
  label_en text not null,
  label_fr text,
  -- Editor-estimated familiarity weight (1-100). NOT measured data.
  est_weight smallint not null check (est_weight between 1 and 100),
  unique (question_id, slug)
);

create table if not exists answer_aliases (
  id bigint generated always as identity primary key,
  answer_id bigint not null references answers (id) on delete cascade,
  question_id text not null references questions (id) on delete cascade,
  alias text not null,
  normalized_key text not null,
  is_label boolean not null default false -- true for the canonical EN/FR labels
);
create index if not exists answer_aliases_answer_idx on answer_aliases (answer_id);

-- Includes canonical labels: one normalized key may never point at two answers of one question.
create unique index if not exists answer_aliases_key_unique on answer_aliases (question_id, normalized_key);

-- ---------- Rarity ----------
create table if not exists rarity_models (
  id text primary key,
  kind text not null check (kind in ('estimated', 'statistical')),
  description text not null,
  created_at timestamptz not null default now()
);

-- Observed correct-answer frequencies (inputs for the Phase 5 statistical model).
create table if not exists answer_stats (
  answer_id bigint primary key references answers (id) on delete cascade,
  question_id text not null references questions (id) on delete cascade,
  correct_count integer not null default 0,
  updated_at timestamptz not null default now()
);
create table if not exists question_stats (
  question_id text primary key references questions (id) on delete cascade,
  attempts integer not null default 0,
  correct integer not null default 0,
  updated_at timestamptz not null default now()
);

-- ---------- Players & daily challenges ----------
create table if not exists players (
  id uuid primary key,
  auth_user_id uuid unique, -- optional Supabase Auth link (later phase)
  display_name text check (char_length(display_name) between 1 and 32),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create table if not exists daily_challenges (
  date_key date primary key,
  question_ids text[] not null check (cardinality(question_ids) between 1 and 20),
  rarity_model_id text not null references rarity_models (id),
  bank_version text not null,
  -- Frozen scoring: { questionId: { answerSlug: { "score": int, "share": num } } }
  score_snapshot jsonb not null,
  created_at timestamptz not null default now()
);

-- ---------- Sessions & submissions ----------
create table if not exists sessions (
  id uuid primary key default gen_random_uuid(),
  player_id uuid not null references players (id) on delete cascade,
  mode game_mode not null,
  date_key date references daily_challenges (date_key),
  rarity_model_id text not null references rarity_models (id),
  question_ids text[] not null,
  current_index smallint not null default 0,
  served_at timestamptz,
  total_score integer not null default 0,
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  check ((mode = 'daily') = (date_key is not null)),
  check (current_index between 0 and cardinality(question_ids))
);
-- One daily session per player per day.
create unique index if not exists sessions_one_daily_per_player on sessions (player_id, date_key) where mode = 'daily';
create index if not exists sessions_daily_leaderboard_idx on sessions (date_key, total_score desc) where finished_at is not null;

create table if not exists submissions (
  id bigint generated always as identity primary key,
  session_id uuid not null references sessions (id) on delete cascade,
  position smallint not null check (position >= 0),
  question_id text not null references questions (id),
  input text not null check (char_length(input) <= 120),
  status submission_status not null,
  answer_id bigint references answers (id),
  matched_by match_kind,
  score smallint not null check (score = 0 or score between 10 and 100),
  tier rarity_tier,
  share real,
  elapsed_ms integer not null check (elapsed_ms >= 0),
  created_at timestamptz not null default now(),
  -- One answer per question per session, enforced by the database.
  unique (session_id, position),
  check ((status = 'correct') = (answer_id is not null)),
  check (status = 'correct' or score = 0)
);
create index if not exists submissions_question_idx on submissions (question_id, answer_id);

-- ---------- Appeals (UI arrives later; table defined now) ----------
create table if not exists appeals (
  id bigint generated always as identity primary key,
  submission_id bigint not null references submissions (id) on delete cascade,
  player_id uuid not null references players (id) on delete cascade,
  note text check (char_length(note) <= 500),
  status appeal_status not null default 'open',
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  unique (submission_id)
);

-- ---------- Rate limiting ----------
create table if not exists rate_limits (
  key text primary key, -- scope + salted hash of client IP, never the raw IP
  window_start timestamptz not null,
  count integer not null
);

-- ---------- Row Level Security: deny-by-default for client roles ----------
do $$
declare t text;
begin
  foreach t in array array[
    'categories','sources','questions','question_sources','answers','answer_aliases','rarity_models',
    'answer_stats','question_stats','players','daily_challenges','sessions','submissions','appeals','rate_limits'
  ] loop
    execute format('alter table %I enable row level security', t);
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('revoke all on table %I from anon', t);
    end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
      execute format('revoke all on table %I from authenticated', t);
    end if;
  end loop;
end $$;

-- Public, non-sensitive lookup data may be read by client roles.
drop policy if exists categories_read on categories;
create policy categories_read on categories for select using (true);
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then grant select on categories to anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then grant select on categories to authenticated; end if;
end $$;
