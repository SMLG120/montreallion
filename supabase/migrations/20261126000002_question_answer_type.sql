-- Phase I: marks questions whose answers are people, so the matcher accepts a unique surname ("Lafleur").
-- Additive and idempotent; NULL means "not people". Written by `db:seed` from the bank files.
alter table questions add column if not exists answer_type text;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'questions_answer_type_check') then
    alter table questions add constraint questions_answer_type_check check (answer_type is null or answer_type in ('person'));
  end if;
end $$;
