-- Tenant policy hardening
-- 2026-08-04
--
-- Closes the cross-tenant holes that do not need an ownership column on the
-- shared pool. Each one was reproduced against a local database with two real
-- Clerk users before being written down.
--
-- Deliberately NOT in this file: scoping reads and writes on `people` and
-- `organizations`. Those tables carry global unique indexes
-- (idx_people_linkedin, idx_people_github_url, idx_organizations_domain) and
-- `findOrCreatePerson` dedupes through the caller's own client, so a per-tenant
-- SELECT policy makes the second tenant to discover a person fail on a unique
-- violation they are not allowed to see. Fixing that properly means giving both
-- tables a user_id and making uniqueness per-user, which is a data migration
-- against live rows and belongs in its own change.

begin;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. signals: stop anyone minting a permanent, undeletable, cross-tenant row.
--
-- signals_insert was WITH CHECK (true) while update and delete both require
-- `is_builtin = false`. So any authenticated user could insert a row with
-- is_builtin = true and nothing could ever edit or remove it through the API.
-- It then appeared in every tenant's built-in gallery, and because
-- system-prompt.ts interpolates a signal's description and config.instructions
-- into the system prompt of an agent holding sendEmail, that row was a
-- cross-tenant prompt-injection surface.
--
-- created_by is also now required, which the update/delete policies have always
-- assumed: createSignal never set it, so every custom signal a user made was
-- immediately uneditable and undeletable by its own author.
-- ───────────────────────────────────────────────────────────────────────────
drop policy if exists "signals_insert" on signals;
create policy "signals_insert" on signals for insert to authenticated
  with check (
    is_builtin = false
    and created_by in (
      select id from user_profile where user_id = requesting_user_id()
    )
  );

-- A custom signal is one tenant's research. is_public is the opt-in that shares
-- it; before this it was a dead column, because select was USING (true).
drop policy if exists "signals_select" on signals;
create policy "signals_select" on signals for select to authenticated
  using (
    is_builtin
    or is_public
    or created_by in (
      select id from user_profile where user_id = requesting_user_id()
    )
  );

-- ───────────────────────────────────────────────────────────────────────────
-- 2. Inserts that only checked user_id could be aimed at another tenant's
-- campaign. Knowing a campaign uuid was enough to write rows that show up in
-- that tenant's activity feed and reply list, with attacker-authored text.
-- ───────────────────────────────────────────────────────────────────────────
drop policy if exists "sent_emails_insert" on sent_emails;
create policy "sent_emails_insert" on sent_emails for insert to authenticated
  with check (
    user_id = requesting_user_id()
    and (
      campaign_id is null
      or exists (
        select 1 from campaigns c
        where c.id = campaign_id and c.user_id = requesting_user_id()
      )
    )
  );

drop policy if exists "email_replies_insert" on email_replies;
create policy "email_replies_insert" on email_replies for insert to authenticated
  with check (
    user_id = requesting_user_id()
    and (
      campaign_id is null
      or exists (
        select 1 from campaigns c
        where c.id = campaign_id and c.user_id = requesting_user_id()
      )
    )
  );

-- api_usage drove the cost dashboard off WITH CHECK (true), so any user could
-- attribute arbitrary spend to anyone. The service role bypasses RLS, so the
-- server's own tracking is unaffected.
drop policy if exists "usage_insert" on api_usage;
create policy "usage_insert" on api_usage for insert to authenticated
  with check (user_id = requesting_user_id() or user_id is null);

-- ───────────────────────────────────────────────────────────────────────────
-- 3. Writes the app performs but no policy permitted, so they silently
-- affected zero rows and the caller reported success.
--
-- setCompanyWebsite merges two organizations: it repoints people,
-- signal_results and tracking_configs, re-counts what still references the old
-- row, and deletes it when nothing does. organizations had no DELETE policy and
-- signal_results no UPDATE policy, so the delete was a no-op that still
-- returned deletedOld: true and the signal_results move never happened.
--
-- Both are scoped to rows the caller can reach through their own campaigns, so
-- this grants no new cross-tenant reach.
-- ───────────────────────────────────────────────────────────────────────────
drop policy if exists "orgs_delete" on organizations;
create policy "orgs_delete" on organizations for delete to authenticated
  using (
    exists (
      select 1
      from campaign_organizations co
      join campaigns c on c.id = co.campaign_id
      where co.organization_id = organizations.id
        and c.user_id = requesting_user_id()
    )
  );

drop policy if exists "signal_results_update" on signal_results;
create policy "signal_results_update" on signal_results for update to authenticated
  using (
    exists (
      select 1 from campaigns c
      where c.id = signal_results.campaign_id
        and c.user_id = requesting_user_id()
    )
  );

-- ───────────────────────────────────────────────────────────────────────────
-- 4. Role scoping. These were created without a TO clause, so they apply to
-- `public` -- which includes anon. Identity still comes from the signed JWT, so
-- this was not a cross-user leak, but a Clerk token missing the
-- `role: authenticated` claim maps to anon and would still satisfy them, while
-- every campaigns/chats policy returned nothing. That split-brain state hides
-- the misconfiguration it should surface, and it is the anon role that reaches
-- the table holding the encrypted mailbox credential.
-- ───────────────────────────────────────────────────────────────────────────
do $$
declare
  p record;
begin
  for p in
    select tablename, policyname, cmd, qual, with_check
    from pg_policies
    where schemaname = 'public'
      and 'public' = any(roles)
      and tablename in (
        'user_settings', 'email_drafts', 'sent_emails', 'sequences',
        'sequence_steps', 'sequence_enrollments', 'email_replies'
      )
  loop
    execute format('alter policy %I on public.%I to authenticated', p.policyname, p.tablename);
  end loop;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 5. claim_jobs is the job runner's claim primitive. It was left executable by
-- anon and authenticated through PostgREST's default grants, and it is SECURITY
-- INVOKER, so today it returns nothing only because `jobs` has RLS on with no
-- policies. That is an accident away from being a cross-tenant job executor:
-- one well-meaning policy on `jobs` and any signed-in user could claim and read
-- every tenant's job payloads. Only the service role ever calls it.
--
-- search_path is pinned at the same time; an unpinned SECURITY INVOKER function
-- is a smaller problem than a definer one, but the fix is free.
-- ───────────────────────────────────────────────────────────────────────────
revoke execute on function public.claim_jobs(int, int, int) from public, anon, authenticated;

alter function public.claim_jobs(int, int, int) set search_path = '';

-- ───────────────────────────────────────────────────────────────────────────
-- 6. The Gmail app password ciphertext was selectable over PostgREST by its
-- owner. Only server code ever needs it -- the browser reads gmail_address and
-- nothing else -- so an XSS or a stolen session token could exfiltrate the
-- ciphertext and wait for the key. Column privileges are honoured by PostgREST,
-- and the service role is unaffected.
--
-- A column-level REVOKE against a table-level GRANT is a silent no-op --
-- `grant select on user_settings` already covers every column, and Postgres
-- will not subtract one. The table grant has to go and be replaced by an
-- explicit column list.
--
-- This fails safe: a column added later is unreadable by the browser until it
-- is added here, which surfaces as a visible PostgREST error rather than as a
-- quietly exposed secret.
-- ───────────────────────────────────────────────────────────────────────────
revoke select on user_settings from authenticated, anon;

grant select (
  id, user_id, from_name, reply_to_email, created_at, updated_at,
  gmail_address, gmail_connected_at, daily_send_limit, test_message_id,
  test_to_email, test_sent_at, test_replied_at, test_status, test_reply,
  sending_paused
) on user_settings to authenticated;

commit;
