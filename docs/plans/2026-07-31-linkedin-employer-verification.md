# LinkedIn Employer Verification Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Resolve `uncertain` contact affiliations by reading the employer off
the person's LinkedIn profile — upgrading real employees to sendable, detaching
proven strangers — so people like "Yuval Ben Or (Granulate)" stop sitting in the
Granola list looking exactly like a confirmed employee.

**Architecture:** The primitive already exists and is fully tested:
`checkLinkedInEmployer` in `src/lib/services/affiliation.ts:353`. Nothing calls
it. This plan wires it into phase 2 of `findContactsForOrganization` for the
narrow set of candidates the LLM judge could not settle, adds a `linkedin_mismatch`
affiliation source so a confirmed mismatch can displace a weak stamp, and closes
the send-gate hole that a detached-but-confident row would otherwise open.

**Tech Stack:** TypeScript, Next.js 16 App Router, Supabase, Vitest, Exa,
Browserbase (via `WebExtractionService`).

---

## Background you need before starting

Read these three files before writing any code:

- `src/lib/services/affiliation.ts` — the confidence model. A weight per
  evidence source (`AFFILIATION_WEIGHT`, line 28), a monotonic writer
  (`recordAffiliation`, line 68), the send predicates (`canSendTo` line 168,
  `canDraftFor` line 273), and the unused primitive (`checkLinkedInEmployer`,
  line 353).
- `src/lib/services/contact-discovery.ts` — the single path all contacts are
  discovered through. Phase 1 scrapes the company website, phase 2 runs one Exa
  search per title and hands the results to the LLM judge.
- `src/lib/services/contact-filter.ts:291` — the judge. Returns
  `verified` / `uncertain` / `rejected` per candidate.

### The bug this fixes, concretely

1. `contact-discovery.ts:279` builds `"Granola" Revenue Operations site:linkedin.com`
   and runs it through Exa with `searchType: "auto"` (`exa-service.ts:142`) —
   neural retrieval, so quoting buys nothing. A RevOps leader at **Granulate**
   comes back.
2. The judge sees only the headline, _"Revenue Operations Leader || GTM Engineer"_,
   which names no employer. `contact-filter.ts:365` explicitly instructs that a
   headline naming no employer is `uncertain`, never `rejected`. That rule is
   correct and must not be weakened — it was deleting 22 of 41 genuine contacts.
3. `contact-discovery.ts:381` — `attachTo = verdict === "rejected" ? null : organizationId`.
   `uncertain` attaches to the org at `search_stamp` (0.2).
4. Their LinkedIn page title reads `Yuval Ben Or - Granulate (An Intel Company) | LinkedIn`.
   `checkLinkedInEmployer` would normalize that to `granulate an intel` vs
   `granola`, fail substring both ways, and return `mismatch`. It is never called.

### Five constraints that are easy to get wrong

1. **`unknown` must change nothing.** LinkedIn rate-limits with HTTP 999 and
   roughly half of logged-out attempts come back empty. Treating a block as a
   mismatch would unlink real employees at random. This is already documented at
   `affiliation.ts:345-352` — honour it.
2. **LinkedIn fetches cost real money.** `WebExtractionService.extract` cascades
   direct fetch → Browserbase Fetch (`PRICING.browserbase_fetch`) → full browser
   session (billed per hour, `web-extraction-service.ts:195`). LinkedIn reliably
   blocks the free tier, so _every_ check will cascade. This is why the work is
   capped, concurrency-limited and deadline-bounded rather than run over every
   candidate.
3. **Never check `verified` or `rejected` candidates.** The judge already
   settled those. Only `uncertain` + has a LinkedIn URL is eligible. Anything
   else is spend for no decision.
4. **`recordAffiliation` is monotonic on the _source weight_, not the stored
   confidence.** The guard reads `affiliation_source` and maps it through
   `AFFILIATION_WEIGHT` (line 92-96). The `affiliation_confidence` column is
   read only by the send gate. That separation is what lets Task 2 write a high
   displacement weight and a zero send-confidence on the same row.
