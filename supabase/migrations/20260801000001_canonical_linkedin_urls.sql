-- Canonicalise stored LinkedIn URLs to the www host
-- 2026-08-01
--
-- normalizeLinkedInUrl kept whatever host it was handed, so the same profile
-- could be stored as either `linkedin.com/in/x` or `www.linkedin.com/in/x`.
-- Two consequences, both live:
--
--   1. Dedup. The two forms are different strings, so they slip past the unique
--      index on people.linkedin_url — one human, two rows, and nothing stops
--      those rows carrying different employers.
--
--   2. Fetching. linkedin.com 301s to www.linkedin.com and the scrapers do not
--      follow it; the apex form comes back with an empty body. Measured against
--      the dev database on 2026-07-31, 100% of stored URLs were apex form, so
--      affiliation checks reading a stored URL would have failed every time.
--
-- Three things this has to get right, each of which a naive version gets wrong:
--
--   * Case. The predicate has to be case-insensitive (hosts are), and so does
--      the rewrite. A case-insensitive WHERE with a case-sensitive
--      regexp_replace matches `https://WWW.LinkedIn.com/in/x`, fails to strip
--      the prefix, and writes `https://www.linkedin.comhttps://WWW.LinkedIn...`
--      — silent string corruption. Hence the explicit 'i' flag on the strip.
--
--   * Regional subdomains. `uk.linkedin.com/in/x` has to be matched too, or it
--      is left alone while the TypeScript normaliser rewrites it to the www
--      form — so every later lookup misses and creates a duplicate person, the
--      exact bug this is meant to close.
--
--   * Collisions between rows being rewritten. Checking only whether the
--      canonical form is *already* occupied is not enough: two rows that both
--      normalise to the same target (say `http://linkedin.com/in/x` and
--      `https://linkedin.com/in/x`) each see an unoccupied target, both update,
--      and the unique index raises 23505 — which, since this file applies
--      itself to production on merge, aborts the deploy rather than logging a
--      warning. The count(*) = 1 clause below requires a target to be claimed
--      by exactly one row.
--
-- NON-DESTRUCTIVE ON PURPOSE. Any row whose canonical form is contested is left
-- exactly as it is, for the data-quality audit to surface. Merging duplicate
-- people means re-pointing campaign_people, email_drafts, outreach_events and
-- sent_emails and choosing which row's data survives — a judgement call, not
-- something a migration should decide silently.
--
-- Transaction-wrapped so a lock timeout rolls back rather than leaving the
-- table half-canonicalised, which would be neither the old nor the new
-- invariant.
begin;

set local lock_timeout = '5s';
-- Measured: 7.5s to rewrite 500,000 rows on local Postgres. This table is far
-- smaller than that today, but production storage is network-attached, so give
-- the one-time backfill real headroom rather than have it abort at 60s and wedge
-- the auto-migrate workflow — a migration that always fails re-fails on every
-- subsequent merge and blocks all later schema changes.
set local statement_timeout = '300s';

with canon as (
  select
    id,
    linkedin_url,
    'https://www.linkedin.com' ||
      regexp_replace(
        regexp_replace(
          linkedin_url,
          '^https?://([a-z0-9-]+\.)?linkedin\.com',
          '',
          'i'
        ),
        '/+$',
        ''
      ) as target
  from people
  where linkedin_url ~* '^https?://([a-z0-9-]+\.)?linkedin\.com'
),
counted as (
  -- Window function rather than a correlated subquery: the obvious
  -- `(select count(*) from canon c2 where c2.target = c.target)` re-scans the
  -- CTE once per row and did not finish in ten minutes on 500k rows. This form
  -- does one pass.
  select id, linkedin_url, target, count(*) over (partition by target) as claimants
  from canon
),
safe as (
  select c.id, c.target
  from counted c
  where c.linkedin_url <> c.target
    -- exactly one row wants this target …
    and c.claimants = 1
    -- … and nobody is sitting on it already
    and not exists (
      select 1
      from people other
      where other.linkedin_url = c.target
        and other.id <> c.id
    )
)
update people p
set linkedin_url = s.target
from safe s
where p.id = s.id;

commit;
