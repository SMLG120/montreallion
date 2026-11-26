-- Phase H: editorial question difficulty (easy / medium / hard), independent of answer rarity.
-- Additive and idempotent: existing rows keep NULL until the next `db:seed` writes the value from the bank files.
alter table questions add column if not exists difficulty text;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'questions_difficulty_check') then
    alter table questions add constraint questions_difficulty_check check (difficulty is null or difficulty in ('easy', 'medium', 'hard'));
  end if;
end $$;
create index if not exists questions_category_difficulty_idx on questions (category_id, difficulty) where review_status = 'approved';