5. **The send gate never checks `organization_id`.** `SEND_GATE_COLUMNS`
   (line 293) selects it, but neither `canSendTo` nor `canDraftFor` looks at it,
   and it is absent from the `SendCandidate` interface (line 143). So a detached
   row carrying confidence ≥ 0.6 passes the affiliation half of the gate. A
   person already enrolled in a sequence is reachable via the enrollment query
   in `src/app/api/outreach/process/route.ts:110` even with no org. **Task 1
   must land before Task 2** or the mismatch path makes strangers _more_
   sendable, not less.

### Commands you will run constantly

```bash
pnpm vitest run src/__tests__/affiliation.test.ts    # one file
pnpm test                                            # everything
pnpm typecheck
pnpm lint
```

---

## Task 1: Send gate requires an employer

Defensive groundwork, valuable on its own, and a hard prerequisite for Task 2.

**Files:**

- Modify: `src/lib/services/affiliation.ts:143-151` (`SendCandidate`), `:168`
  (`canSendTo`), `:273` (`canDraftFor`)
- Test: `src/__tests__/affiliation.test.ts`

**Step 1: Write the failing tests**

Add to `src/__tests__/affiliation.test.ts`. Check the file's existing
`canSendTo` describe block first and match its fixture style — if there is a
local helper building a sendable candidate, reuse it rather than inlining these
literals.

```typescript
describe("send gate: employer required", () => {
  const sendable = {
    work_email: "a@acme.com",
    personal_email: null,
    work_email_source: "user_entered",
    work_email_verification: "deliverable",
    affiliation_confidence: 0.9,
    affiliation_source: "team_page",
    organization_id: "org-a",
  };

  it("blocks a contact with no employer on file", () => {
    // A detached row is a person we could not place anywhere. Confidence says
    // nothing about who they work for when organization_id is null, so the
    // numeric threshold alone is not a sufficient gate.
    const check = canSendTo({ ...sendable, organization_id: null });
    expect(check.ok).toBe(false);
    expect(check.ok === false && check.reason).toMatch(
      /not linked to a company/i,
    );
  });

  it("blocks drafting for a contact with no employer on file", () => {
    const check = canDraftFor({ ...sendable, organization_id: null });
    expect(check.ok).toBe(false);
  });

  it("still allows a contact who has an employer", () => {
    expect(canSendTo(sendable).ok).toBe(true);
  });
});
```

**Step 2: Run and watch it fail**

```bash
pnpm vitest run src/__tests__/affiliation.test.ts -t "employer required"
```

Expected: FAIL. `canSendTo` returns `{ ok: true }` for the detached candidate
because nothing reads `organization_id`. TypeScript may also complain that
`organization_id` is not on `SendCandidate` — that is part of the failure.

**Step 3: Implement**

In `src/lib/services/affiliation.ts`, add the field to the interface at line 143:

```typescript
export interface SendCandidate {
  work_email: string | null;
  /** Read only to give an accurate refusal reason — never sendable itself. */
  personal_email?: string | null;
  work_email_source: string | null;
  work_email_verification: string | null;
  affiliation_confidence: number | null;
  affiliation_source: string | null;
  /**
   * Who we believe they work for. `affiliation_confidence` is confidence in
   * *this* link; with no link there is nothing for the number to be about, and
   * a detached row carrying a high score would otherwise clear the threshold.
   */
  organization_id?: string | null;
}
```

Then add the same guard to both predicates, immediately before the existing
`confidence < AFFILIATION_SEND_THRESHOLD` check (line 236 in `canSendTo`, line
278 in `canDraftFor`):

```typescript
if (!person.organization_id) {
  return {
    ok: false,
    reason:
      "not linked to a company — outreach personalises against the employer, so there is nothing to write about",
  };
}
```

**Step 4: Verify**

```bash
pnpm vitest run src/__tests__/affiliation.test.ts
pnpm typecheck
```

