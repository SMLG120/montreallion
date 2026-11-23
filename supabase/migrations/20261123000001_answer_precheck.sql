-- Phase B: answer double-check. Latest pre-check for the session's current question
-- (normalized key, candidate slugs, server timestamp). Server-only: sessions keep RLS deny-all
-- and no anon/authenticated grants, so candidates are never readable through the public API.
alter table sessions add column if not exists precheck jsonb;
