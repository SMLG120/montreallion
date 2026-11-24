-- Accounts on Neon Auth: profiles live in the game database next to account_players.
-- Neon Auth (managed Better Auth) keeps users, emails and sessions in its own `neon_auth` schema; the app stores only
-- the opaque user id here. Emails are never copied into game tables.

-- Better Auth ids are opaque strings (not guaranteed UUIDs).
alter table account_players alter column user_id type text using user_id::text;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'account_players_user_id_len') then
    alter table account_players add constraint account_players_user_id_len check (char_length(user_id) between 1 and 128);
  end if;
end $$;

create table if not exists account_profiles (
  user_id text primary key check (char_length(user_id) between 1 and 128),
  display_name text check (display_name is null or char_length(display_name) between 2 and 20),
  appearance jsonb not null default '{}'::jsonb
    check (jsonb_typeof(appearance) = 'object' and pg_column_size(appearance) < 2048),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Ownership is enforced by Postgres, not only by app code: profile reads and writes run inside a transaction that
-- switches to this restricted role and sets `montreallion.user_id` to the verified session's user id. The role
-- can't log in, can't bypass RLS, can't delete, and can only change the name and look of its own row.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'montreallion_account') then
    create role montreallion_account nologin noinherit nobypassrls;
  end if;
end $$;
grant montreallion_account to current_user;
grant usage on schema public to montreallion_account;
revoke all on account_profiles from montreallion_account;
grant select on account_profiles to montreallion_account;
grant insert (user_id, display_name, appearance) on account_profiles to montreallion_account;
grant update (display_name, appearance, updated_at) on account_profiles to montreallion_account;

alter table account_profiles enable row level security;
drop policy if exists account_profiles_owner on account_profiles;
create policy account_profiles_owner on account_profiles for all to montreallion_account
  using (user_id = current_setting('montreallion.user_id', true))
  with check (user_id = current_setting('montreallion.user_id', true));