Expected: PASS, clean typecheck. `organization_id` is optional on the interface
so existing callers still compile; `SEND_GATE_COLUMNS` already selects it.

**Step 5: Check for callers that now need the column**

```bash
grep -rn "canSendTo\|canDraftFor" src --include=*.ts | grep -v affiliation
```

For each call site, confirm the row it passes was selected with
`SEND_GATE_COLUMNS` (or otherwise includes `organization_id`). A row that omits
the column reads `undefined` and would now be blocked. `src/app/api/outreach/process/route.ts:231`
is the main one — verify its select.

> **Stop and report** if any call site selects columns by hand without
> `organization_id`. Widening those selects is in scope; silently leaving them
> to fail closed is not.

**Step 6: Commit**

```bash
git add src/lib/services/affiliation.ts src/__tests__/affiliation.test.ts
git commit -m "fix(affiliation): send gate requires a linked employer"
```

---

## Task 2: A confirmed mismatch can detach

**Files:**

- Modify: `src/lib/services/affiliation.ts:20-50` (source union + weights), `:128-137` (the update)
- Test: `src/__tests__/affiliation.test.ts`

### Design, and why

A mismatch needs to express two different things at once:

- **Displacement strength 0.8** — strong enough to overrule `search_stamp` (0.2)
  and `llm_verified` (0.6), never strong enough to overrule `team_page` (0.9),
  `email_domain` (0.95) or `user_entered` (1.0). If the company's own website
  lists them, a scraped LinkedIn title does not get to argue.
- **Send confidence 0** — they are attached to nobody.

Those are different numbers on the same row, which the existing design already
separates: the monotonic guard reads the _source_, the send gate reads the
_column_. So the change is a new source at weight 0.8, plus: when
`organizationId` is null, write confidence 0 regardless of source weight.

This also incidentally fixes the existing `rejected` path, which writes
`search_stamp` (0.2) against a null org — "we are 0.2 confident they work at
nobody" was always meaningless.

Stickiness falls out for free: once someone is `linkedin_mismatch` (0.8), a
later `llm_verified` (0.6) search cannot re-file them under the same wrong
company, but a team-page listing (0.9) still can.

**Step 1: Write the failing tests**

```typescript
describe("mismatch detachment", () => {
  it("detaches someone whose LinkedIn names a different employer", async () => {
    seed({
      organization_id: "org-a",
      affiliation_source: "search_stamp",
      affiliation_confidence: AFFILIATION_WEIGHT.search_stamp,
    });

    await recordAffiliation(client(), {
      personId: "p1",
      organizationId: null,
      source: "linkedin_mismatch",
      evidence: "LinkedIn profile reads 'Granulate (An Intel Company)'",
    });

    expect(people[0].organization_id).toBeNull();
    expect(people[0].affiliation_source).toBe("linkedin_mismatch");
  });

  it("writes zero confidence for a detached person", async () => {
    // The column means "confidence they work at organization_id". With no org
    // there is nothing for it to be about, and any non-zero value would clear
    // AFFILIATION_SEND_THRESHOLD on a row nobody can vouch for.
    seed({
      organization_id: "org-a",
      affiliation_source: "search_stamp",
      affiliation_confidence: AFFILIATION_WEIGHT.search_stamp,
    });

    await recordAffiliation(client(), {
      personId: "p1",
      organizationId: null,
      source: "linkedin_mismatch",
      evidence: "profile names another employer",
    });

    expect(people[0].affiliation_confidence).toBe(0);
  });

  it("does not detach someone the company itself lists", async () => {
    // A stale or misparsed LinkedIn title must not overrule the company's own
    // team page.
    seed({
      organization_id: "org-a",
      affiliation_source: "team_page",
      affiliation_confidence: AFFILIATION_WEIGHT.team_page,
    });

    await recordAffiliation(client(), {
      personId: "p1",
      organizationId: null,
      source: "linkedin_mismatch",
      evidence: "profile names another employer",
    });

    expect(people[0].organization_id).toBe("org-a");
    expect(people[0].affiliation_source).toBe("team_page");
  });

  it("keeps a detached person from being re-filed by a weaker search", async () => {
    seed({
      organization_id: null,
      affiliation_source: "linkedin_mismatch",
      affiliation_confidence: 0,
    });

    await recordAffiliation(client(), {
      personId: "p1",
      organizationId: "org-a",
      source: "llm_verified",
      evidence: "headline looks right",
    });

    expect(people[0].organization_id).toBeNull();
  });
});
```

