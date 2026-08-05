-- Send-window scope: whose clock the window reads. 'sender' keeps today's
-- behavior; 'recipient' resolves each contact's timezone from enrichment /
-- org location (best effort, falling back to the sender's zone when
-- unresolvable). No new queue needed: deferred drafts already retry via the
-- 15-minute followups job until the window opens.

alter table user_settings
  add column if not exists send_window_scope text not null default 'sender'
    check (send_window_scope in ('sender', 'recipient'));

-- user_settings SELECT is column-enumerated for authenticated (tenant policy
-- hardening); new columns are invisible to the settings UI until granted.
grant select (send_window_scope) on user_settings to authenticated;
