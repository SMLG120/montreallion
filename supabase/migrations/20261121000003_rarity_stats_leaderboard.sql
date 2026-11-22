-- Phase 5: observed rarity, distinct-player stats, daily leaderboard.
insert into rarity_models (id, kind, description) values
  ('observed-v1', 'statistical',
   'Per question: estimated-v1 until 30 distinct correct-answer players; then share = (players + 20 * estimated share) / (n + 20), score = 100 - 90 * share / max share')
on conflict (id) do nothing;

-- One row per (answer, player): rarity counts people, not replays.
create table if not exists answer_players (
  answer_id bigint not null references answers (id) on delete cascade,
  player_id uuid not null references players (id) on delete cascade,
  first_at timestamptz not null default now(),
  primary key (answer_id, player_id)
);
alter table answer_stats add column if not exists players integer not null default 0;

insert into answer_players (answer_id, player_id, first_at)
select sub.answer_id, s.player_id, min(sub.created_at)
from submissions sub join sessions s on s.id = sub.session_id
where sub.answer_id is not null
group by 1, 2
on conflict do nothing;
update answer_stats st set players = x.c
from (select answer_id, count(*)::int as c from answer_players group by 1) x
where x.answer_id = st.answer_id;

-- What the player was shown: estimated vs observed, and the sample size.
alter table submissions add column if not exists rarity_basis text check (rarity_basis in ('estimated', 'observed'));
alter table submissions add column if not exists rarity_sample integer check (rarity_sample >= 0);
update submissions set rarity_basis = 'estimated' where status = 'correct' and rarity_basis is null;

-- Leaderboard tiebreak: total answer time.
alter table sessions add column if not exists total_elapsed_ms integer not null default 0;
update sessions s set total_elapsed_ms = x.t
from (select session_id, sum(elapsed_ms)::int as t from submissions group by 1) x
where x.session_id = s.id;
create index if not exists sessions_daily_board_idx on sessions (date_key, total_score desc, total_elapsed_ms)
  where mode = 'daily' and finished_at is not null;
create index if not exists submissions_question_idx on submissions (question_id);

alter table answer_players enable row level security;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on table answer_players from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then revoke all on table answer_players from authenticated; end if;
end $$;