**Step 2: Run and watch it fail**

```bash
pnpm vitest run src/__tests__/affiliation.test.ts -t "mismatch detachment"
```

Expected: FAIL — `"linkedin_mismatch"` is not a member of `AffiliationSource`,
so this will not compile until Step 3.

**Step 3: Implement**

Add to the union at `affiliation.ts:20`:

```typescript
export type AffiliationSource =
  | "user_entered"
  | "email_domain"
  | "team_page"
  | "linkedin_profile"
  | "llm_verified"
  | "search_stamp"
  | "linkedin_mismatch";
```

Add to `AFFILIATION_WEIGHT` (after `linkedin_profile`, line 41):

```typescript
  /**
   * Their LinkedIn profile names a DIFFERENT employer. Same strength as
   * linkedin_profile because it is the same evidence read the same way — strong
   * enough to displace a search stamp or an LLM guess, never strong enough to
   * overrule the company's own team page or a human.
   */
  linkedin_mismatch: 0.8,
```

Change the update at line 128 so a detached write scores zero:

```typescript
// Confidence is "how sure are we they work at organization_id". Detached,
// there is no such claim to be confident about — and a non-zero score on a
// null-org row would clear the send threshold for a person nobody can vouch
// for. The displacement strength still comes from the source weight above,
// which is what the monotonic guard reads.
const storedConfidence = organizationId === null ? 0 : incoming;

await supabase
  .from("people")
  .update({
    organization_id: organizationId,
    affiliation_source: source,
    affiliation_confidence: storedConfidence,
    affiliation_evidence: evidence.slice(0, 500),
    affiliation_verified_at: new Date().toISOString(),
  })
  .eq("id", personId);
```

**Step 4: Verify**

```bash
pnpm vitest run src/__tests__/affiliation.test.ts
pnpm typecheck
```

Expected: PASS. Watch for a `switch` or `Record<AffiliationSource, …>` elsewhere
that the new union member makes non-exhaustive — typecheck will name it.

**Step 5: Check the UI copy path**

```bash
grep -rn "search_stamp\|llm_verified\|affiliation_source" src/components src/app --include=*.tsx
```

`src/components/ui/provenance-badge.tsx:156` (`AffiliationBadge`) maps sources
to labels. Add a `linkedin_mismatch` case reading something like "employer
mismatch" — a source it does not recognise must not render as blank or as "ok".

**Step 6: Commit**

```bash
git add src/lib/services/affiliation.ts src/__tests__/affiliation.test.ts src/components/ui/provenance-badge.tsx
git commit -m "feat(affiliation): linkedin_mismatch source detaches weak stamps"
```

---

## Task 3: The bounded resolver

A pure-ish orchestration helper, unit-tested without touching the network.

**Files:**

- Modify: `src/lib/services/contact-discovery.ts`
- Test: `src/__tests__/contact-discovery.test.ts`

### Budget

