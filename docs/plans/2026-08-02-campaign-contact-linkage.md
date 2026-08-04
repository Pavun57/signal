# Contacts That Never Reach The Campaign Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make "the agent found people, the campaign still says 0 leads" impossible, by closing the three separate paths that discover or refuse contacts without ever writing a `campaign_people` row or telling the user why, and by giving a domain-less company the one thing it needs to hold contacts at all: a website.

**Architecture:** Nothing here changes how discovery judges people. Every fix is wiring around `findContactsForOrganization`. `find-more-people` starts passing the campaign the page already holds. The campaign page starts reading the response it already receives. Companies with no leads get the button they currently do not have. And `organizations.domain`, today a write-once field with no path to fill it in later, gets a resolver (Google Places already fetches `websiteUri` and throws it away) plus a writer that merges rather than duplicates when the resolved domain already belongs to another row.

**Tech Stack:** TypeScript, Next.js 16 App Router, Supabase, Vitest + Testing Library, Exa, Google Places, AI SDK v6.

**Baseline:** rewritten against `main` at `95dface` (2026-08-02), 15 commits after the first draft. That range landed the ownership work (`src/lib/tools/ownership.ts`, `tool-ownership.test.ts`, the enrich and to-company gates) and the sending kill switch. **None of the files this plan changes were touched by it**, so all three defects below are still live, but the new ownership helpers are now the required pattern for Tasks 1 and 4.

**Branch:** `fix/campaign-contact-linkage`, off `main` at `95dface`.

**Status: Tasks 1 to 5 are implemented, tested and committed** (`8f301f1`, `40d8fac`, `a2d9f9c`, `ac21ce4`). 707 tests pass, typecheck and eslint are clean, and `pnpm build` succeeds with the new route registered. Task 0 is the only open item and is the user's to run, since production is not reachable from the implementing session. Deviations from the plan as written are recorded under each task.

---

## The evidence this plan is built on

Read this before changing anything. The reported symptom was a campaign ("Birmingham Nursing Homes, Interim Manager") showing 12 companies, all under "Companies without leads", 0 contacts, after the agent reported finding people.

**The screen is driven by one table.** `src/app/campaigns/[id]/page.tsx:93` loads contacts from `campaign_people` only, and `src/components/campaign/companies-list.tsx:143-148` sorts a company into "with leads" or "without leads" purely by whether a loaded contact carries its `organization_id`. So the screen means exactly one thing: zero `campaign_people` rows exist for this campaign. It says nothing about whether people were found or stored.

**Three code paths produce that screen. Two are confirmed defects on any campaign.**

1. `src/app/api/companies/[id]/find-more-people/route.ts:59` passes `campaignId: null` into `findContactsForOrganization`. Discovery then sets `people.organization_id` and skips `linkPersonToCampaign` entirely (`src/lib/services/contact-discovery.ts:537`). The found people are real and visible on `/companies/[id]`, which queries by `organization_id` (`src/app/companies/[id]/page.tsx:96`), while `FindMoreButton` reports "Added 3 new people" (`src/components/company/find-more-button.tsx:54`). The campaign never sees them. The page already holds the campaign in state (`campaignId`, `src/app/companies/[id]/page.tsx:74`, fed by `CampaignSelector`) and does not pass it down (`:301`).

2. `src/components/campaign/companies-list.tsx:217-235` calls `/api/find-contacts` and discards the response. That route returns **HTTP 200 with an `error` field** when discovery refuses (`src/app/api/find-contacts/route.ts:92`), and `apiFetch` does not throw on a non-2xx, so the `catch` is dead for HTTP failures too. Spinner, then nothing, no toast on any outcome. `FindMoreButton` already carries this fix and the comment explaining it (`src/components/company/find-more-button.tsx:40-44`); the campaign copy was never updated.

3. `src/lib/services/contact-discovery.ts:211-215` refuses any company with no `domain` before a single search runs, and that refusal is what defect 2 swallows. Directory-sourced local businesses land domain-less routinely: `discoverCompanies` extracts `domain` as a nullable field and stores whatever the model found (`src/lib/tools/search-tools.ts:758`). Supporting evidence from the report: not one of the 12 rows shows a favicon or a website link, and both render only when `company.url` is set (`companies-list.tsx:1204`, `:1225`).

