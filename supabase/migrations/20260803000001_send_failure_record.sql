-- Record why a send did not happen
-- 2026-08-03
--
-- claimAndSendDraft refuses to send at seven distinct points: an unloadable
-- contact, a just-in-time verification that came back blocked, a canSendTo
-- gate, an address that drifted from the contact's verified one, the
-- warmup-ramped daily cap, and an SMTP error. Every one of them returns a
-- complete, already user-readable sentence, and every one of those sentences
-- is currently thrown away -- the only consumer anywhere in the codebase is a
-- console.error in the followups executor. From the user's side an approved
-- draft simply sits there, forever, with no explanation.
--
-- These columns live on email_drafts rather than sent_emails because a refused
-- send produces no sent_emails row by definition, and because the draft is the
-- thing that is still retryable, so the error belongs on the object the user
-- would act on.
alter table email_drafts
  add column if not exists last_error text,
  add column if not exists last_error_at timestamptz,
  -- Three outcomes that read alike as strings and must not look alike in the
  -- UI:
  --
  --   deferred  Nothing is wrong. The daily cap or warmup ramp was reached and
  --             the draft is queued for tomorrow. This is the MOST COMMON
  --             non-send, so filing it under "Failed" would make the failed
  --             list mostly noise within a week of any new mailbox connecting,
  --             and users would stop reading it.
  --   blocked   A data-quality gate refused: unverified address, unconfirmed
  --             employer, address drift. The user can fix it, and the stored
  --             sentence already says how.
  --   failed    SMTP or the database actually errored. Retry is the answer.
  --
  -- claimAndSendDraft knows which kind it is at each return site, so this is
  -- classified at the write. Never string-match the reason at read time.
  add column if not exists last_error_kind text
    check (last_error_kind is null
           or last_error_kind in ('deferred', 'blocked', 'failed')),
  add column if not exists send_attempts integer not null default 0;

-- Partial: the activity feed only ever asks for drafts currently carrying an
-- error, which is a handful of rows out of the whole table.
create index if not exists idx_email_drafts_last_error
  on email_drafts (user_id, last_error_at desc)
  where last_error_at is not null;
