-- Phase F: link guest players (one per device) to an account (Supabase Auth user id).
-- Only the opaque user id is stored on Neon; emails live solely in the auth project.
-- (players.auth_user_id from the core schema is unique, i.e. one device per account, so it stays unused.)
create table if not exists account_players (
  player_id uuid primary key references players (id) on delete cascade,
  user_id uuid not null,
  linked_at timestamptz not null default now()
);
create index if not exists account_players_user_idx on account_players (user_id, linked_at);