**Which of the three hit that particular campaign is unconfirmed.** Local Supabase is empty and reading the production project was blocked by the permission classifier, so this plan fixes all three rather than guessing. Task 0 settles it and is the user's to run.

**The dead end behind defect 3.** Nothing in the product can give an existing organization a domain. `findOrCreateOrganization` writes `domain` only on INSERT (`src/lib/services/knowledge-base.ts:133-146`; the update branch above it touches industry, location, description and url, never domain), `enrichCompany` reads `org.domain` throughout and never writes it back, and no API route updates `organizations` at all. The system prompt tells the agent to fix it (`src/lib/system-prompt.ts:120`: "find the company's website (`searchCompanies` or a web search), save it, then retry"), but `searchCompanies` calls `findOrCreateOrganization` with a domain, which finds no match by domain, refuses to merge on name by design, and INSERTs a **second** company row (`src/lib/tools/search-tools.ts:253-262`). Following the prompt's own instruction duplicates the company and leaves the original still unable to hold anyone. That is why Task 4 exists.

**The resolver already exists and is being discarded.** `GooglePlacesService` requests `places.websiteUri` and returns it (`src/lib/services/google-places-service.ts:33`, `:115`, `:162`), and `getGoogleReviews` stores only rating, review count, maps URL and reviews (`src/lib/tools/enrichment-tools.ts:2072-2080`). For local businesses (care homes, dental practices, estate agents: exactly what `discoverCompanies` targets) a name plus a location is enough for Places to return the official website. No new vendor, no new key.

**What the ownership work changed for this plan.** `src/lib/tools/ownership.ts` is now the required gate for any tool taking a bare uuid (`toolSession()`, `callerHoldsOrganization()`, `notFound()`), and `getCompanyDetail` shows the shape to copy (`search-tools.ts:345-365`). Its own doc comment records a design fact that Task 1 has to answer rather than ignore: contacts can reach `people` with no campaign link at all, and "Find more people" stores them that way **on purpose**. Task 1 does not undo that. It links only when the page is actually scoped to a campaign, and makes the toast say which case happened. Separately, `/api/people/[id]/to-company` now requires the caller to hold the contact (`65f360b`), but it still has no `canHoldPeople` guard, so a hand-assigned person can sit on a domain-less org: Task 4b must move people, not assume the row is empty.

---

## House rules that will bite you

- **No em dashes in any string, template chunk or JSX text.** eslint blocks them under `no-restricted-syntax` for `src/**`, `scripts/**`, `e2e/**` (`eslint.config.mjs:21-26`). Use commas, colons, parentheses or a full stop.
- **Vitest does not typecheck.** It transpiles with esbuild, so "this will not compile" is not observable in `vitest run`. Run `pnpm typecheck` alongside the red step and treat its output as the compile evidence.
- **The first vitest run on a cold Vite cache can take minutes.** Later runs finish in seconds. Not a hang.
- **`apiFetch` never throws on a non-2xx.** Any new call site reads `res.ok` and the body. Copy `findEmailsForCompany` (`companies-list.tsx:256-266`), do not invent a third pattern.
- **Use `createSupabaseFake` for new DB-touching tests** (`src/__tests__/helpers/supabase-fake.ts`). It projects `select()` and honours `eq`/`limit`/`single`, and its header records the nine production reverts the old hand-rolled fakes let through. Hand-rolled clients only where an existing sibling test already uses one and the new case fits it.
- **Scripted edits must assert.** No `str.replace` patch scripts. Use the Edit tool, or make the script fail loudly when its target does not match.

```bash
pnpm vitest run src/__tests__/<file>       # one file
pnpm vitest run                            # everything
pnpm exec eslint <files>
pnpm typecheck                             # rm -rf .next/types first if it complains about deleted routes
```

---

## Task 0: Confirm which defect produced the reported campaign (OPEN, user-run)

