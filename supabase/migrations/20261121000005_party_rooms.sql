-- Phase 7: Party rooms. Ephemeral, so the whole room state lives in one jsonb row,
-- mutated under a row lock by src/lib/game/party.ts (pure state machine).
create table if not exists party_rooms (
  code text primary key check (code ~ '^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{5}$'),
  state jsonb not null,
  status text not null check (status in ('lobby', 'playing', 'finished')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists party_rooms_updated_idx on party_rooms (updated_at);

alter table party_rooms enable row level security;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on table party_rooms from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then revoke all on table party_rooms from authenticated; end if;
end $$;
