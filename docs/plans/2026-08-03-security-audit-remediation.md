# Signal — Full Audit and Remediation Plan

**Audited:** 2026-08-02 / 03. **Tree audited:** branch `fix/campaign-contact-linkage` at `40d8fac`.
**Note:** a commit (`a2d9f9c feat(companies): a company with no website can be given one`) landed from another session _while this audit was running_. Its new route `src/app/api/companies/[id]/website/route.ts` was spot-checked (ownership gate is correct, no new raw `fetch`) but its three new services were **not** in scope. See "Re-validation" at the end.

---

## How to read this

Every finding is tagged with how strongly it is established:

- **CONFIRMED** — I reproduced it live, against the running app and the real database, usually with two real Clerk users. Not inference.
- **VERIFIED-IN-CODE** — I read the exact lines and the claim follows directly from them.
- **REPORTED** — surfaced by a review pass, consistent with the code, but not independently reproduced. Treat as "very likely" not "certain".

I did not change a single line of application code. Two throwaway probe scripts were written into the gitignored `test-results/`, run, and deleted; all probe users and rows were cleaned up (verified: 0 leftover rows, signals table back to its 11 built-ins).

---

## Your three questions, answered first

### 1. "Is the open-source repo safe? Is anyone concealing production credentials?"

**Yes, it is safe. No credential has ever entered this repository's history.**

This was the most rigorous part of the audit, and the result is clean. Scanned: all 220 commits across 16 local and ~45 remote branches, **1,151 unique reachable blobs** content-scanned individually, **plus 278 dangling/unreachable blobs** from `git fsck` (the classic "I committed it then removed it" hiding place). Patterns hunted included Anthropic/Clerk/Stripe/Supabase/AWS/GitHub/Slack/Browserbase/Hunter/Exa key shapes, JWTs, `whsec_`, Postgres URLs with inline passwords, Gmail app-password shapes, and bearer tokens.

Zero real secrets found. `.env.example` is entirely placeholders. `.gitignore` covered `.env*` and `.mcp.json` from the _initial_ commit, and `backup-*.sql` / `.clerk/` were added before any such file existed. The 13 MB production backup in your repo root, `.env.local`, `.clerk/`, and `.vercel/` are all confirmed ignored.

Two small things, neither a credential:

