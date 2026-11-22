-- Phase 4: provenance for ETL-generated questions.
alter table questions add column if not exists est_basis text not null default 'editor-estimate';
alter table questions add column if not exists generator jsonb; -- {template, concept, contentHash} for generated questions
alter table answers add column if not exists refs text[] not null default '{}'; -- e.g. wikidata:Q123, gtfs:STATION_M146
create index if not exists questions_review_queue_idx on questions (review_status) where review_status = 'in_review';