| Knob                       | Value  | Why                                                                                                                                                      |
| -------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MAX_LINKEDIN_CHECKS`      | 5      | Every check cascades to Browserbase (constraint 2). Five bounds the spend per discovery call the same way `MAX_TITLES` bounds Exa.                       |
| Concurrency                | 3      | Browserbase session limits are low on small plans; three keeps us under them while still overlapping the slow fetches.                                   |
| `LINKEDIN_CHECK_BUDGET_MS` | 20_000 | `findContacts` is a synchronous agent tool. Unresolved candidates stay `uncertain`, which is exactly what they were — running out of time costs nothing. |

**Step 1: Write the failing test**

Add to `src/__tests__/contact-discovery.test.ts`. **Two mock changes are
required first, or the suite will crash rather than fail:**

```typescript
// The affiliation mock currently exports only recordAffiliation. Discovery is
// about to import checkLinkedInEmployer from the same module, and a partial
// mock makes that `undefined` at call time.
const employerCheck = vi.fn();
vi.mock("@/lib/services/affiliation", () => ({
  recordAffiliation: vi.fn(async (_c: unknown, a: Record<string, unknown>) => {
    affiliations.push(a);
  }),
  checkLinkedInEmployer: (...args: unknown[]) => employerCheck(...args),
}));
```

Add `employerCheck.mockReset().mockResolvedValue({ status: "unknown", reason: "not stubbed" });`
to the existing `beforeEach` at line 99, so tests that do not care about this
path keep their current behaviour.

Then the tests:

```typescript
describe("resolving uncertain affiliations", () => {
  const uncertainCandidate = () => {
    exaResults.results = [
      {
        url: "https://www.linkedin.com/in/yuval-ben-or",
        title: "Yuval Ben Or - Revenue Operations Leader || GTM Engineer",
      },
    ];
    judged.mockResolvedValue([
      {
        index: 0,
        name: "Yuval Ben Or",
        title: "Revenue Operations Leader",
        verdict: "uncertain",
        evidence: "headline names no employer",
      },
    ]);
  };

  it("upgrades an uncertain contact whose profile names the target company", async () => {
    uncertainCandidate();
    employerCheck.mockResolvedValue({
      status: "match",
      employer: "Browserbase",
    });

    const result = await run();

    const last = affiliations[affiliations.length - 1];
    expect(last.source).toBe("linkedin_profile");
    expect(last.organizationId).toBe("org-1");
    expect(result.verifiedCount).toBe(1);
    expect(result.uncertainCount).toBe(0);
  });

  it("detaches an uncertain contact whose profile names someone else", async () => {
    uncertainCandidate();
    employerCheck.mockResolvedValue({
      status: "mismatch",
      employer: "Granulate (An Intel Company)",
    });

    const result = await run();

    const last = affiliations[affiliations.length - 1];
    expect(last.source).toBe("linkedin_mismatch");
    expect(last.organizationId).toBeNull();
    expect(last.evidence).toContain("Granulate");
    expect(result.employerMismatched).toBe(1);
    // Detached people are not contacts at this company any more.
    expect(result.contacts).toHaveLength(0);
  });

  it("leaves the contact untouched when LinkedIn tells us nothing", async () => {
    // HTTP 999 is the common case, not the edge case.
    uncertainCandidate();
    employerCheck.mockResolvedValue({ status: "unknown", reason: "999" });

    const result = await run();

    expect(result.uncertainCount).toBe(1);
    expect(result.contacts).toHaveLength(1);
    expect(affiliations.some((a) => a.source === "linkedin_mismatch")).toBe(
      false,
    );
  });

  it("never checks candidates the judge already settled", async () => {
    exaResults.results = [
      { url: "https://www.linkedin.com/in/a", title: "A - Browserbase" },
    ];
    judged.mockResolvedValue([
      {
        index: 0,
        name: "A",
        title: null,
        verdict: "verified",
        evidence: "headline names it",
      },
    ]);

    await run();

    expect(employerCheck).not.toHaveBeenCalled();
  });

  it("survives a thrown check without failing discovery", async () => {
    uncertainCandidate();
    employerCheck.mockRejectedValue(new Error("browserbase exploded"));

    const result = await run();

    expect(result.uncertainCount).toBe(1);
    expect(result.error).toBeUndefined();
  });
});
```

**Step 2: Run and watch it fail**

```bash
pnpm vitest run src/__tests__/contact-discovery.test.ts -t "resolving uncertain"
```

Expected: FAIL — `employerCheck` never called, `employerMismatched` undefined.

**Step 3: Implement the resolver**

In `src/lib/services/contact-discovery.ts`, add near `MAX_TITLES` (line 46):

```typescript
/**
 * Per-call ceiling on LinkedIn employer checks.
 *
 * Every check cascades through WebExtractionService to Browserbase — LinkedIn
 * blocks the free direct fetch — so this bounds real money the same way
 * MAX_TITLES bounds Exa spend. Unchecked candidates simply stay `uncertain`,
 * which is where they already were.
 */