- Your production Supabase project ref `ucbgjgnvkznlejlemekj` is committed in `docs/plans/2026-08-02-sending-kill-switch.md:370`, pushed to `origin/main`. It is not a secret (it is already public in the deployed app's URL), but it points strangers at your personal instance and the sentence advertises that a worktree with stored prod credentials exists. Removing it from history needs a rewrite; accepting it and relying on RLS is also defensible — **but only after the RLS fixes below**.
- `e2e/helpers.ts:63` hardcodes `TEST_PASSWORD` in a public repo and creates real Clerk users with it. Safe today (test instance is enforced), worth randomising.

**However — "no leaked secrets" is not the same as "safe to run multi-tenant."** See question 3.

### 2. "Does production match the code? Is everything pointing at the right table?"

**Yes. The schema is in sync and the code points at the right tables.** This came back cleaner than expected.

- All 20 migrations are applied to production, in order, no gaps.
- A real shadow-database diff of production against the migration chain produced **no table, column, constraint, index, or policy drift**.
- Every table the code references exists; no code references a table that migrations don't create.
- The legacy `companies` / `contacts` tables were correctly renamed and then dropped inside the initial migration, and `email_skills` / `email_skill_attachments` were properly dropped by the voice-profiles migration. **Production has none of them** — no stale duplicates holding data. Production has exactly the 24 expected tables.

Only two pieces of undeclared drift, both created by hand in the dashboard and absent from git:

- A `public.whoami()` function (returns the caller's own auth claims — harmless, but undeclared).
- The `pg_net` extension is enabled in production and in no migration.

Neither is dangerous; both mean your git history is not a complete description of production. Fix by adding a migration that declares them (or dropping them).

### 3. "Any bugs or risks?"

Yes — and this is where the real work is. **The single most important finding: Signal is not currently safe to run as a multi-tenant service.** It is safe as a single-team self-hosted install, which is how the architecture doc describes it, but production already has 9 user profiles.

I proved the following live, with two freshly created users A and B:

| What I did as user B                                                                        | Result                      |
| ------------------------------------------------------------------------------------------- | --------------------------- |
| Read user A's discovered contacts, including `work_email`                                   | **Succeeded**               |
| Overwrite A's contact's `work_email` and `title`                                            | **Succeeded**               |
| Overwrite A's organisation's `email_pattern` and `is_catch_all`                             | **Succeeded**               |
| Insert a signal with `is_builtin = true`, visible to every tenant and undeletable by policy | **Succeeded**               |
| Read my own encrypted Gmail app-password ciphertext over the public API                     | **Succeeded**               |
| Read A's campaigns / chats / drafts / settings                                              | Correctly blocked           |
| IDOR A's draft, person, company via the API routes                                          | Correctly blocked (403/404) |
| Trigger a send on A's draft                                                                 | Correctly blocked           |

The second row is the dangerous one: **one tenant can silently redirect another tenant's outreach to an address of their choosing.** The send path re-reads `people.work_email` at send time, so the victim's own mailbox sends to the attacker's address.

The good news is that the API layer is genuinely well built — nearly every route's ownership check is correct, and the recent hardening commits did their job. The gap is underneath it: the database's shared-pool policies mean the API checks can be bypassed entirely by talking to PostgREST directly with the publishable key, which every signed-in browser already holds.

---

## Findings

### P0 — Fix before anyone else uses this instance

**P0-1. `people` and `organizations` are world-readable and world-writable to any authenticated user — CONFIRMED**
`supabase/migrations/20260419000000_initial_schema.sql:806-812`. Verified against the live database:

```
people_select  | {authenticated} | SELECT | USING (true)
people_update  | {authenticated} | UPDATE | USING (true)
orgs_select    | {authenticated} | SELECT | USING (true)
orgs_update    | {authenticated} | UPDATE | USING (true)
```

Any signed-in user can read every tenant's contacts (`work_email`, `personal_email`, `linkedin_url`, full `enrichment_data` dossiers) and overwrite them. Because `claimAndSendDraft` re-reads `people.work_email` at send time (`src/lib/services/outreach-sender.ts:136-240`), overwriting it makes the victim mail the attacker. Overwriting `organizations.email_pattern` redirects all of the victim's _future_ email guesses.

Every API-layer ownership check in the codebase is built on top of these tables. They are a front door beside an open window.

**P0-2. Full read-SSRF: the server fetches any URL a user supplies and returns the body — REPORTED, code-verified**
`src/lib/services/web-extraction-service.ts:61` — a bare `fetch(url)` with no scheme check, no IP validation, and default redirect-following. Reachable from at least six places, notably: `import-csv` stores `company.url` verbatim with no validation → `enrich-company/route.ts:245` fetches it → 3,000 characters of the response come back in the API response and are persisted.

For a product explicitly designed to be self-hosted on the operator's own infrastructure, `http://169.254.169.254/...`, `http://127.0.0.1:54321`, and `http://10.0.0.5/admin` are all in reach. `hiring-scraper.ts:231-251` and `fetchSitemap` make it worse by following links scraped _out of the remote page_.

**P0-3. The agent can send email with no human gate, and its context contains attacker-controlled text — REPORTED, code-verified**
`src/lib/email-composition/save.ts:86` sets `review_status: input.sequenceId ? "pending" : "approved"` — an ad-hoc `writeEmail` draft is **born approved**, so `sendEmail`'s gate (`email-tools.ts:911-922`) passes it. The only thing between the model and a prospect's inbox is a sentence in the system prompt.

Meanwhile `src/lib/system-prompt.ts` contains **no prompt-injection guardrail at all**, and `extractWebContent` returns 3,000 raw characters of any scraped page straight into the agent's context. The system prompt explicitly instructs the agent to scrape About/Team pages. A hostile team page can therefore instruct the agent to write and send an email from the user's real Gmail.

Related and equally fixable: `src/lib/email-composition/skill.ts:188-198` is the **only** LLM call site in the repo that does not wrap untrusted input — it interpolates 8,000 characters of `enrichment_data` raw, and its output _is_ the email body that gets sent. Every sibling call site (`contact-selector`, `intent-evaluator`, `swipe-prompts`, `relevance-filter`, …) uses `wrapUntrusted`. This one just never imported it.

**P0-4. `?q=` in a chat URL is auto-sent to the agent with no confirmation — CONFIRMED in code**
`src/app/chat/[id]/page.tsx:185` reads `searchParams.get("q")` and `:120-122` sends it on mount. This is a GET navigation, so the Clerk `SameSite=Lax` cookie rides along. A link like `https://<app>/chat/<uuid>?q=<instruction>` clicked by a signed-in user executes that instruction with their session, against an agent that can spend money and send mail.

**P0-5. Docker build context contains the 13 MB production database dump — VERIFIED-IN-CODE**
`.gitignore:52` correctly excludes `backup-*.sql` ("these carry real contact data and email bodies"). `.dockerignore` does **not**, and the Dockerfile does `COPY . .` into the builder stage. Anyone who obtains a builder layer or shared CI cache gets real people's contact data and email bodies. `.clerk/` is also missing from `.dockerignore`, and `.clerk/.tmp/keyless.json` on your disk contains a live `sk_test_…` and an app-claim token.

---

### P1 — Correctness bugs that silently produce wrong outcomes

**P1-1. Fresh installs end up with zero built-in signals — CONFIRMED**
This is the root cause of the footgun you already knew about, and it is worse than "the table won't self-heal."

`signals.created_by` references `user_profile(id)`. The Clerk migration (`20260427000000:42-52`) runs `TRUNCATE ... user_profile ... CASCADE`, and TRUNCATE CASCADE pulls in every table with an FK into the truncated set. I watched it happen in the shadow database: `NOTICE: truncate cascades to table "signals"`.

So on **every fresh install**, migration 1 seeds the 11 built-in signals and migration 4 deletes them. A new self-hoster runs the documented setup and lands on a Signals page reading "No signals in this category," with the product's core concept simply absent and no error. The migration's own header claims "signals... are untouched," which is false.

Your production and local databases have 11 signals only because they were restored by hand.

**P1-2. The daily send cap fails open — REPORTED, code-verified**
`src/lib/services/outreach-sender.ts:270-276` discards the query `error`. On any failure the count is `null`, `0 >= limit` is false, and **the send proceeds with the cap disabled**. The surrounding code is otherwise scrupulously fail-closed and even says so in a comment ("Not sending is always recoverable; sending is not"). A transient error during a 40-draft bulk send lets a warmup-ramp mailbox send all 40 at once.

**P1-3. Custom signals can never be edited or published — CONFIRMED**
`src/lib/tools/signal-tools.ts:367-390` never sets `created_by`. The RLS update/delete policies require `created_by IN (caller's profiles)`. With `created_by` NULL the predicate is never true, so every custom signal a user creates is permanently uneditable and undeletable. Confirmed both in code and against the live policy definitions.

**P1-4. Reply matching never checks who sent the reply — REPORTED, code-verified**
`src/lib/services/gmail-service.ts:276-311` matches purely on `In-Reply-To`/`References`, never comparing the sender to `sent_emails.to_email`. Consequences: an out-of-office autoresponder marks the prospect as `replied`, which permanently terminates their sequence; a forwarded reply is stored and displayed as the prospect's own words; and anyone holding the Message-ID who mails from `postmaster@` can clear a contact's email verification.

**P1-5. The CSV parser corrupts every quoted row — REPORTED, code-verified**
`src/components/campaign/csv-upload.tsx:59-112` strips quotes in pass 1, then splits on every comma in pass 2. `"Acme, Inc",acme.com,"San Francisco, CA"` becomes 5 columns instead of 3, shifting every subsequent field. Silent — the preview shows the corrupted mapping as though it were the file. This is your primary bulk-input path.

**P1-6. Signals report success regardless of what they found — REPORTED, code-verified**
`src/lib/signals/executor.ts:205,298` hardcode `found: true` whenever the call didn't throw. `:230-248` wraps recipe _execution_ in the same try/catch as recipe _lookup_, so a Stagehand timeout silently downgrades to a homepage scrape and still reports found. And `pricing-changes.ts:44-56` + `diff.ts` report "removed 3 tiers" when extraction simply returns empty. Net effect: a scraper outage is indistinguishable from a real signal, and the false signal becomes the personalisation hook in a real email.

**P1-7. Namesake contamination — the bug you already know about — REPORTED, located**
Two near-identical copies: `src/lib/services/person-enrichment.ts:100-186` and `src/lib/tools/enrichment-tools.ts:565-673`. Fixing one leaves the other live. The only filter is a URL dedupe against the _company_ card; nothing checks that a result is about this individual. When company and title are null the query degrades to a bare name search. The results then feed `summarizePerson`, which **overwrites `people.title`** from a stranger's page.

---

### P2 — Hardening, cost control, and hygiene

- **`gmail_app_password_enc` is selectable over PostgREST — CONFIRMED.** I read my own ciphertext back through the public API. Only server code needs it; an XSS or stolen token exfiltrates it. Fix with a column-level `REVOKE`.
- **Forgeable inserts — CONFIRMED for signals, REPORTED for the rest.** `signals_insert`, `usage_insert` are `WITH CHECK (true)`; `sent_emails_insert` and `email_replies_insert` check only `user_id`, not campaign ownership, so rows can be forged into another tenant's campaign and feed their activity UI.
- **`claim_jobs()` is callable by `anon` and `authenticated` over PostgREST — CONFIRMED.** I called it successfully as both. It returns empty today _only_ because `jobs` has RLS enabled with zero policies. Add one well-meaning policy to `jobs` and it becomes a cross-tenant job executor. Its `search_path` is also unpinned. Revoke it.
- **`send-now` doesn't check enrollment ownership — VERIFIED-IN-CODE.** `src/app/api/outreach/send-now/route.ts:83-88` checks `draft.user_id` but then loads the enrollment by `draft.enrollment_id` on the **admin client** with no ownership join, and `sendApprovedDraft` resolves the actual draft _from the enrollment_. Requires knowing two UUIDs, which is why it isn't P0 — but it is exactly the class of bug your recent commits fixed elsewhere.
- **No rate limiting or spend ceiling anywhere.** `find-more-people` has no recency guard at all; a loop from one account bills your Exa and Anthropic keys indefinitely. `/api/chat` has no content-length guard, unlike its better-validated siblings.
- **`/api/settings/costs` shows every user the operator's total bill** across all tenants (`real-spend.ts`), while correctly scoping the per-user figures.
- **Enrichment tools are unscoped.** `enrichContact`, `enrichCompany`, `findContacts`, `scrapeJobListings`, `getGoogleReviews` take a raw UUID with no ownership check — cross-tenant writes plus unbounded spend. `getContactDetail` and `findEmail` were hardened; these were missed.
- **`browserbase-functions/env-probe/` dumps the deployed environment** — full env key inventory plus cleartext values for anything not name-matching `KEY|TOKEN|SECRET|PASSWORD` (so `DATABASE_URL` and connection strings with inline passwords come back in the clear), plus a live CDP session handle. Nothing in `src/` invokes it; it is deploy-ready and committed. Delete it.
- **Browserbase sessions leak** on the create-timeout path (`web-extraction-service.ts:512-533`) and on CDP-connect failure (`yc-scraper.ts:82-94`), because session creation sits outside the `try/finally`. `yc-scraper.ts:110-136` also has an unbounded scroll loop on a billed session.
- **Hunter API key travels in the query string** (`hunter-provider.ts:60,115`) — every other provider uses headers.
- **Scripts have no production guard.** Only `clear-local-data.mjs` checks the host. `audit-data-quality`, `test-signal-recipe`, `try-swipe-prompts`, `probe-affiliation` etc. build a service-role client from whatever `.env.local` holds — and you test against production. Two of them document themselves as "read-only" while writing `api_usage` rows.
- **No security headers at all** — no CSP, no `X-Frame-Options`/`frame-ancestors`, no `nosniff`. The app can be framed, and "Approve all" / "Send all" are clickjackable.
- **No URL-scheme validation on rendered links** — `linkedin_url`, Exa result URLs, scraped post URLs and CSV-imported `url` all become `href`s without a `http(s)` check.
- **UI error swallowing.** `outreach/review/page.tsx:336-408` discards the `error` on every Supabase write and reports success regardless; combined with the known Clerk role-claim footgun, a whole review session can be a silent no-op behind green toasts. And `handleSendNow` flips the draft to `approved` _before_ sending, leaving it approved on failure — so a send the user saw fail gets picked up and sent later.
- **`user_id` is still nullable** on `campaigns`, `chats`, `user_profile`, `api_usage`; the "NOT NULL added later" never happened. Ownerless rows are invisible to RLS but real to service-role code.
- **Policies on role `public` instead of `authenticated`** for `user_settings`, `email_drafts`, `sent_emails`, `sequences`, `sequence_steps`, `sequence_enrollments`, `email_replies` — CONFIRMED against the live database. Combined with the Clerk role-claim gotcha this produces a split-brain state where half the app works and half silently returns nothing.

---

### P3 — Test suite and documentation

**The e2e suite is broken and CI never runs it.** `pnpm test:e2e` gives **28 failures / 121 passes**. CI (`.github/workflows/ci.yaml`) runs only lint, typecheck and unit tests, so this has been rotting invisibly. Unit tests are healthy: **685 passing**, and `pnpm typecheck` is clean.

I diagnosed each failure — **none is an application bug**:

- **24 failures**: every browser/page test. Root cause found and verified — `e2e/helpers.ts` `authCookiesFor()` sets only `__session`, but Clerk also needs `__client_uat`. With `__client_uat=0` the middleware treats the user as signed out and redirects to `/login`. I reproduced the failure and then fixed it live in a browser by setting both cookies. Note that even then, client-side Supabase reads return nothing because Clerk's _client_ SDK has no session — so these tests need a real sign-in (Clerk test instances accept code `424242` for `+clerk_test@` addresses; I used exactly this to drive the app successfully as a real signed-in user).
- **1 failure**: `auth.flow.test.ts:22` asserts the redirect URL matches `/\/login(\/.*)?$/`, but the app now redirects to `/login?redirect_url=…`; the `$` anchor fails on the query string. App behaviour is correct (verified: `/` → 307 → `/login?redirect_url=…`).
- **1 failure**: `api.auth.test.ts:117` tests the `handle_new_user` trigger, which the Clerk migration **deliberately dropped**. The test outlived the feature.
- **2 failures**: `api.routes.test.ts` expects 404 where the hardened routes now return 403. Verified live: `/api/enrich` with an unknown contact returns `403 Forbidden`. That is arguably the _better_ behaviour (no UUID oracle), but it is inconsistent — sibling routes return 404 for the same condition. Pick one convention.

Documentation: `docs/architecture.md:57-73` describes a data model that does not exist — `chat_sessions`, `chat_messages`, `user_profiles`, `team_members`, `signal_runs`, `signal_events`, `email_events`, `knowledge_base` are all wrong or nonexistent. For an open-source repo this is the first document a contributor trusts. Also `pnpm setup` is shadowed by pnpm's own built-in `setup` command, so the first command in your README, CONTRIBUTING and setup docs runs the wrong thing and never executes `scripts/setup.mjs`. And `docker-compose.yaml:32` health-checks `/api/health`, which does not exist, so every self-hosted container is permanently unhealthy.

---

## The plan

Sequenced so that each phase is independently shippable and the riskiest gaps close first. Phases 1 and 2 are the ones I would not sleep on.

### Phase 1 — Close the multi-tenant holes (one migration + one route fix)

1. **Scope the shared pool.** Replace `people_select/update` and `orgs_select/update` `USING (true)` with an `EXISTS` predicate mirroring the existing `camp_people_select` pattern — restrict to rows reachable through the caller's `campaign_people` / `campaign_organizations`. This is the single highest-value change in this document. Expect to also fix any code that relied on reading the whole pool.
2. **Tighten the forgeable inserts.** `signals_insert` → require `is_builtin = false` and `created_by` in the caller's profiles; `signals_select` → `is_builtin OR is_public OR own`; `usage_insert` → `user_id = requesting_user_id()`; add campaign-ownership `EXISTS` to `sent_emails_insert` and `email_replies_insert`.
3. **`REVOKE EXECUTE ON claim_jobs FROM public, anon, authenticated`** and pin its `search_path`.
4. **`REVOKE SELECT (gmail_app_password_enc) ON user_settings FROM authenticated, anon`.**
5. **Fix `send-now`**: select the enrollment through `sequences!inner(user_id)` and assert ownership.
6. Re-scope the `public`-role policies to `TO authenticated`.

**Verification:** I have the exact probe script design that proved these (two Clerk users, cross-tenant read/write/forge attempts). Re-running it after Phase 1 should flip all five FAILs to PASS. Worth committing as a permanent e2e test — this is the class of bug most likely to regress.

### Phase 2 — Stop the agent being weaponisable

1. **One shared `safeFetch(url)`** used by every scraper: require `http(s)`, resolve DNS and reject loopback / RFC1918 / link-local / metadata IPs _before_ connecting, `redirect: "manual"` with a bounded re-validating follow loop, and a response size cap. Validate URLs at the `import-csv` boundary too. One helper closes six call sites — and must also cover the three new services from `a2d9f9c`.
2. **Remove the born-approved path**: `saveDraft` should never mint `review_status: "approved"`. Require an out-of-band confirmation (e.g. `email_drafts.user_confirmed_at`, settable only by a UI action) checked in the same block as `review_status`. Prompt text must not be the last line of defence for an irreversible action — the codebase already argues this in `email-tools.ts:907-910`.
3. **Add `UNTRUSTED_NOTICE` to `SYSTEM_PROMPT`**, and wrap `extractWebContent` output and `enrichment_data` at the tool boundary.
4. **Wrap the composer's inputs** in `src/lib/email-composition/skill.ts` — two lines, the helper already exists.
5. **Remove the `?q=` auto-send.** Hand the text over via `sessionStorage` from `/chat/page.tsx` (the only legitimate producer), or prefill the input and require a click.
6. **Delete `browserbase-functions/env-probe/`.**
7. **Add `backup-*.sql`, `*.dump`, `*.csv`, `.clerk`, `.vercel`, `.claude` to `.dockerignore`.**

### Phase 3 — Correctness

1. **Re-seed the built-in signals** in a new idempotent migration (`INSERT ... ON CONFLICT (slug) DO NOTHING`). This heals fresh installs, local resets, and any emptied table in one file. Do not edit `20260427000000` — it is applied history.
2. **Daily cap**: check the query `error` and refuse on failure. Ideally move cap-check and insert into one Postgres function, which also closes the documented overshoot race.
3. **`createSignal`**: set `created_by`; backfill existing rows.
4. **Reply matching**: require `fromEmail === sent.to_email` for a `replied` verdict, or record third-party replies as a distinct kind that does not terminate the sequence. Constrain the bounce heuristic to the recipient's or your own domain.
5. **CSV parser**: single-pass RFC4180 parse. Add tests for quoted commas, embedded newlines, and `""`.
6. **Signal truthfulness**: derive `found` from the payload; separate recipe-lookup failure from recipe-execution failure; treat empty-extraction-against-non-empty-baseline as inconclusive.
7. **Namesake fix**: first collapse the two enrichment copies into one, then add a person-anchored relevance judge that defaults to dropping on ambiguity, skip searches with nothing to anchor on, and gate the `title` write-back.

### Phase 4 — Hardening and cost control

Per-user rate limits and a daily spend ceiling on every paid endpoint; a recency guard on `find-more-people`; ownership checks on the unscoped enrichment tools; fix the Browserbase session leaks and the unbounded scroll; move the Hunter key to a header; add security headers and a `safeHref` helper; gate `realSpend` behind an operator check; `SET NOT NULL` on the four nullable `user_id` columns after cleaning orphans; check `error` on the review-page writes and revert `review_status` when a send fails.

### Phase 5 — Tests and docs

1. Fix `authCookiesFor` to include `__client_uat`, and move the page tests to a real Clerk sign-in with `+clerk_test@` addresses and code `424242`.
2. Delete the `handle_new_user` test; fix the login-redirect regex; align the 403-vs-404 convention and update the two route tests.
3. **Add e2e to CI** (against a local Supabase + Clerk test instance) so this cannot rot again. Add the tenant-isolation probe as a permanent test.
4. Guard e2e and every script with an `assertLocalSupabase()` helper — mirroring the Clerk `pk_test_` guard that already exists, which is exactly the right pattern. This matters specifically because you test against production.
5. Rewrite the `docs/architecture.md` data model from the real schema; rename `pnpm setup` → `pnpm run setup` (or rename the script); add the missing `/api/health` route; declare `whoami()` and `pg_net` in a migration.

---

## Re-validation needed

Because another session committed during this audit, before executing Phase 2 confirm the SSRF surface in the three new services from `a2d9f9c` (`domain-resolver.ts`, `organization-website.ts`, `directory-domains.ts`) — they had no raw `fetch` when I checked, but they resolve domains, which is precisely the risky shape. The new `website` route's ownership gate is correct.

## What I verified as genuinely good

Worth stating, because it is most of the codebase. The API layer's ownership checks are correct on 28 of 31 routes. `claimAndSendDraft`'s claim is a genuinely atomic compare-and-set — no double-send. The crypto is correct (AES-256-GCM, fresh IV per message, auth tag verified, key length asserted) and decrypted passwords never reach a log or a response. The kill switch is checked before any spend. Hunter billing is exactly the lazy just-in-time design you intended, and the daily cap really does bound it. There is no `dangerouslySetInnerHTML` anywhere. Reply bodies never reach an LLM. The job queue's claim semantics (lease reaping, `FOR UPDATE SKIP LOCKED`, per-user fairness, singleton keys) are correct, and the cron routes fail closed on a missing secret. `contact-discovery.ts`, the affiliation model, and the email-pattern inference are the strongest files in the tree. No `pull_request_target`, no secret echoing, least-privilege workflow permissions, non-root Docker runtime, and a strong `setup.mjs` key generator.
