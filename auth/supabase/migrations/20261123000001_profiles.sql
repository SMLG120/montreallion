-- Montréallion accounts (Supabase Auth project). Game data stays on Neon; this project holds only
-- auth.users (managed by Supabase) and one profile row per user. Emails never leave auth.users.

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text check (display_name is null or char_length(display_name) between 2 and 20),
  appearance jsonb not null default '{}'::jsonb
    check (jsonb_typeof(appearance) = 'object' and pg_column_size(appearance) < 2048),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

-- Owners only: read and update their own row. No insert (trigger below) and no delete (cascades from auth.users).
drop policy if exists "profiles: owner can read" on public.profiles;
create policy "profiles: owner can read" on public.profiles
  for select to authenticated using ((select auth.uid()) = id);

drop policy if exists "profiles: owner can update" on public.profiles;
create policy "profiles: owner can update" on public.profiles
  for update to authenticated using ((select auth.uid()) = id) with check ((select auth.uid()) = id);

-- Column privileges: anon gets nothing; signed-in users may change only their name and look.
revoke all on public.profiles from anon, authenticated;
grant select (id, display_name, appearance, created_at, updated_at) on public.profiles to authenticated;
grant update (display_name, appearance) on public.profiles to authenticated;

create or replace function public.touch_profile() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists profiles_touch on public.profiles;
create trigger profiles_touch before update on public.profiles
  for each row execute function public.touch_profile();

-- Every new auth user gets an (empty) profile.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id) values (new.id) on conflict (id) do nothing;
  return new;
end $$;

revoke execute on function public.handle_new_user() from public, anon, authenticated;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();
