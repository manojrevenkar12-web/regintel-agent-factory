-- The platform's record. Every crawl, every incident and repair, every deployed scraper version and
-- every regulatory document version it believes in, per season setup. Assessments and their sign-offs
-- are append-only and chained by hash, so a changed record is detectable.

create extension if not exists vector;

create table if not exists crawls (
  setup      text not null,
  source     text not null,
  day        int not null,
  status     text not null check (status in ('ok', 'maintenance', 'failed', 'skipped')),
  scraper    int not null,                 -- deployment version used
  findings   jsonb not null default '[]',
  listed     int not null default 0,
  requests   int not null default 0,
  fingerprint text,
  primary key (setup, source, day, scraper)
);

create table if not exists last_good (
  setup  text not null,
  source text not null,
  day    int not null,
  data   jsonb not null,                    -- the crawl data production uses
  primary key (setup, source)
);

create table if not exists doc_versions (
  setup     text not null,
  source    text not null,
  ref       text not null,
  version   int not null,
  title     text not null,
  published text not null,
  effective text not null,
  clauses   jsonb not null,
  first_seen int not null,                  -- day the platform first saw this version
  primary key (setup, ref, version)
);

create table if not exists incidents (
  id         text primary key,              -- setup:source:day
  setup      text not null,
  source     text not null,
  day        int not null,
  findings   jsonb not null,
  status     text not null check (status in ('open', 'repairing', 'deployed', 'escalated', 'fixed_by_person')),
  decision   text,
  reason     text,
  cost_usd   numeric(10,4) not null default 0,
  seconds    int not null default 0,
  record     jsonb,                         -- the repair record: attempts, gates, review
  resolved_day int
);

create table if not exists deployments (
  setup    text not null,
  source   text not null,
  version  int not null,
  day      int not null,
  by       text not null,                   -- agent:<setup>, person, or initial
  incident text,
  code     text not null,
  code_hash text not null,
  primary key (setup, source, version)
);

-- Change impact: assessments proposed by the platform (one per document version and matcher), and
-- the expert sign-offs on them. A sign-off is bound to the hash of the body it signed.
create table if not exists assessments (
  id        text primary key,               -- setup:method:ref:vN
  setup     text not null,
  method    text not null,
  ref       text not null,
  version   int not null,
  day       int not null,                   -- day the platform first saw the version
  body      jsonb not null,                 -- changes, affected items with citations, gaps, relinks
  body_hash text not null,
  created   timestamptz not null default now()
);

create table if not exists signoffs (
  seq        bigserial primary key,
  assessment text not null references assessments(id),
  body_hash  text not null,                 -- what was signed; must equal the assessment's hash
  signer     text not null,                 -- a person's id
  name       text not null,                 -- printed name
  role       text not null,
  meaning    text not null check (meaning in ('reviewed', 'approved', 'rejected')),
  decisions  jsonb not null,                -- per item: accepted or rejected, with a comment
  at         timestamptz not null default now()
);
drop trigger if exists signoffs_no_change on signoffs;

create table if not exists audit_log (
  seq       bigserial primary key,
  at        timestamptz not null default now(),
  actor     text not null,                  -- agent, system or a person's id
  action    text not null,                  -- e.g. assessment.proposed, assessment.signed, scraper.deployed
  subject   text not null,
  payload   jsonb not null,
  prev_hash text not null,
  hash      text not null unique
);

create or replace function audit_append_only() returns trigger language plpgsql as $$
begin
  raise exception 'audit_log is append-only';
end $$;
drop trigger if exists audit_no_change on audit_log;
create trigger audit_no_change before update or delete on audit_log for each row execute function audit_append_only();

create table if not exists requirement_vectors (
  id        text primary key,               -- requirement id
  device    text not null,
  text      text not null,
  embedding vector(256) not null
);

create or replace function signoffs_append_only() returns trigger language plpgsql as $$
begin
  raise exception 'signoffs are append-only';
end $$;
create trigger signoffs_no_change before update or delete on signoffs for each row execute function signoffs_append_only();