No code, and not a blocker: all three defects are real regardless. It decides whether people are recoverable for that campaign, and how loudly Task 4 needs to land. Production is not reachable from this session.

```sql
select o.name, o.domain, o.url,
       (select count(*) from people p where p.organization_id = o.id) as attached_to_org,
       (select count(*) from campaign_people cp
          join people p2 on p2.id = cp.person_id
         where cp.campaign_id = co.campaign_id and p2.organization_id = o.id) as in_campaign
from campaign_organizations co
join organizations o on o.id = co.organization_id
join campaigns c on c.id = co.campaign_id
where c.name ilike '%Birmingham Nursing%';
```

- `domain` null on every row: defect 3, no search ever ran, nothing to recover, Task 4 is the headline.
- `attached_to_org > 0` with `in_campaign = 0`: defect 1 (or an agent call that omitted `campaignId`). Task 1 stops the bleeding; add Task 1b, a one-off backfill script under `scripts/` that asserts its affected row count, to recover the existing people.
- Both: fix both, and note which company is which.

Record the answer in this file before starting Task 1b (Tasks 1 to 5 do not wait on it).

---

## Task 1: "Find more people" links what it finds to the campaign (DONE, `8f301f1`)

**Files:**

- Modify: `src/app/api/companies/[id]/find-more-people/route.ts` (:7-11 signature, :35-62 body)
- Modify: `src/components/company/find-more-button.tsx`
- Modify: `src/app/companies/[id]/page.tsx:301`
- Test: `src/__tests__/find-more-people-route.test.ts` (new)

**Step 1: Write the failing tests**

1. Body carries a `campaignId` the caller owns, and the org is linked to that campaign: `findContactsForOrganization` is called with that `campaignId`. Mock the service and assert the argument.
2. Body carries a `campaignId` the caller does not own, **or** one the org is not linked to: 403, and discovery is never called. The existing org gate (`route.ts:21-33`) does not cover this. Owning the campaign and owning the org are separate facts, and neither implies the org is in that campaign.
3. No `campaignId` in the body: the run still happens with `campaignId: null`, and the response reports that it was not linked. This is the deliberate unscoped mode `ownership.ts` documents, so it must keep working.

**Step 2: Implement**

Route: read an optional `campaignId` from the JSON body. The handler currently takes `_request` and no body at all, so add the parse with a `catch` for an empty body exactly as `/api/find-contacts:14-19` does (a bodyless POST from the current button must not 400). Validate, pass through, and return `campaignId` in the payload.

Button: accept an optional `campaignId` prop, send it, and split the toast. Linked: "Added 3 people to this campaign." Unlinked: "Added 3 people to the company. They are not in a campaign yet." The second sentence is the entire point of the task.

Page: pass `campaignId` at `src/app/companies/[id]/page.tsx:301`.

**Step 3: Verify**

`pnpm vitest run src/__tests__/find-more-people-route.test.ts && pnpm typecheck && pnpm exec eslint src/app/api/companies src/components/company src/app/companies`

---

## Task 2: The campaign's find-leads path stops swallowing its own answer (DONE, `40d8fac`)

**As built:** Tasks 2 and 3 shipped together in one commit and one test file. The find-leads button could not be exercised through the "with leads" branch the plan named, because that branch is unreachable, so the tests drive it through the without-leads rows Task 3 adds. Both the dead branch and the new button call the same handler.

**Files:**

- Modify: `src/components/campaign/companies-list.tsx:217-235` (`findContactsHandler`)
- Test: `src/__tests__/companies-list-find-leads.test.tsx` (new), mirroring the mocks in `src/__tests__/companies-list-review-queue.test.tsx` (`apiFetch`, `sonner`, `EmbeddedOrgChart`, `@/lib/supabase/client`)

**Step 1: Write the failing tests**

1. 200 with `{ error: "\"Cedar Lodge Nursing Home\" has no domain on record, ..." }`: `toast.error` gets that message. Today nothing fires.
2. 200 with `{ totalFound: 0, contacts: [] }`: an informational toast, and `onDataChanged` still fires.
3. 200 with contacts plus `uncertainCount`: success toast naming both, worded as `FindMoreButton` already words it (`find-more-button.tsx:49-57`). Two buttons describing one service two ways is how this started.
4. Not ok: `toast.error`, and no success reported. The case the dead `catch` never covered.