export const MAX_LINKEDIN_CHECKS = 5;

/** Browserbase session limits are low; three overlapping fetches stays under them. */
const LINKEDIN_CHECK_CONCURRENCY = 3;

/** findContacts is a synchronous agent tool. Unresolved is a fine outcome. */
const LINKEDIN_CHECK_BUDGET_MS = 20_000;
```

Add the resolver as a module-level function in the same file:

```typescript
interface UncertainRow {
  personId: string;
  linkedinUrl: string;
  contactIndex: number;
}

type Resolution =
  | {
      personId: string;
      contactIndex: number;
      outcome: "match";
      employer: string;
    }
  | {
      personId: string;
      contactIndex: number;
      outcome: "mismatch";
      employer: string;
    };

/**
 * Ask LinkedIn who these people actually work for.
 *
 * Only ever called for candidates the LLM judge returned `uncertain` for — the
 * ones where a headline named no employer at all. `verified` and `rejected` are
 * already settled and re-checking them is spend for no decision.
 *
 * Best-effort throughout: an `unknown` verdict, a throw, or running out of
 * budget all leave the contact exactly as the judge left it.
 */
async function resolveUncertainEmployers(
  rows: UncertainRow[],
  companyName: string,
): Promise<Resolution[]> {
  const queue = rows.slice(0, MAX_LINKEDIN_CHECKS);
  if (queue.length === 0) return [];

  const deadline = Date.now() + LINKEDIN_CHECK_BUDGET_MS;
  const resolutions: Resolution[] = [];
  let cursor = 0;

  const worker = async () => {
    while (cursor < queue.length && Date.now() < deadline) {
      const row = queue[cursor++];
      try {
        const check = await checkLinkedInEmployer(row.linkedinUrl, companyName);
        if (check.status === "match" || check.status === "mismatch") {
          resolutions.push({
            personId: row.personId,
            contactIndex: row.contactIndex,
            outcome: check.status,
            employer: check.employer,
          });
        }
      } catch (err) {
        // A scraper failure is not evidence about where anyone works.
        console.error(
          `[contact-discovery] Employer check failed for ${row.linkedinUrl}:`,
          err,
        );
      }
    }
  };

  await Promise.all(
    Array.from(
      { length: Math.min(LINKEDIN_CHECK_CONCURRENCY, queue.length) },
      worker,
    ),
  );

  if (queue.length < rows.length) {
    console.log(
      `[contact-discovery] Checked ${queue.length} of ${rows.length} uncertain contacts (cap ${MAX_LINKEDIN_CHECKS})`,
    );
  }

  return resolutions;
}
```

Add the import at the top of the file, extending the existing
`@/lib/services/affiliation` import block (line 18):

```typescript
import {
  recordAffiliation,
  checkLinkedInEmployer,
  type AffiliationSource,
} from "@/lib/services/affiliation";
```

**Step 4: Do not run yet** — the resolver is unreferenced. Go straight to Task 4;
they commit together.

---

## Task 4: Wire the resolver into phase 2

**Files:**

- Modify: `src/lib/services/contact-discovery.ts:364-425` (the judged loop),
  `:66-94` (`ContactDiscoveryResult`)
- Modify: `src/lib/tools/enrichment-tools.ts:1437-1453` (tool result)

**Step 1: Collect the uncertain rows**

Inside the `for (const judged of ...)` loop, in the branch where a contact is
pushed, record which ones were uncertain. Declare above the loop:

```typescript
const uncertainRows: UncertainRow[] = [];
let employerConfirmed = 0;
let employerMismatched = 0;
```

Then, immediately after `contacts.push({...})` at line 413, add:

```typescript
// Only the unsettled ones, and only when we can actually look them up.
if (judged.verdict === "uncertain" && person.linkedin_url) {
  uncertainRows.push({
    personId: person.id,
    linkedinUrl: person.linkedin_url,
    contactIndex: contacts.length - 1,
  });
}
```

**Step 2: Apply resolutions after the loop**

Directly after the closing brace of `if (candidates.length > 0) { ... }` (line 425):

```typescript
// ── Phase 3: resolve what the judge could not ───────────────────────────
// The judge only ever saw a one-line headline. For the candidates whose
// headline named no employer, the profile itself usually does.
//
// Detached people are collected by id and filtered out at the end rather
// than spliced out here: `contactIndex` points into `contacts`, so mutating
// the array mid-loop would invalidate every later index.
const detached = new Set<string>();

