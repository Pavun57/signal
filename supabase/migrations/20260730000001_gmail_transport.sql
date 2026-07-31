-- Gmail (app-password SMTP/IMAP) becomes the sole email transport and
-- AgentMail is removed entirely, columns included. agentmail_message_id is
-- renamed to the provider-neutral message_id (now the RFC 5322 Message-ID of
-- the sent mail — replies reference it via In-Reply-To/References, which is
-- how IMAP tracking matches them). Old rows keep their ids in that column;
-- nothing reads them anymore.
--
-- gmail_app_password_enc holds an AES-256-GCM ciphertext (see src/lib/crypto.ts),
-- never a plaintext credential. Readable only by its owner under the existing
-- owner-only RLS on user_settings, and by the service role.

alter table user_settings
  drop column if exists agentmail_inbox_id,
  add column if not exists gmail_address text,
  add column if not exists gmail_app_password_enc text,
  add column if not exists gmail_connected_at timestamptz,
  add column if not exists daily_send_limit integer not null default 30
    check (daily_send_limit between 1 and 500);

alter table sent_emails rename column agentmail_message_id to message_id;
alter table sent_emails alter column message_id drop not null;
drop index if exists idx_sent_emails_thread;
alter table sent_emails drop column if exists agentmail_thread_id;

-- Daily-cap check counts a user's sends since midnight UTC.
create index if not exists idx_sent_emails_user_sent_at
  on sent_emails(user_id, sent_at);
