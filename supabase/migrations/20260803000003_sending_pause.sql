-- Kill switch: pauses every outbound email for the user at the send
-- chokepoint (claimAndSendDraft). Drafting, reply tracking, and signal
-- monitoring keep running; nothing leaves the outbox while true.
alter table user_settings
    add column if not exists sending_paused boolean not null default false;
