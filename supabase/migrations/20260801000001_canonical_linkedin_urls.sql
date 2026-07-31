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
-- NON-DESTRUCTIVE ON PURPOSE. Rows are rewritten only where the canonical form
-- is not already taken by a different person. Where both forms exist, this
-- leaves them alone: merging duplicate people means re-pointing campaign_people,
-- email_drafts, outreach_events and sent_emails, and choosing which row's data
-- survives. That is a judgement call for the data-quality audit to surface, not
-- something a migration should decide silently — especially one that applies
-- itself to production on merge.
--
-- Transaction-wrapped so a lock timeout rolls back rather than leaving the
-- table half-canonicalised, which would be neither the old nor the new
-- invariant.
begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

update people p
set linkedin_url =
  'https://www.linkedin.com' ||
  regexp_replace(
    regexp_replace(p.linkedin_url, '^https?://(www\.)?linkedin\.com', ''),
    '/+$', ''
  )
where p.linkedin_url ~* '^https?://(www\.)?linkedin\.com'
  and p.linkedin_url <> (
    'https://www.linkedin.com' ||
    regexp_replace(
      regexp_replace(p.linkedin_url, '^https?://(www\.)?linkedin\.com', ''),
      '/+$', ''
    )
  )
  -- Skip anything whose canonical form another person already occupies.
  and not exists (
    select 1 from people other
    where other.id <> p.id
      and other.linkedin_url =
        'https://www.linkedin.com' ||
        regexp_replace(
          regexp_replace(p.linkedin_url, '^https?://(www\.)?linkedin\.com', ''),
          '/+$', ''
        )
  );

commit;
