-- The tenant-hardening migration (20260804000000) replaced the table-level
-- SELECT grant on user_settings with an explicit column list, but never
-- re-stated INSERT/UPDATE. Where Supabase's default privileges covered the
-- table, nothing changed; where they didn't (e.g. tables created by a role
-- without default privileges configured), every write from the browser fails
-- with "permission denied for table user_settings". Grant the writes
-- explicitly so the privilege no longer depends on environment defaults.
--
-- RLS still scopes these to the row owner — the policies are unchanged.
-- SELECT stays column-enumerated (gmail_app_password_enc remains unreadable
-- over PostgREST); writes go through Signal's own routes, which validate and
-- encrypt before touching the table.
--
-- anon intentionally gets nothing: unauthenticated traffic must never write
-- settings.

grant insert, update on public.user_settings to authenticated;
