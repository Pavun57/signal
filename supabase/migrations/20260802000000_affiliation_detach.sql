-- Affiliation detach: admit the detaching sources, and record what was detached from
-- 2026-08-02
--
-- 20260801000000 added affiliation_source with a CHECK listing six values, all
-- of them reasons to believe someone DOES work somewhere. The work that
-- followed added the opposite kind of evidence: two sources whose whole purpose
-- is to break a link. Neither was added to the constraint, so every detaching
-- write raised 23514, and because recordAffiliation never destructured the
-- update error the failure was swallowed and the caller counted the row as
-- departed anyway. The feature had never once worked against a real database.
-- Every test passed because each Supabase fake in the suite is a hand-rolled
-- object that enforces no constraints.
--
-- The two detaching sources are separate on purpose, because they are two
-- different findings and the evidence string a human reads in the review queue
-- has to say which one it was:
--
--   former_employee    Their profile shows a dated stint at THIS company that
--                      has already ended. The affiliation was true and is now
--                      stale.
--   employer_mismatch  Their profile names a DIFFERENT employer and never
--                      mentions this one. The affiliation was probably never
--                      true, most often a search stamp landing on a namesake.
--
-- Both sit at weight 0.8 in AFFILIATION_WEIGHT (src/lib/services/affiliation.ts),
-- level with linkedin_profile, because all three are the same evidence read the
-- same way: strong enough to displace a search stamp (0.2) or an LLM guess
-- (0.6), never strong enough to overrule the company's own team page (0.9) or a
-- human (1.0).
--
-- Note that a detaching write stores affiliation_confidence = 0, not 0.8. The
-- two numbers answer different questions. The weight above is displacement
-- strength, read only by the monotonic guard; the stored confidence is "how
-- sure are we that they work at organization_id", and once organization_id is
-- null there is no claim left for the number to be about. Storing 0.8 there
-- would clear AFFILIATION_SEND_THRESHOLD (0.6) and make detaching someone the
-- act that makes them sendable.
--
-- user_rejected (weight 1.0) is the same shape applied to a human clicking
-- "not here" in the review queue. That endpoint currently nulls the org AND all
-- four provenance columns, which scores the row below a bare search stamp, so
-- the next stamp re-attaches the person and the queue never terminates. The
-- value ships here rather than in its own migration so this constraint is
-- dropped and recreated once instead of twice.
--
-- Deliberately NOT done here:
--
--   * No backfill, for the same reason as 20260801000000: a table-wide UPDATE
--     on people takes a write lock, and .github/workflows/migrate.yaml pushes
--     migrations on merge.
--
--   * No NOT NULL and no default on affiliation_detached_from. Null means "no
--     detach on record", which is every row today.
--
-- Transaction-wrapped for the same reason as 20260801000000: widening a CHECK
-- means dropping it before adding the replacement, and a failure between those
-- two statements would leave affiliation_source unconstrained. SET LOCAL also
-- only does anything inside a transaction block.
begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- ────────────────────────────────────────────────────────────────────────────
-- 1. Widen affiliation_source to admit the three detaching sources
-- ────────────────────────────────────────────────────────────────────────────
-- The original was written as an inline `check (...)` on `add column`, so it
-- has no explicit name and Postgres generated one. Confirmed against the local
-- instance rather than assumed:
--
--   select conname, pg_get_constraintdef(oid) from pg_constraint
--    where conrelid = 'public.people'::regclass and contype = 'c';
--   => people_affiliation_source_check
--
-- `if exists` so a database that never carried the generated name still applies
-- this cleanly, and so re-running the file is a no-op.
alter table people
  drop constraint if exists people_affiliation_source_check;

-- csv_import is in this list for a reason that is not visible from this branch:
-- 20260801000004 on the target-accounts work adds it, and that migration sorts
-- BEFORE this one. Recreating the constraint without it would silently re-open
-- exactly the bug this file closes, one feature over. A permitted value that
-- nothing writes yet costs nothing.
alter table people
  add constraint people_affiliation_source_check
    check (
      affiliation_source is null
      or affiliation_source in
        ('user_entered', 'email_domain', 'team_page', 'linkedin_profile',
         'llm_verified', 'search_stamp', 'csv_import',
         'former_employee', 'employer_mismatch', 'user_rejected')
    );

-- ────────────────────────────────────────────────────────────────────────────
-- 2. Which company the detach was about
-- ────────────────────────────────────────────────────────────────────────────
-- A verdict is about one company, but a detaching write says only
-- `organization_id = null`, which means "detach from wherever you are". Judging
-- someone at Browserbase and finding they work at Box would therefore detach
-- them from Box, the employer the judge just confirmed. Recording the org the
-- verdict was about lets the write refuse unless the person is actually sitting
-- at that org, and lets a later positive signal re-attach them somewhere else
-- without having to outrank a detach that was never about that company.
--
-- `on delete set null` matches people.organization_id in the initial schema:
-- deleting a company should not delete the person, and the memory of a detach
-- from a company that no longer exists is not worth blocking the delete over.
alter table people
  add column if not exists affiliation_detached_from uuid
    references organizations(id) on delete set null;

commit;
