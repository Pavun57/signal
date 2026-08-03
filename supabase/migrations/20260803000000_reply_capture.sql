-- Reply capture: store the content of inbound replies and bounces
-- 2026-08-03
--
-- Until now the reply pipeline threw away everything it learned. email-track
-- matched an inbound message to a send, wrote the single word "replied" onto
-- sent_emails.status and campaign_people.outreach_status, and dropped the
-- from-address, the subject, the date and the words the person actually typed
-- on the floor: classifyInboundMessage returns only {status, sentEmailId}, so
-- the message never survives the classifier boundary. Worse, reply bodies were
-- never fetched at all -- fetchInboundSince downloads a body only for
-- mailer-daemon mail, purely so a bounce report can be matched on a quoted
-- Message-ID. A user could see THAT someone replied and could not see WHAT
-- they said, anywhere in the product.
--
-- One row per inbound message rather than per send: a thread can carry several
-- replies, and each is its own artifact with its own timestamp and body.
--
-- IDEMPOTENCY. email.track re-polls every 600s over a 14-day window, so the
-- same inbound message is re-matched dozens of times. sent_emails.status is
-- protected by the monotonic STATUS_PRIORITY ladder in email-tracking.ts, but
-- that guard is about status and cannot protect a row insert -- and must not be
-- borrowed for one, because a SECOND reply in the same thread also fails the
-- ladder (replied -> replied) while genuinely needing to be stored. So this
-- table carries its own key: the inbound message's own RFC 5322 Message-ID,
-- which the IMAP envelope already supplies at no extra cost. Writers upsert on
-- (sent_email_id, dedupe_key) and ignore duplicates; they never consult the
-- status ladder.
create table if not exists email_replies (
  id uuid primary key default gen_random_uuid(),
  sent_email_id uuid not null references sent_emails(id) on delete cascade,

  -- Denormalised from sent_emails so the feed can filter and RLS can scope
  -- without a join on every read. Clerk ids are text (20260427000000).
  user_id text not null,
  -- NOT NULL on purpose. The select policy below is transitive through
  -- campaigns, so a null campaign_id would make a row invisible to its own
  -- owner. Every sent_emails row has one, so there is nothing to relax.
  campaign_id uuid not null references campaigns(id) on delete cascade,
  person_id uuid references people(id) on delete set null,

  kind text not null check (kind in ('reply', 'bounce')),
  from_email text not null,
  subject text not null default '',

  -- The inbound message's own Message-ID. Nullable because a minority of
  -- senders omit the header; dedupe_key always has a value regardless.
  message_id text,
  -- IMAP UID at capture time, so a later re-fetch does not have to re-scan the
  -- mailbox. NOT a key: UIDs are unique only within a mailbox's UIDVALIDITY
  -- generation, and a mailbox rebuild silently renumbers them.
  imap_uid bigint,

  -- Plain text only, quoted history and attribution already stripped. Never
  -- HTML: nothing in this app renders email HTML, and adding a sanitizer to do
  -- it would put a new dependency directly in the blast radius of text written
  -- by strangers.
  --
  -- NULL means "a reply arrived and we never captured its words". That is a
  -- real and permanent state -- every row that predates this migration is in
  -- it, and a body fetch that fails leaves a row in it too. It is NOT the same
  -- as an empty reply, and the UI has to say so rather than rendering blank.
  body_text text,
  -- Backstop only. fetchMessageText already slices the raw part at 20k chars,
  -- so this should never fire; without it a future caller that forgets to slice
  -- turns a pathological quoted thread into a multi-MB row on a 10-minute poll.
  constraint email_replies_body_bounded
    check (body_text is null or char_length(body_text) <= 32768),

  received_at timestamptz not null,
  created_at timestamptz not null default now(),

  -- coalesce(message_id, 'uid:'||imap_uid, from|epoch|subject).
  -- Built by replyDedupeKey() in src/lib/services/email-tracking.ts.
  dedupe_key text not null,
  unique (sent_email_id, dedupe_key)
);

-- The activity feed's only access pattern: one user's mail, newest first.
create index if not exists idx_email_replies_user_received
  on email_replies (user_id, received_at desc);
-- Fan-in from a sent_emails row to its replies, for detail expansion and for
-- the tracker's pre-loaded dedupe check.
create index if not exists idx_email_replies_sent_email
  on email_replies (sent_email_id);

-- Mirrors sent_emails (20260427000000:359-370) deliberately: transitive via
-- campaigns for select, direct owner for write. Identical shape means anyone
-- who can see a send can see its replies, and never the reverse.
alter table email_replies enable row level security;

create policy "email_replies_select" on email_replies
  for select using (
    exists (
      select 1 from campaigns c
      where c.id = email_replies.campaign_id
        and c.user_id = requesting_user_id()
    )
  );
create policy "email_replies_insert" on email_replies
  for insert with check (user_id = requesting_user_id());
create policy "email_replies_update" on email_replies
  for update using (user_id = requesting_user_id());
