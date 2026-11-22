-- Phase 6: admin review log, appeal resolutions, appeal-added aliases, name moderation.

-- Hash of a question's playable content (prompt, eligibility, answers). Reviews are pinned to it.
alter table questions add column if not exists content_hash text;

create table if not exists question_reviews (
  id bigint generated always as identity primary key,
  question_id text not null references questions (id) on delete cascade,
  status review_status not null check (status in ('approved', 'rejected', 'in_review')),
  reviewer text not null check (char_length(reviewer) between 1 and 40),
  note text check (char_length(note) <= 500),
  content_hash text not null,
  created_at timestamptz not null default now()
);
create index if not exists question_reviews_q_idx on question_reviews (question_id, created_at desc);

-- 'seed' aliases are rewritten by `db:seed`; 'appeal' aliases come from accepted appeals and survive reseeds.
alter table answer_aliases add column if not exists source text not null default 'seed' check (source in ('seed', 'appeal'));

alter table appeals add column if not exists resolution text check (resolution in ('alias', 'noted', 'rejected'));
alter table appeals add column if not exists resolved_by text check (char_length(resolved_by) <= 40);
alter table appeals add column if not exists admin_note text check (char_length(admin_note) <= 500);
alter table appeals add column if not exists alias_answer_id bigint references answers (id) on delete set null;
create index if not exists appeals_open_idx on appeals (created_at) where status = 'open';

alter table players add column if not exists name_updated_at timestamptz;
create index if not exists players_named_idx on players (name_updated_at desc) where display_name is not null;
create index if not exists sessions_player_recent_idx on sessions (player_id, created_at desc);

alter table question_reviews enable row level security;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on table question_reviews from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then revoke all on table question_reviews from authenticated; end if;
end $$;
