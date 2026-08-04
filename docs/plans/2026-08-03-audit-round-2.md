# Signal — Audit Round 2 (post-merge, on `main`)

**Tree:** `main` @ `ecd6e5b` (PR #57 merged). Round 1 audited `40d8fac`; this round re-reviews the whole repo on main and deep-reviews the ~1,950 new lines.
**Companion doc:** `2026-08-03-security-audit-remediation.md` (round 1). Everything there still stands — `supabase/`, `.github/`, `Dockerfile`, `.dockerignore` and `package.json` are **byte-identical** to what I audited, so all database, CI, Docker and secrets findings carry over unchanged.

**Evidence tags:** **CONFIRMED** = I reproduced it live. **VERIFIED** = I read the exact lines and the claim follows directly. **REPORTED** = surfaced by a review pass, consistent with the code, not independently reproduced.

**Baseline on main:** typecheck clean · lint 0 errors (10 warnings) · **709 unit tests pass** (up from 685) · e2e **28 failed / 121 passed** — identical to round 1, and still the same test rot (CI never runs e2e).

**Correction to round 1:** my probe reported `/api/dashboard`, `/api/outreach/activity` and `/api/settings/email` as reachable unauthenticated. That was a false positive — my probe followed redirects. Re-tested with `redirect: "manual"`: all three correctly return **307 → /login**. No unauthenticated API exposure exists.

---

## The headline: the product's core loop is dead code

**R2-1. Signal-triggered outreach can never run — CONFIRMED**

`createSequence` is the only writer of the `sequences` table, and it inserts `status: "draft"` (`src/lib/tools/sequence-tools.ts:84, 160`). The consumer requires active (`src/lib/jobs/executors/outreach-process.ts:78`):

```ts
.from("sequences").eq("status", "active")
```

I checked every one of the 8 references to `from("sequences")` across `src/`, `e2e/` and `scripts/`: lines 177, 315 and 574 are SELECTs, and the only three `status: "active"` writes in the codebase target `tracking_configs` and `sequence_enrollments` — never `sequences`. **No sequence can ever become active.**

So `handleSignalTrigger` returns `{sent: 0, reason: "no matching sequences"}` at line 81, _before_ `pickAndDraft` is ever reached. The advertised loop — signal fires → agent picks the best contact → drafts → sends — has never run for anyone. What works today works only through the fallback at `outreach-process.ts:468-489`.

There is **zero test coverage** of the `type: "signal"` branch, which is why it shipped. Fix: relax to `.in("status", ["draft","active"])`, or activate on first successful draft.

---

## New P0 — cross-tenant compromise paths

These all descend from the round-1 finding that `people`/`organizations`/`signals` have `USING (true)` RLS. Round 2 traces what that actually buys an attacker.

**R2-2. Cross-tenant outbound email redirection, full chain — REPORTED (each link VERIFIED)**
An attacker updates the shared `organizations` row for a company victim V targets: `domain = attacker.tld`, `email_pattern = {first}.{last}`, `email_pattern_confidence = 1`, `is_catch_all = false`. There is no CHECK on `email_pattern` (bare TEXT) and `renderPattern` never validates against `KNOWN_PATTERNS`. V runs `findEmail` → the poisoned pattern clears the confidence threshold, MX passes (attacker owns DNS), and `work_email = first.last@attacker.tld` is written. At send time the attacker's mailserver accepts exactly that mailbox, so the verifier returns `deliverable` — and `send-verification.ts:145-152` then grants affiliation `source: 'email_domain'` at weight **0.95** (`affiliation.ts:53`), clearing the 0.6 send threshold. **The affiliation gate built to prevent pitching the wrong company is upgraded by the attacker's own mailserver.** V's mail leaves V's Gmail to the attacker.

**R2-3. Signals are a world-writable, permanently-undeletable prompt-injection surface — CONFIRMED (insert), VERIFIED (interpolation)**
`signals_insert` is `WITH CHECK (true)`, but update _and_ delete both require `is_builtin = false`. So anyone can insert `is_builtin: true` and **no one can ever delete or edit it through the API** — it lands in every tenant's built-in gallery permanently. I confirmed the insert live in round 1.

The payload matters: `src/lib/system-prompt.ts:336, 340` interpolate `signal.description` and `signal.config.instructions` **raw** into the system prompt whenever the signal is attached to a campaign. That is the highest-trust context in an agent holding `sendEmail`/`sendBulkEmails`, and nothing goes near `wrapUntrusted`. `campaign_signals` RLS only checks the _campaign_ is yours, not the signal.

**R2-4. Signal `config` is executed as raw tool arguments — every zod schema bypassed — VERIFIED**
`src/lib/signals/executor.ts:169-197` spreads `signal.config` into `tool.execute(args, …)` directly, so the AI SDK's `inputSchema` never runs. `extractWebContent`'s `z.string().url()`, `scrapeJobListings`' `.uuid()` and `.max(50)` — all bypassed. `config.url` takes precedence over the org domain (`:177`), so the fetch target is fully attacker-chosen. This runs in the `/api/jobs/run` cron path under `getAdminClient()` (**RLS bypassed**), and the response body is written to `signal_results.output`, which is `SELECT USING (true)` — so an SSRF response to an internal service becomes readable by every authenticated user. One-line fix: `inputSchema.parse(args)` before `execute`.

---

## New findings in the code merged today

**R2-5. The org merge moves other tenants' contacts — CONFIRMED (live, two users)**
`setCompanyWebsite` merges when the typed domain collides with an existing org. `mergeOrganizations` (`organization-website.ts:95-100`) runs `update({organization_id: toId}).eq("organization_id", fromId)` on `people` with the **RLS-scoped** client — but `people` UPDATE is `USING (true)`, so it rewrites _every tenant's_ rows. I set this up with users A and B and observed B's contact silently re-filed under A's organization, while B's campaign link stayed pointing at the now-stale original. B's campaign is left showing a company with no contacts.

Note: one review pass concluded "merge cannot damage another tenant" — that is correct for `campaign_organizations` (properly RLS-scoped) but misses `people`. My live result governs.

**R2-6. The merge reports a deletion that never happened — CONFIRMED**
`organizations` has SELECT/INSERT/UPDATE policies and **no DELETE policy**, so the delete at `organization-website.ts:115` affects 0 rows and returns no error. I observed the API return `deletedOld: true, remaining: 0, "Merged into the existing record"` while the old row still existed. `signal_results` likewise has no UPDATE policy, so that move is also a silent no-op. Two route tests assert the delete and the move — neither can happen in production.

**R2-7. Unrelated companies get merged into one — CONFIRMED**
`normalizeDomain` returns the registrable apex. I ran the real code:

```
cedarlodge.business.site  ->  business.site
oakhouse.business.site    ->  business.site      <-- same row
cedarlodge.wordpress.com  ->  wordpress.com
acme.wixsite.com          ->  acme.wixsite.com   (correctly preserved)
```

`business.site` and `wordpress.com` aren't on the PSL private list, so two unrelated care homes collapse to one domain, hit the unique index, and **merge into a single company**. Every later `findContacts` runs `site:business.site` and every guessed address is minted `@business.site`. This is the target ICP (small local businesses on hosted site builders), not an edge case.

**R2-8. The directory blocklist misses the big aggregators — CONFIRMED**
Ran against the real `isDirectoryDomain`: `zoominfo.com`, `apollo.io`, `rocketreach.co`, `bbb.org`, `opencorporates.com`, `yell.co.uk` (only `yell.com` is listed) all return **false**. A ZoomInfo listing page names the company in its title, so `namesMatch` passes and it is accepted as the company's website. `findContacts` then files strangers from a ZoomInfo page as employees — precisely what the file's docblock exists to prevent.

**R2-9. The new route stores internal addresses as company domains — CONFIRMED, full SSRF chain traced**
`saveOrganizationWebsite` validates only `typeof url === "string"`. I PATCHed real values and observed what was stored:

```
http://169.254.169.254/latest/meta-data/  ->  domain=169.254.169.254   200 OK
http://127.0.0.1:54321/rest/v1/           ->  domain=127.0.0.1         200 OK
file:///etc/passwd                        ->  domain=file              200 OK
"x" * 5000                                ->  5000-char domain         200 OK
```

`file:` becomes `file` because the code prepends `https://` to anything not matching `^https?://`, producing a parseable-but-wrong URL. The 5,000-character string is accepted because `normalizeDomain` falls back to returning its raw input when `getDomain` returns null — **it is a normalizer being used as a validator**.

The chain completes downstream: `enrich-company/route.ts:244-245` builds `companyUrl` from the stored value and calls `extractor.extract(companyUrl)` unconditionally ("Website extraction always runs"), which reaches the unguarded `fetch` at `web-extraction-service.ts:61` and returns up to 3,000 characters of the body to the caller. Round 1 needed CSV import to plant that value; this route makes it a first-class UI action.

**Good news on the new code:** authorization is solid. Both the route and the `setCompanyWebsite` tool gate on `callerHoldsOrganization`, both fail closed, and I confirmed 403 live for a foreign org _and_ for an unowned org. The tool is not a bypass. The `search-tools.ts` refactor dropped nothing (all 70 blocklist entries present, 6 added).

---

## New P1 — correctness bugs that cost money or lose data

- **R2-10. Contact enrichment never records `enrichedAt`, so the 7-day skip never fires — VERIFIED.** `isRecentlyEnriched` reads `enrichment_data.enrichedAt`, which is written only on the two _company_ paths. So `/api/enrich` re-runs Apify LinkedIn + Apify X + 3 Exa searches on every click: **~$0.11 per contact per click, forever**. `/api/enrich/bulk` always computes `alreadyEnriched = 0` and its "all N already enriched" message is unreachable. Company enrichment skips correctly — the asymmetry proves intent. One-line fix: fall back to the `last_enriched_at` column that `mergeEnrichmentData` already writes.
- **R2-11. The cost dashboard is wrong by an order of magnitude — VERIFIED.** Only 3 of ~30 `trackUsage` call sites pass `user_id`; Exa, Apify, Browserbase, Hunter, Google Places and every Claude service call write `null`. Writes use the admin client (they land), but `/api/settings/costs` reads under `usage_select … requesting_user_id() = user_id`, and `NULL = 'user_x'` is never true. A $12 run displays `$0.0000 / 0 calls`.
- **R2-12. `sendEmail`/`sendBulkEmails` never advance the enrollment — VERIFIED.** Only `sendApprovedDraft` advances `current_step`. `sendBulkEmails` selects every approved draft for the campaign with no step scoping, and review's "Approve all" approves all of a contact's steps at once. Result: a prospect receives the cold email, the follow-up and the breakup email **in the same minute**, and every enrollment is then stuck at step 1 forever.
- **R2-13. Daily cleanup deletes approved, still-scheduled drafts — VERIFIED.** `email-cleanup.ts:77-82` deletes `status='draft'` older than 30 days with no `review_status` or enrollment filter, but drafts for _all_ steps are pre-created at enrollment. A step-3 draft on a 21-day delay is deleted on day 30; the enrollment then retries every 15 minutes forever.
- **R2-14. Reply tracking polls only the newest 100 outstanding sends across all users — VERIFIED.** At the default 30/day cap one user passes 100 unanswered sends in ~3.3 days; older sends are ordered out permanently. Cold-email replies land 2–7 days out — exactly the discarded tail. The result is follow-ups sent to people who already replied.
- **R2-15. `findOrCreatePerson` merges two different humans by name — VERIFIED.** The name+org fallback runs even when both records have LinkedIn URLs that differ; the mismatch is never used to reject. The second person is never created, and their evidence is written onto the first person's row.
- **R2-16. `recomputeOrgPattern` erases a learned pattern when its read fails — VERIFIED.** The error is dropped, `inferPattern([])` returns null, and that is persisted unconditionally.
- **R2-17. `fetchWithTimeout` puts no deadline on the body — VERIFIED.** `clearTimeout` sits in the `finally` of `await fetch(...)`, which resolves on _headers_. Every downstream `await res.text()` is unbounded in time and bytes, across 9 sites. A host that dribbles one byte per second holds the invocation to the platform's hard kill. The file's own docblock claims to prevent this.
- **R2-18. Quadratic ReDoS on scraped text — REPORTED (benchmarked by the reviewer).** The email regex over uncapped `body` text measured 20KB → 198ms, 100KB → 5.02s, ~1MB → minutes of **blocked event loop**. Node is single-threaded, so this stalls every concurrent request on the instance. Fix: slice before matching and bound the first group.
- **R2-19. `wrapUntrusted` is trivially escapable — VERIFIED.** It splits on the exact lowercase literals, so `</UNTRUSTED>` or `</untrusted >` closes the fence. This is the codebase's only defence against scraped-content injection.
- **R2-20. `singletonKey` is never passed by any caller — VERIFIED.** The schema comment promises "one running job per key (e.g. `mailbox:<user_id>`) so one inbox never sends two emails concurrently". It is always NULL, and signal-triggered `outreach.process` jobs are enqueued with no `user_id`, landing in the `<system>` fairness partition — permitting **five concurrent send jobs for the same mailbox per tick**, and letting one tenant starve everyone else.

---

## New P1 — UI that loses money or mails the wrong person

- **R2-21. "Send all" fires N irreversible real emails with no confirmation.** The app confirms enrich-all (reversible) and publishing a signal, but not the one action that cannot be taken back.
- **R2-22. "Send all" is _guaranteed_ to fail on any multi-step sequence and misreports the result — VERIFIED.** `classifyDraft` marks every step "ready" because `next_send_at` is copied from the shared enrollment, but `send-now` returns 409 `step_mismatch` for any non-current step. A 3-step × 10-contact sequence yields 30 "ready" drafts and 20 guaranteed 409s — and because the hero never reads a response body, the user is told "20 failed" and is **never told the other 10 actually sent**. The review page gets this right.
- **R2-23. Holding an arrow key in the review flow approves contact after contact; `Cmd+←` rejects.** No `e.repeat` check, no modifier check. Approval _is_ send authorization, and there is no undo anywhere in the flow.
- **R2-24. "Set Up Outreach" auto-fires an agent run against a possibly wrong campaign.** The queued prompt is cleared only on read while the panel is keyed by campaign id, so navigating to a different campaign remounts and auto-sends the stale prompt — enrolling every contact of a campaign the user never chose.
- **R2-25. No error boundary anywhere, and two components will throw.** `activity-detail.tsx` and `cost-center.tsx` both do `.then(r => r.json())` with no `res.ok`, then read fields off an error body — a `TypeError` that blanks the whole route.
- **R2-26. Read failures render as confident empty states that push users toward re-spending.** The campaign page polls every 3s ignoring errors, so one blip replaces a populated pipeline with "No companies in this campaign / Find companies with the agent" — a paid discovery run.
- **R2-27. Three of five money-spending handlers in the rewritten `companies-list.tsx` still swallow every failure** (`enrichContact`, `findEmailForContact`, `enrichCompanyHandler`) — the exact bug the file's own comment describes having fixed, for one handler.
- **R2-28. Delete-campaign copy is backwards.** It claims to delete companies and contacts (which survive) and never mentions what it _does_ irreversibly destroy: `sent_emails`, the record of every real email sent.

---

## Test-suite quality: the number is not the signal

709 tests pass. A reviewer ran mutation testing and got two damning results:

1. Inverting the approved-draft predicate to `review_status='pending' AND status='sent'` → **all 3 relevant tests still pass**, including the one named _"does not send a waiting enrollment whose draft is still pending review"_.
2. Disabling **both** the stop-on-reply guard and the step-condition guard in `outreach-process.ts` → **709/709 still pass**.

Cause: `outreach-process-followups.test.ts` uses a _positional_ fake that returns canned responses in call order and ignores table, filters and payload — the exact anti-pattern `supabase-fake.ts` was written to kill ("nine production reverts passed the entire suite"). Separately, the new route's ownership gate is completely untested: **deleting the 403 check entirely leaves all five route tests green**. The `setCompanyWebsite` tool gate _is_ properly tested (`tool-ownership.test.ts:243-257`) — that's the pattern to copy.

Also worth removing: **`@x402/fetch` is an unused production dependency** with zero imports anywhere, dragging `viem` and the EVM wallet stack into the prod graph. Pure supply-chain surface.

---

## Revised plan

Round 1's phases stand. Insert these ahead of / alongside them:

**Phase 0 — make the product work (new, and it comes first)**

1. Activate sequences (R2-1). Nothing else in the outreach story matters until the signal branch can run, and it needs tests before anything else is built on it.
2. Advance the enrollment in `sendEmail`/`sendBulkEmails`, or route them through `sendApprovedDraft` (R2-12) — otherwise activating sequences means prospects get all three emails at once.
3. Stop `email-cleanup` deleting approved scheduled drafts (R2-13).

**Phase 1 — tenant isolation** (round 1 Phase 1, now with more reasons)
Add: constrain `email_pattern` to `KNOWN_PATTERNS` in DB and code; don't grant `email_domain` affiliation on a domain mutated since the last verified evidence (R2-2); fix `signals_insert` to require `is_builtin = false` and owned `created_by`, and scope `signals_select` (R2-3); add the missing `orgs_delete` / `signal_results_update` policies or move the merge to the admin client after the gate (R2-6).

**Phase 2 — agent and fetch safety** (round 1 Phase 2)
Add: `inputSchema.parse(args)` in the signal executor (R2-4) — one line, closes the worst one; wrap signal text before it enters the system prompt (R2-3); make `wrapUntrusted` use a per-call nonce (R2-19); one `readBodyCapped(res, maxBytes)` helper with its own AbortSignal for all 9 body reads (R2-17), plus response size caps; slice before regex matching (R2-18). Validate URLs in `saveOrganizationWebsite` — reject IP literals, `localhost`, single-label hosts, and anything `getDomain` can't resolve (R2-9); add a `PLATFORM_DOMAINS` reject list and refuse a merge when the two names don't match (R2-7); extend the directory blocklist and require the domain itself to name the company (R2-8); confirm before merging (R2-5).

**Phase 3 — money correctness**
`enrichedAt` fallback (R2-10) · `user_id` in `ActionContext` so `trackUsage` attributes spend (R2-11) · reply-tracking pagination per user (R2-14) · pattern-erase guard (R2-16) · per-user rate limits and a hard spend ceiling in `cost-tracker` (round 1 P2, reinforced: signup is public and there is no limiter anywhere).

**Phase 4 — UI safety**
Confirm before "Send all" (R2-21) · fix ready-classification to compare step against enrollment step, and read the response body (R2-22) · `e.repeat`/modifier guards in review (R2-23) · fix the stale auto-send prompt (R2-24) · add `error.tsx` + `res.ok` checks (R2-25, R2-26, R2-27) · fix the delete-campaign copy (R2-28).

**Phase 5 — tests and docs** (round 1 Phase 5)
Add: replace the positional fake in `outreach-process-followups.test.ts` · add ownership tests for the website route · add coverage for the `type: "signal"` branch, `checkCondition`, `no_open`, `opened_no_reply` · adopt mutation testing for the send path specifically, since that is where a passing suite has twice hidden a live defect · drop `@x402/fetch`.

---

## Still open from round 1

Production has 9 `user_profile` rows. I could not attribute them to real people versus your own test accounts — dumping production data was blocked by a permission prompt. That number decides whether Phase 1 is urgent or merely important, and it is the one thing I'd want from you.