for (const res of await resolveUncertainEmployers(uncertainRows, org.name)) {
  const contact = contacts[res.contactIndex];
  if (!contact) continue;

  if (res.outcome === "match") {
    const evidence = `LinkedIn profile names "${res.employer}"`;
    await recordAffiliation(supabase, {
      personId: res.personId,
      organizationId,
      source: "linkedin_profile",
      evidence,
    });
    contact.affiliation = "linkedin_profile";
    contact.affiliationEvidence = evidence;
    uncertainCount--;
    verifiedCount++;
    employerConfirmed++;
  } else {
    const evidence = `LinkedIn profile names "${res.employer}", not "${org.name}"`;
    await recordAffiliation(supabase, {
      personId: res.personId,
      organizationId: null,
      source: "linkedin_mismatch",
      evidence,
    });
    uncertainCount--;
    employerMismatched++;
    detached.add(res.personId);
  }
}

// Reporting someone as a contact at this company one line after detaching
// them is how a caller ends up drafting for a stranger.
const finalContacts = detached.size
  ? contacts.filter((c) => !detached.has(c.id))
  : contacts;
```

Return `finalContacts` in place of `contacts` in the result object, and set
`totalFound: finalContacts.length`.

**Step 3: Extend the result type**

In `ContactDiscoveryResult` (line 66), after `rejectedAsWrongCompany`:

```typescript
/** Uncertain contacts whose LinkedIn profile confirmed the target company. */
employerConfirmed: number;
/** Uncertain contacts whose LinkedIn profile named a different employer; detached. */
employerMismatched: number;
```

Add both to the returned object _and_ to the `empty()` helper at line 123 —
missing them there is a type error and a lie in the error path.

**Step 4: Surface them to the agent**

In `src/lib/tools/enrichment-tools.ts`, add to the returned object at line 1447:

```typescript
      employerConfirmed: result.employerConfirmed,
      employerMismatched: result.employerMismatched,