**Step 2: Implement**

Rewrite `findContactsHandler` to read `res.ok`, parse the body, branch error / empty / success, following `findEmailsForCompany` (`companies-list.tsx:256-266`). Keep `onDataChanged()` on every path that may have written rows.

**Step 3: Verify**

`pnpm vitest run src/__tests__/companies-list-find-leads.test.tsx && pnpm typecheck && pnpm exec eslint src/components/campaign/companies-list.tsx`

---

## Task 3: Companies without leads get a way to find leads (DONE, `40d8fac`)

The without-leads rows render a name, an industry, an optional website link and an **Enrich** button, nothing else (`companies-list.tsx:1202-1263`). The "Find leads" button exists only inside an expanded company in the with-leads section, behind `companyContacts.length === 0` (`:648-671`), which that section can practically never reach. For the 12 companies in the report there was no in-product way to search for contacts at all.

**Files:**

- Modify: `src/components/campaign/companies-list.tsx` (`CompaniesWithoutLeads` at `:1161`, and its call site)
- Test: extend `src/__tests__/companies-list-find-leads.test.tsx`

**Step 1: Write the failing tests**

1. Expand "Companies without leads", click "Find leads" on a company with a domain: `apiFetch` is called with `/api/find-contacts` and that company's link id.
2. A company with `domain: null` renders the inline reason and no enabled button, and clicking fires nothing.

**Step 2: Implement**

Thread `onFindContacts` and `findingContactsIds` into `CompaniesWithoutLeads`, render the button beside Enrich, reuse the existing label and spinner.

For `domain: null`, do not render an enabled button that is guaranteed to come back refused. Render the reason inline ("No website on record, so contacts cannot be attached") next to whatever Task 4 adds. A button that always fails is worse than no button: that is the lesson of Task 2.

**Step 3: Verify**

`pnpm vitest run src/__tests__/companies-list-find-leads.test.tsx && pnpm typecheck && pnpm exec eslint src/components/campaign/companies-list.tsx`

---

## Task 4: A company's website can be resolved and saved (DONE, `a2d9f9c`)

**As built, differing from the plan:**

- The write logic lives in `src/lib/services/organization-website.ts`, not inline in the route, so the agent tool runs the same merge rather than a second copy of it. The route is the ownership gate and the HTTP shape.
- The directory blocklist moved to `src/lib/services/directory-domains.ts` (whole block, including `brandFromDomain`), and `carehome.co.uk`, `carehomes.co.uk`, `autumna.co.uk`, `lottie.org`, `cqc.org.uk` and `trustedcare.co.uk` were added: the largest UK care home directories were absent, which is exactly the industry in the report.
- `createSupabaseFake` gained `delete()` support rather than the test working around its absence, per the note in its own header.
- The name check is stricter than "some overlap": every significant token of the company name has to appear in what came back, with industry words treated as noise. That is what stops "Cedar Lodge Nursing Home" resolving to "Cedar House Care Home".

The core fix, in four steps because the merge is where this gets dangerous.

**Files:**

- Add: `src/lib/services/domain-resolver.ts`
- Add: `src/app/api/companies/[id]/website/route.ts`
- Modify: `src/lib/tools/enrichment-tools.ts` (new `setCompanyWebsite` tool), `src/lib/tools/index.ts` (register it)
- Modify: `src/lib/system-prompt.ts:120`
- Modify: `src/components/campaign/companies-list.tsx` (the Task 3 affordance)
- Tests: `src/__tests__/domain-resolver.test.ts`, `src/__tests__/company-website-route.test.ts`

**Step 4a: The resolver (reads only, writes nothing)**

