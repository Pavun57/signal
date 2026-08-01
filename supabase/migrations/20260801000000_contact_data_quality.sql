-- Contact data quality: email verification + affiliation provenance
-- 2026-08-01
--
-- Two data-quality failures share one root cause: we record a conclusion
-- without recording why we believe it.
--
-- Emails. findEmailForPerson ends in a blind {first}.{last}@domain guess written
-- at confidence 0.2, and the only network check in the whole path is an MX
-- lookup — which proves the *domain* accepts mail and says nothing about whether
-- the mailbox exists. pickAndDraft then checks only that work_email is non-empty,
-- so a guess is sent exactly like a user-typed address. work_email_verification
-- separates "how we found it" (work_email_source) from "does it actually
-- deliver", so a pattern guess that verifies becomes trustworthy and one that
-- fails can be refused at the send gate.
--
-- Affiliation. people.organization_id is a bare nullable FK with no source, no
-- confidence and no timestamp, while work_email already carries all three. A
-- wrong company link is therefore invisible and permanent. The affiliation_*
-- quartet mirrors the work_email_* trio deliberately: same monotonic
-- never-downgrade write rule, same weight-per-source model, so the two read as
-- one system rather than two conventions.
--
-- Deliberately NOT done here:
--
--   * No backfill. Stamping every existing row with a made-up provenance would
--     be a table-wide UPDATE — and since 20260730 this repo pushes migrations to
--     production automatically on merge (.github/workflows/migrate.yaml), that
--     is a write lock on the live people table. NULL is given an explicit
--     meaning instead: "legacy, never assessed", which the send gate treats as
--     below threshold.
--
--   * No enum types. The codebase consistently uses `check (col is null or col
--     in (...))` on a text column (see 20260730000003_email_test_status.sql);
--     enums cannot be extended inside a transaction on older PG and make future
--     source additions a migration each.
--
--   * No new tables, so no RLS or updated_at trigger work.
--
-- Transaction-wrapped for the same reasons as 20260729000000 and 20260730000000:
-- the work_email_source constraint has to be dropped and recreated to admit
-- 'provider_found', and a failure between those two statements would leave the
-- column unconstrained. SET LOCAL also only applies inside a transaction block
-- (outside one it warns 25P01 and silently does nothing).
begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- ────────────────────────────────────────────────────────────────────────────
-- 1. Email verification — orthogonal to discovery source
-- ────────────────────────────────────────────────────────────────────────────
-- 'unchecked' is the explicit "we never asked" state, distinct from 'unknown',
-- which means the verifier was asked and could not decide. That distinction
-- matters at the send gate: unchecked is retryable, unknown already cost money.
alter table people
  add column if not exists work_email_verification text
    check (
      work_email_verification is null
      or work_email_verification in
        ('deliverable', 'risky', 'undeliverable', 'unknown', 'unchecked')
    );

-- Which provider produced the verdict, so a later provider swap can invalidate
-- only its own results rather than the whole column.
alter table people
  add column if not exists work_email_verified_by text;

-- ────────────────────────────────────────────────────────────────────────────
-- 2. Admit provider-sourced emails to work_email_source
-- ────────────────────────────────────────────────────────────────────────────
-- Drop-and-recreate is the only way to widen a CHECK. Named explicitly rather
-- than relying on the generated name so this reads the same as the original in
-- 20260426000000_email_pattern.sql.
alter table people
  drop constraint if exists people_work_email_source_check;

alter table people
  add constraint people_work_email_source_check
    check (
      work_email_source is null
      or work_email_source in
        ('user_entered', 'send_confirmed', 'team_page', 'exa_search',
         'pattern_derived', 'provider_found')
    );

-- ────────────────────────────────────────────────────────────────────────────
-- 3. Affiliation provenance — mirrors the work_email_* trio
-- ────────────────────────────────────────────────────────────────────────────
-- Ordered by strength in the application's AFFILIATION_WEIGHT map:
--   user_entered 1.0 · email_domain 0.95 · team_page 0.9
--   linkedin_profile 0.8 · llm_verified 0.6 · search_stamp 0.2
--
-- email_domain is the strongest machine signal because a deliverable mailbox at
-- the company's own domain proves employment and address validity at once —
-- which is why email verification and affiliation ship together. It is only
-- granted when the domain is NOT catch-all (see section 4).
alter table people
  add column if not exists affiliation_source text
    check (
      affiliation_source is null
      or affiliation_source in
        ('user_entered', 'email_domain', 'team_page', 'linkedin_profile',
         'llm_verified', 'search_stamp')
    );

alter table people
  add column if not exists affiliation_confidence real;

alter table people
  add column if not exists affiliation_verified_at timestamptz;

-- One human-readable line backing the claim, rendered as the UI badge tooltip.
-- e.g. "LinkedIn headline reads 'Wafer', not 'Browserbase'".
alter table people
  add column if not exists affiliation_evidence text;

-- The send gate and the per-company contact views both filter people at one org
-- by confidence, so lead with organization_id.
create index if not exists idx_people_affiliation_conf
  on people (organization_id, affiliation_confidence);

-- ────────────────────────────────────────────────────────────────────────────
-- 4. Catch-all domains
-- ────────────────────────────────────────────────────────────────────────────
-- A catch-all domain accepts mail to every local part, so a verifier returning
-- "deliverable" there proves nothing at all. Cached per-organization because the
-- answer is a property of the domain's MX config, not of any one address, and
-- re-probing it per contact would bill once per person at the same company.
alter table organizations
  add column if not exists is_catch_all boolean;

alter table organizations
  add column if not exists catch_all_checked_at timestamptz;

commit;