```

Without this the agent cannot tell the user "I dropped one — their LinkedIn says
Granulate", which is the whole point of the feature.

**Step 5: Run the full discovery suite**

```bash
pnpm vitest run src/__tests__/contact-discovery.test.ts
pnpm typecheck
```

Expected: PASS, including the five new tests from Task 3.

**Step 6: Run everything**

```bash
pnpm test && pnpm lint
```

Expected: no regressions. Pay attention to any existing test asserting an exact
`totalFound` or an exact shape of the `findContacts` tool result.

**Step 7: Commit**

```bash
git add src/lib/services/contact-discovery.ts src/lib/tools/enrichment-tools.ts src/__tests__/contact-discovery.test.ts
git commit -m "feat(contact-discovery): resolve uncertain affiliations via LinkedIn"
```

---

## Task 5: Make it visible in the list

The reason this bug was invisible: the table that shows leads renders no
provenance at all.

**Files:**

- Modify: `src/components/campaign/companies-list.tsx:670-780` (`ContactsTable`)

**Step 1: Confirm the data is already there**

```bash
grep -n "affiliation" src/app/campaigns/\[id\]/page.tsx src/lib/types/campaign.ts
```

`affiliation_source`, `affiliation_confidence` and `affiliation_evidence` are
already loaded onto every `CampaignContact` (`campaigns/[id]/page.tsx:171-176`,
typed at `campaign.ts:262-264`). No query changes needed.

**Step 2: Render the badge**

`AffiliationBadge` already exists (`src/components/ui/provenance-badge.tsx:156`)
and renders nothing when the employer is confirmed — a quiet list means everyone
is sendable. Two tables already use it (`campaign/contacts-table.tsx:186`,
`outreach/review/page.tsx:903`); this one just never got it.

Add the import, then in the Name cell (around line 745, beside the LinkedIn
link):

```tsx
<AffiliationBadge person={contact} />
```

Prefer the Name cell over Title — this table has no Company column to hang it
off, and the badge is about the person's presence in the list.

**Step 3: Verify by eye**

```bash
pnpm dev
```

Open a campaign with a company that has unproven contacts. Expected: rows at
`search_stamp` show the badge; verified rows look unchanged.

> **Note:** your local Supabase (`127.0.0.1:54321` per `.env.local`) will not
> have the Granola data — that lives in the deployed instance. Either seed a
> low-confidence row locally or check this on the deployed app after Task 6.

**Step 4: Commit**

```bash
git add src/components/campaign/companies-list.tsx
git commit -m "feat(ui): show affiliation provenance in the company lead list"
```

---

## Task 6: Verify against the real case

**Step 1: Confirm the diagnosis on real data**

Against the deployed Supabase, find the row:

```sql
select p.id, p.name, p.title, p.affiliation_source, p.affiliation_confidence,
       p.affiliation_evidence, o.name as org
from people p left join organizations o on o.id = p.organization_id
where p.name ilike '%yuval%';
```

Expected before the fix: `affiliation_source = 'search_stamp'`,
`affiliation_confidence = 0.2`, `org = 'Granola'`.

> **Stop and report** if it is anything else — `team_page` or `user_entered`
> would mean he arrived by a different path and this plan does not address it.

**Step 2: Re-run discovery**

Trigger "Find more people" on Granola, or ask the agent to run `findContacts`
for it. Watch the server log for:

```
[contact-filter] Judging N candidates for "Granola"
[WebExtract] Fetching: https://www.linkedin.com/in/...
```

**Step 3: Confirm the outcome**

Re-run the SQL. Expected: `affiliation_source = 'linkedin_mismatch'`,
`affiliation_confidence = 0`, `organization_id` null. The Granola lead count
drops by one and he no longer appears under the company.

**Step 4: Confirm nobody real was lost**

```sql
select affiliation_source, count(*)
from people
where organization_id is null
group by 1;
```

Expected: `linkedin_mismatch` is a small number. If it is large, the normalizer
is over-rejecting — likely a company whose LinkedIn name differs legitimately
from ours (rebrand, or "Acme (YC W24)"). `checkLinkedInEmployer` already does
bidirectional substring matching to cover that, but verify before trusting it at
scale.

**Step 5: Commit any fixes, then open the PR**

```bash
git log --oneline main..HEAD
```

Expected: five commits, one per task.

---

## Out of scope, deliberately

- **Fixing person enrichment.** `src/app/api/enrich/route.ts:157-160` pins the
  org name into the Exa query with no check that a result is about the person
  _at_ that company, which is why Yuval's card is full of Granola funding news.
  That is the open namesake bug and wants its own plan — but note this plan
  reduces the blast radius, since detached people stop being enriched as
  employees.
- **Making the Exa search literal.** Switching `searchType` from `"auto"` to
  `"keyword"` in `contact-discovery.ts:281` would stop Granulate matching
  Granola at the source. It would also lose the semantic recall the whole
  discovery flow depends on. Worth measuring separately, not bundling here.
- **Backfilling existing rows.** Every contact already stored at `search_stamp`
  stays as it is until discovery next runs for their company. A backfill job is
  a follow-up once the mismatch rate above is known to be sane.