`resolveOrganizationDomain(org)` returns `{ domain, url, source, evidence }` or null. Order: Google Places by name plus location (it already cross-verifies a supplied domain against `websiteUri`, `google-places-service.ts:118-125`, so half the matching is written), then an Exa fallback for what Places does not carry. Reject directory and aggregator hosts with the existing `isDirectoryDomain` / `isDirectoryTitle` helpers, currently module-private at `src/lib/tools/search-tools.ts:114` and `:134`: move them into the service layer and import from there, so the dependency runs one way rather than a service importing a tool file. A care home whose website resolves to carehome.co.uk is this entire plan's bug one level up.

Tests: a Places hit returns the apex domain through `normalizeDomain`; a Places hit on a directory host returns null; no hit returns null rather than throwing.

**Step 4b: The writer, with the merge case**

`PATCH /api/companies/[id]/website` with `{ url }` (user-entered) or `{ resolve: true }` (run 4a). Ownership: the `campaign_organizations -> campaigns!inner(user_id)` check the sibling routes use (`find-more-people/route.ts:21-33`).

`idx_organizations_domain` is unique (`supabase/migrations/20260419000000_initial_schema.sql:389`), so writing a domain another org already holds fails. When the resolved domain belongs to an existing org B:

1. Re-point every `campaign_organizations` row from A to B, skipping any that would duplicate an existing (campaign, org) pair.
2. Move any `people` carrying `organization_id = A`. `canHoldPeople` blocks the discovery paths (`contact-discovery.ts:211`, `enrichment-tools.ts:162`), but `/api/people/[id]/to-company` has no such guard, so a hand-assigned person can exist. Count and move; do not assume empty.
3. Move `signal_results` rows pointing at A.
4. Delete A only when every check reports zero remaining references. Return `{ merged: true, into: B.id }` so the UI refetches instead of showing a row that no longer exists.

Tests: clean write sets domain and url; colliding write merges and says so; a merge that would duplicate a campaign link skips that link rather than failing; a merge is refused (no delete) when a reference is left behind.

**Step 4c: The tool and the prompt**

`setCompanyWebsite({ organizationId, url? })`: with a url it saves, without one it resolves first. Gate it with `toolSession()` + `callerHoldsOrganization()` + `notFound()` exactly as `getCompanyDetail` does (`search-tools.ts:345-365`); it takes a bare organization uuid, which is the shape the ownership work was written for. Return the merge information so the agent stops referring to an id that just merged away. Then fix `system-prompt.ts:120`, whose current instruction produces a duplicate company row.

**Step 4d: The UI**

On a without-leads row with no domain, render the Task 3 reason plus "Find website" (calls the route with `resolve: true`) and a manual entry input. A user typing the address is the highest-confidence source available, which is how `user_entered` is treated everywhere else here.

**Verify:** `pnpm vitest run && pnpm typecheck && pnpm exec eslint src`

---

## Task 5: Stop creating domain-less companies at the source (DONE, `ac21ce4`)

`discoverCompanies` creates an org per extracted business and links it to the campaign whether or not the extractor found a website (`src/lib/tools/search-tools.ts:758-773`). For local-business ICPs that is the normal case, which is how a campaign ends up with 12 companies that can never hold a contact.

Between extraction and `findOrCreateOrganization`, run Task 4a's resolver for any company with a null domain: bounded concurrency, a per-call timeout, and a log line reporting resolved versus still-null. Keep creating the org either way. An unresolved company is still a lead, and Tasks 3 and 4d now let the user fix it by hand.

Test: a company extracted without a domain is stored with the resolver's answer; one the resolver cannot place is still created with a null domain.

**Verify:** `pnpm vitest run && pnpm typecheck`

---

## Out of scope

- How discovery judges affiliation. `filterContactsByCompany` and `recordAffiliation` are untouched.
- Making `campaignId` required on `findContacts` / `searchPeople`. Ad-hoc research without a campaign is deliberate (`system-prompt.ts:260`, `:263`) and `ownership.ts` now depends on people existing outside campaigns. If Task 0 shows the agent simply forgot to pass one, fix the prompt first.
- Backfilling domains across every existing domain-less org. Task 0 may justify a one-off for the reported campaign; a global sweep is a separate decision with real API spend attached.
