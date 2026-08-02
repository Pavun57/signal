# Contact Affiliation From Evidence Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Stop filing strangers and ex-employees under a company as if they were staff, by judging affiliation on the profile text and dates Exa already returns instead of on a one-line headline, and by giving the unresolved remainder a human review queue.

**Architecture:** `filterContactsByCompany` gains two inputs it never had (the scraped page text and the page's date) and two verdicts it could never reach (`former_employee`, and a `rejected` it can now actually justify). `recordAffiliation` gains two detaching sources at weight 0.8 so a proven departure or mismatch can displace a search stamp without overruling the company's own team page. A deterministic staleness guard downgrades `verified` calls made on old snapshots. The contacts table then splits into confirmed and needs-review, with the confirm/detach endpoints that already exist wired to buttons.

**Tech Stack:** TypeScript, Next.js 16 App Router, Supabase, Vitest, Exa, AI SDK v6 (`generateObject`) on Haiku (`MODELS.LIGHT`).

**Branch:** create `feat/affiliation-evidence` off `origin/main` before Task 1. The working tree currently carries unrelated edits on `ui-fixes` (`src/app/api/chat/route.ts`, `src/components/agent-panel.tsx`, `src/lib/supabase/server.ts`, `src/lib/tools/enrichment-tools.ts`). Never commit those.

---

## The evidence this plan is built on

Three read-only probes were run against the live Browserbase pipeline on 2026-08-01. They are the reason for every decision below, so read this section before changing anything.

**Probe 1 — the real discovery path, 5 title searches, 39 unique candidates:**

```
current judge  -> uncertain: 39          (every single person)
proposed judge -> verified: 33, former_employee: 3, rejected: 1, uncertain: 3
```

The log line was `[contact-filter] Judging 39 candidates for "Browserbase" (0 name-matched headlines)`. Not one of the 39 LinkedIn headlines contains the word "Browserbase", and `contact-filter.ts:365` instructs that a headline naming no employer is `uncertain` and never `rejected`. So the current judge is structurally incapable of returning anything else for this company. Landing everyone in `uncertain` is not a risk introduced by this change; it is what ships today.

Exa returned usable page text for **39 of 39 candidates (100%)**, and that text carries dated experience blocks:

```
Paul Klein        uncertain -> verified         Browserbase   Jan 2024 - Present
Erik Dominguez    uncertain -> former_employee  Browserbase   Oct 2024 - Mar 2026
Chris Kim         uncertain -> rejected         Box           Jun 2026 - Present
```

**Probe 2 — the eight people the owner flagged as noise.** All eight were `uncertain` under the current judge. Fed the page text, six were rejected outright, each naming the real employer: Bianca Andreea Buzea (Chronicle Labs), Chris Sev (Okta), Carter Rabasa (Box), Ejaz Merchant (Hashgraph), Pratik Sapra (Amazon), Braxton Lancial (Stash). Every one of them is currently sitting in the Browserbase campaign at `search_stamp` 0.2 with a pattern-guessed `@browserbase.com` address.

**Probe 3 — the stale-snapshot case.** Victor Lue's archived profile page is dated 2026-03-29 and says "Customer Engineer at Browserbase, May 2025 - Present". His live LinkedIn headline says "Product Support at Anthropic". Probe 1 called him `verified` on the strength of the stale page. Given both sources with their dates, the judge returned `rejected` and flagged the conflict, while leaving Lindsay Gilson (whose sources agree) `verified`. Dates alone are not enough; snapshot age has to be part of the decision.

Cost of feeding the text in: 25 candidates (the `MAX_TITLES` x `numResults` ceiling) at 1800 characters each is roughly 12k input tokens, about $0.012 per discovery call on Haiku. Negligible, and the text is already paid for at the Exa call.

**Relationship to the other plan on disk.** `docs/plans/2026-07-31-linkedin-employer-verification.md` proposed resolving `uncertain` candidates by fetching each LinkedIn profile through Browserbase, capped at 5 checks per call because each fetch costs real money. Probe 1 shows the free path resolves 36 of 39. **That plan's Task 3 through Task 6 are superseded by this one and must not be built.** Its Task 1 (send gate requires an employer) and Task 2 (a detaching source at 0.8) are prerequisites here and are folded in as Task 1 and Task 2 below, with `linkedin_mismatch` renamed to `employer_mismatch` since the evidence is no longer a LinkedIn fetch.

---

## House rules that will bite you

- **No em dashes in any string, comment or copy.** eslint blocks them (`no-restricted-syntax`). Use commas, colons or parentheses.
- **Vitest does not typecheck.** It transpiles with esbuild, so any step below that predicts "this will not compile" is wrong about what `vitest run` will show you. A test using a union member that does not exist yet runs it as a plain string, which means `AFFILIATION_WEIGHT[missing]` is `undefined` and every comparison against it is false. Measured on Task 2: that made 2 of 5 new tests pass spuriously and a third fail for the wrong reason. Always run `pnpm typecheck` alongside `pnpm vitest run` at the red step, and treat the typecheck output as the compile evidence.
- **The first vitest run on a cold Vite cache can hang for several minutes.** Subsequent runs finish in under 10 seconds. Do not diagnose it as a broken test.
- Every LLM call follows `src/lib/services/relevance-filter.ts` exactly: `generateObject` + `llmTimeout()` abort signal + `trackUsage` + `UNTRUSTED_NOTICE` / `wrapUntrusted` / `stringify` from `@/lib/prompt-safety` + a fail-open catch.
- `recordAffiliation` is monotonic on the **source weight**, not on the stored confidence. The guard reads `affiliation_source` and maps it through `AFFILIATION_WEIGHT` (`affiliation.ts:92-96`). The `affiliation_confidence` column is read only by the send gate. That separation is what lets Task 2 write a high displacement weight and a zero send-confidence onto the same row.
- Commands you will run constantly:

```bash
pnpm vitest run src/__tests__/affiliation.test.ts     # one file
pnpm vitest run                                       # everything
pnpm exec eslint <files>
pnpm typecheck                                        # rm -rf .next/types first if it complains about deleted routes
```

---

## Task 1: The send gate requires an employer

Defensive groundwork and a hard prerequisite for Task 2. Until this lands, detaching someone makes them _more_ sendable, not less: `canSendTo` never reads `organization_id`, so a detached row carrying confidence 0.6 still passes the affiliation half of the gate, and a person already enrolled in a sequence is reachable through the enrollment query in `src/lib/jobs/executors/outreach-process.ts` with no org at all. (That query moved off `src/app/api/outreach/process/route.ts` when the job scheduler landed on main.)

**Files:**

- Modify: `src/lib/services/affiliation.ts:143-151` (`SendCandidate`), `:237` (`canSendTo`), `:279` (`canDraftFor`)
- Test: `src/__tests__/affiliation.test.ts`

**Step 1: Write the failing tests**

Append to `src/__tests__/affiliation.test.ts`, after the `recordAffiliation` describe block. Import `canSendTo` and `canDraftFor` by extending the existing import from `@/lib/services/affiliation`.

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
    // nothing about who they work for once organization_id is null, so the
    // numeric threshold alone is not a sufficient gate.
    const check = canSendTo({ ...sendable, organization_id: null });
    expect(check.ok).toBe(false);
    expect(check.ok === false && check.reason).toMatch(
      /not linked to a company/i,
    );
  });

  it("blocks drafting for a contact with no employer on file", () => {
    expect(canDraftFor({ ...sendable, organization_id: null }).ok).toBe(false);
  });

  it("still allows a contact who has an employer", () => {
    expect(canSendTo(sendable).ok).toBe(true);
  });
});
```

**Step 2: Run and watch it fail**

Run: `pnpm vitest run src/__tests__/affiliation.test.ts -t "employer required"`
Expected: FAIL. `canSendTo` returns `{ ok: true }` for the detached candidate. TypeScript may also object that `organization_id` is not on `SendCandidate`; that is part of the failure.

**Step 3: Implement**

Add the field to `SendCandidate` at `affiliation.ts:143`:

```typescript
export interface SendCandidate {
  work_email: string | null;
  /** Read only to give an accurate refusal reason, never sendable itself. */
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

Add the same guard to both predicates, immediately before the existing `confidence < AFFILIATION_SEND_THRESHOLD` check (line 237 in `canSendTo`, line 279 in `canDraftFor`):

```typescript
if (!person.organization_id) {
  return {
    ok: false,
    reason:
      "not linked to a company, and outreach personalises against the employer, so there is nothing to write about",
  };
}
```

**Step 4: Run to verify pass**

Run: `pnpm vitest run src/__tests__/affiliation.test.ts && pnpm typecheck`
Expected: PASS, clean typecheck. `organization_id` is optional so existing callers still compile, and `SEND_GATE_COLUMNS` (line 293) already selects it.

**Step 5: Check every call site selects the column**

Run: `grep -rn "canSendTo\|canDraftFor" src | grep -v affiliation`

For each hit, confirm the row it passes was selected with `SEND_GATE_COLUMNS` or otherwise includes `organization_id`. A row that omits the column reads `undefined` and is now blocked. `src/lib/services/outreach-sender.ts` and `src/lib/jobs/executors/outreach-process.ts` are the two production call sites; both already select `SEND_GATE_COLUMNS`. The likelier casualties are hand-built test fixtures standing in for those rows, which fail closed once the guard lands. Widen them.

> **Stop and report** if any call site hand-picks columns without `organization_id`. Widening those selects is in scope; leaving them to fail closed silently is not.

**Step 6: Commit**

```bash
git add src/lib/services/affiliation.ts src/__tests__/affiliation.test.ts
git commit -m "fix(affiliation): send gate requires a linked employer"
```

---

## Task 2: Two sources that can detach

### Design, and why

A departure and a mismatch both need to express two things at once:

- **Displacement strength 0.8.** Strong enough to overrule `search_stamp` (0.2) and `llm_verified` (0.6), never strong enough to overrule `team_page` (0.9), `email_domain` (0.95) or `user_entered` (1.0). If the company's own website lists them, a scraped profile snapshot does not get to argue.
- **Send confidence 0.** They are attached to nobody.

Those are different numbers on the same row, which the existing design already separates. So: two new sources at weight 0.8, plus a rule that a write with a null org stores confidence 0 regardless of source weight.

Two sources rather than one because the UI has to say different things. `former_employee` means they really did work there and left, which is useful context for outreach and for the org chart. `employer_mismatch` means the evidence places them at a different company entirely and they were never staff.

This also fixes the existing `rejected` path, which writes `search_stamp` (0.2) against a null org. "We are 0.2 confident they work at nobody" was always meaningless.

Stickiness falls out for free: once someone is at 0.8 detached, a later `llm_verified` (0.6) search cannot re-file them under the same wrong company, but a team page listing (0.9) still can.

**Files:**

- Modify: `src/lib/services/affiliation.ts:20-50` (source union and weights), `:128-137` (the update)
- Test: `src/__tests__/affiliation.test.ts`

**Step 1: Write the failing tests**

```typescript
describe("detaching sources", () => {
  it("detaches someone whose profile names a different employer", async () => {
    seed({
      organization_id: "org-a",
      affiliation_source: "search_stamp",
      affiliation_confidence: AFFILIATION_WEIGHT.search_stamp,
    });

    await recordAffiliation(client(), {
      personId: "p1",
      organizationId: null,
      source: "employer_mismatch",
      evidence: "profile shows Chronicle Labs, Jan 2024 to Present",
    });

    expect(people[0].organization_id).toBeNull();
    expect(people[0].affiliation_source).toBe("employer_mismatch");
  });

  it("detaches someone the evidence says has left", async () => {
    seed({
      organization_id: "org-a",
      affiliation_source: "llm_verified",
      affiliation_confidence: AFFILIATION_WEIGHT.llm_verified,
    });

    await recordAffiliation(client(), {
      personId: "p1",
      organizationId: null,
      source: "former_employee",
      evidence: "profile shows Browserbase, Oct 2024 to Mar 2026",
    });

    expect(people[0].organization_id).toBeNull();
    expect(people[0].affiliation_source).toBe("former_employee");
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
      source: "employer_mismatch",
      evidence: "profile names another employer",
    });

    expect(people[0].affiliation_confidence).toBe(0);
  });

  it("does not detach someone the company itself lists", async () => {
    // A stale snapshot must not overrule the company's own team page.
    seed({
      organization_id: "org-a",
      affiliation_source: "team_page",
      affiliation_confidence: AFFILIATION_WEIGHT.team_page,
    });

    await recordAffiliation(client(), {
      personId: "p1",
      organizationId: null,
      source: "employer_mismatch",
      evidence: "profile names another employer",
    });

    expect(people[0].organization_id).toBe("org-a");
    expect(people[0].affiliation_source).toBe("team_page");
  });

  it("keeps a detached person from being re-filed by a weaker search", async () => {
    seed({
      organization_id: null,
      affiliation_source: "employer_mismatch",
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

Run: `pnpm vitest run src/__tests__/affiliation.test.ts -t "detaching sources"`
Expected: FAIL. `"employer_mismatch"` is not a member of `AffiliationSource`, so this will not compile until Step 3.

**Step 3: Implement**

Extend the union at `affiliation.ts:20`:

```typescript
export type AffiliationSource =
  | "user_entered"
  | "email_domain"
  | "team_page"
  | "linkedin_profile"
  | "llm_verified"
  | "search_stamp"
  | "former_employee"
  | "employer_mismatch";
```

Add to `AFFILIATION_WEIGHT`, after `linkedin_profile` (line 41):

```typescript
  /**
   * Their profile shows a dated stint at this company that has already ended.
   * Same strength as linkedin_profile because it is the same evidence read the
   * same way: strong enough to displace a search stamp or an LLM guess, never
   * strong enough to overrule the company's own team page or a human.
   */
  former_employee: 0.8,
  /** Their profile names a DIFFERENT employer and never mentions this one. */
  employer_mismatch: 0.8,
```

Change the update at line 128 so a detached write scores zero:

```typescript
// Confidence is "how sure are we they work at organization_id". Detached,
// there is no such claim to be confident about, and a non-zero score on a
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

**Step 4: Run to verify pass**

Run: `pnpm vitest run src/__tests__/affiliation.test.ts && pnpm typecheck`
Expected: PASS. Watch for a `switch` or `Record<AffiliationSource, ...>` elsewhere that the two new members make non-exhaustive; typecheck will name it.

**Step 5: Teach the badge the new sources**

`src/components/ui/provenance-badge.tsx:147` maps sources to labels. A source it does not recognise falls through to the raw string, which reads as noise. Add both:

```typescript
  former_employee: "their profile shows they have left this company",
  employer_mismatch: "their profile names a different employer",
```

**Step 6: Commit**

```bash
git add src/lib/services/affiliation.ts src/__tests__/affiliation.test.ts src/components/ui/provenance-badge.tsx
git commit -m "feat(affiliation): former_employee and employer_mismatch detach weak stamps"
```

---

## Task 3: The judge reads the page, not just the headline

The core change. Everything before this was scaffolding.

**Files:**

- Modify: `src/lib/services/contact-filter.ts:27-53` (types), `:291-439` (`filterContactsByCompany`)
- Test: `src/__tests__/contact-filter.test.ts`

### Design notes

The judge currently receives one line per candidate. It will now receive the scraped page text (truncated to 1800 characters, which is where probe 1 measured full experience sections fitting) and the page's published date.

`rejected` becomes reachable for a reason it never was: a full experience listing that names other companies and never names the target is _positive evidence of absence_, not missing evidence. That single sentence in the prompt is what moved Bianca, Chris Sev, Carter Rabasa, Ejaz Merchant, Pratik Sapra and Braxton Lancial out of `uncertain` in probe 2.

`uncertain` must stay reachable and must stay the default when the page text is empty. Do not weaken it into a rejection: the original hard headline filter deleted 22 of 41 genuine contacts, and that failure is worse than the one being fixed.

**Step 1: Write the failing tests**

Add to `src/__tests__/contact-filter.test.ts`. The existing `candidates` fixture stays; add a second fixture carrying evidence.

```typescript
const withEvidence: CandidateContact[] = [
  {
    name: "Dana D",
    title: null,
    linkedinUrl: "https://www.linkedin.com/in/d",
    rawHeadline: "Dana D - Head of DevRel | Founder devreluni.com",
    pageText:
      "Experience: Head of Developer Relations, Chronicle Labs, May 2024 - Present. Founder, DevRel Uni, Feb 2023 - Present.",
    pageDate: "2026-07-23",
  },
];

describe("evidence in the prompt", () => {
  it("puts the page text and its date in front of the model", async () => {
    reply([
      {
        index: 0,
        name: "Dana D",
        title: null,
        verdict: "rejected",
        evidence: "x",
      },
    ]);

    await filterContactsByCompany(company, withEvidence);

    const prompt = generateObjectMock.mock.calls[0][0].prompt as string;
    expect(prompt).toContain("Chronicle Labs");
    expect(prompt).toContain("2026-07-23");
  });

  it("says the page text is missing rather than omitting the line", async () => {
    // A silently absent field reads to the model as "not applicable". An
    // explicit "(none)" is what makes `uncertain` the honest answer.
    reply([
      {
        index: 0,
        name: "Ann A",
        title: null,
        verdict: "uncertain",
        evidence: "x",
      },
    ]);

    await filterContactsByCompany(company, candidates);

    const prompt = generateObjectMock.mock.calls[0][0].prompt as string;
    expect(prompt).toContain("(none)");
  });
});

describe("former_employee", () => {
  it("passes the verdict through", async () => {
    reply([
      {
        index: 0,
        name: "Dana D",
        title: "Engineer",
        verdict: "former_employee",
        employerSeen: "Browserbase",
        datesSeen: "Oct 2024 - Mar 2026",
        evidence: "profile shows the role ended in Mar 2026",
      },
    ]);

    const out = await filterContactsByCompany(company, withEvidence);

    expect(out[0].verdict).toBe("former_employee");
    expect(out[0].employerSeen).toBe("Browserbase");
    expect(out[0].datesSeen).toBe("Oct 2024 - Mar 2026");
  });
});

describe("stale snapshots", () => {
  it("downgrades a verified call made on an old page", async () => {
    // The Victor Lue case. His archived page was dated 2026-03-29 and said
    // "Browserbase, Present" while his live headline said Anthropic. A
    // four-month-old snapshot saying "Present" only proves where they worked
    // four months ago, so it cannot clear the send gate on its own.
    reply([
      {
        index: 0,
        name: "Dana D",
        title: null,
        verdict: "verified",
        evidence: "says Present",
      },
    ]);

    const out = await filterContactsByCompany(company, [
      { ...withEvidence[0], pageDate: "2026-01-01" },
    ]);

    expect(out[0].verdict).toBe("uncertain");
    expect(out[0].evidence).toMatch(/months old/i);
  });

  it("leaves a verified call on a fresh page alone", async () => {
    reply([
      {
        index: 0,
        name: "Dana D",
        title: null,
        verdict: "verified",
        evidence: "says Present",
      },
    ]);

    const out = await filterContactsByCompany(company, [
      { ...withEvidence[0], pageDate: new Date().toISOString().slice(0, 10) },
    ]);

    expect(out[0].verdict).toBe("verified");
  });

  it("does not downgrade a rejection just because the page is old", async () => {
    // Staleness cuts one way. "They worked somewhere else in January" is still
    // evidence they were not here in January, and re-running the search will
    // not produce a fresher page.
    reply([
      {
        index: 0,
        name: "Dana D",
        title: null,
        verdict: "rejected",
        evidence: "Chronicle Labs",
      },
    ]);

    const out = await filterContactsByCompany(company, [
      { ...withEvidence[0], pageDate: "2026-01-01" },
    ]);

    expect(out[0].verdict).toBe("rejected");
  });
});
```

**Step 2: Run and watch it fail**

Run: `pnpm vitest run src/__tests__/contact-filter.test.ts`
Expected: FAIL to compile. `pageText` is not on `CandidateContact` and `former_employee` is not in `ContactVerdict`.

**Step 3: Extend the types**

In `contact-filter.ts`, replace the `CandidateContact`, `ContactVerdict` and `VerifiedContact` declarations (lines 27-53):

```typescript
export interface CandidateContact {
  name: string;
  title: string | null;
  linkedinUrl: string | null;
  rawHeadline: string | null;
  /**
   * Text scraped from the result page. Exa returns this on every people search
   * we already run (measured: 39 of 39 candidates on Browserbase), and it
   * usually carries a dated experience section. Judging without it is why every
   * candidate at a company whose staff do not name their employer in their
   * headline came back `uncertain`.
   */
  pageText?: string | null;
  /** When the scraped page was published. Null when the source is undated. */
  pageDate?: string | null;
}

/**
 * Four outcomes, not three.
 *
 * The binary version forced every candidate into "employee" or "not", and the
 * honest answer for a large share of them is "the evidence does not say". On
 * the dev database, 19 of 41 contacts at one company had a headline that never
 * mentions their employer, so a filter that must choose either keeps
 * provably-wrong people or deletes real ones.
 *
 * `former_employee` is separate from `rejected` because the two mean different
 * things to a salesperson and to the org chart: one is a person who really did
 * work here and left, the other was never here at all. Both detach.
 */
export type ContactVerdict =
  | "verified"
  | "former_employee"
  | "uncertain"
  | "rejected";

export interface VerifiedContact {
  index: number;
  name: string;
  title: string | null;
  verdict: ContactVerdict;
  /** One line explaining the call, stored as affiliation_evidence. */
  evidence: string;
  /** The employer the evidence actually named, so a human can audit the call. */
  employerSeen?: string | null;
  /** The date range the evidence gave for that employer, when it gave one. */
  datesSeen?: string | null;
}

/**
 * How old a scraped page may be and still support a `verified` call.
 *
 * A snapshot saying "Present" only proves where someone worked on the day it
 * was taken. Measured on Browserbase, 38 of 39 pages were within three weeks
 * and the one outlier at four months was the single wrong `verified` in the
 * batch, so this threshold costs almost nothing and catches exactly the case
 * it is aimed at.
 */
export const STALE_PROFILE_DAYS = 120;
```

**Step 4: Build the evidence block and the new prompt**

Replace the `summaries` construction at `contact-filter.ts:309-317`:

```typescript
const summaries = indexed
  .map((c, i) => {
    const text = (c.pageText ?? "").replace(/\s+/g, " ").slice(0, 1800);
    return [
      `[${i}] headline: ${c.rawHeadline || c.name}${c.title ? ` (parsed role: ${c.title})` : ""}`,
      `    headline names the target company: ${
        headlineMentionsCompany(c.rawHeadline, company.name) ? "yes" : "no"
      }`,
      `    page dated: ${c.pageDate ?? "unknown"}`,
      `    page text: ${text || "(none)"}`,
    ].join("\n");
  })
  .join("\n\n");
```

Extend the schema at `:323-347` with the two audit fields and the new verdict:

```typescript
            verdict: z
              .enum(["verified", "former_employee", "uncertain", "rejected"])
              .describe(
                "verified = evidence says they work there now; former_employee = they worked there and the role has an end date; rejected = evidence places them at a different company; uncertain = the evidence does not settle it",
              ),
            employerSeen: z
              .string()
              .nullable()
              .describe("The employer the evidence actually names, if any"),
            datesSeen: z
              .string()
              .nullable()
              .describe(
                "The date range the evidence gives for that employer, e.g. 'May 2024 - Present'",
              ),
```

Replace the verdict instructions in the prompt (`:361-367`) with:

```
Today's date: ${new Date().toISOString().slice(0, 10)}

Each candidate gives you a headline plus whatever text was scraped from their profile page. The text usually contains a dated experience section. Read it: the headline is the weakest evidence available and often names no employer at all.

Return a verdict for EVERY candidate. Use exactly four verdicts:

- "verified": the evidence places them at the target company with no end date, or an explicit Present or Current.
- "former_employee": the evidence places them at the target company with an END DATE in the past, or the text says prev or ex. They really did work there, and they do not now.
- "rejected": the evidence positively places them at a DIFFERENT employer and never mentions the target company. A full experience listing that names other companies and never names the target is positive evidence of absence, not missing evidence. Similarly-named but different companies belong here ("Dixons Carphone" is NOT "Dixons Estate Agents"). Use the domain and industry to disambiguate.
- "uncertain": the evidence does not settle it. Use this when the page text is "(none)" or is only a headline naming no employer. Do not reach for "rejected" on thin evidence: at small companies most people never mention their employer anywhere we can see.

When the page shows several roles, prefer the most recent. If the headline names one employer and a dated block names another, the one marked Present or Current wins.

Do not guess in order to avoid "uncertain". An honest "uncertain" is more useful than a confident mistake in either direction: uncertain contacts are kept and queued for human review, while rejected ones are detached from the company.

Also report which employer you actually saw and what dates, so a human can audit the call, and clean up the display fields:
- names: remove LinkedIn suffixes, emoji, excessive credentials
- titles: extract just the role ("Branch Manager", not "Branch Manager at Dixons")
```

Carry the two new fields through the result mapping at `:396-407`:

```typescript
judged.push({
  index: original.originalIndex,
  name: v.name,
  title: v.title,
  verdict: v.verdict,
  evidence: v.evidence,
  employerSeen: v.employerSeen ?? null,
  datesSeen: v.datesSeen ?? null,
});
```

Update the `trackUsage` metadata to count the new verdict, and leave the two fallback paths (omitted candidates at `:410-420`, LLM failure at `:423-438`) returning `uncertain` exactly as they do now.

**Step 5: Add the staleness guard**

A deterministic post-pass, not a prompt rule, so it is testable without the model. Add above `filterContactsByCompany`:

```typescript
/** Milliseconds in the staleness window, computed once. */
const STALE_PROFILE_MS = STALE_PROFILE_DAYS * 24 * 60 * 60 * 1000;

/**
 * A `verified` call resting on an old snapshot is downgraded to `uncertain`.
 *
 * Only `verified` is affected. "They worked somewhere else in January" is still
 * evidence they were not here in January, and re-running the search will not
 * produce a fresher page, so downgrading a rejection would just re-admit the
 * stranger it correctly excluded.
 */
function downgradeStale(
  verdict: VerifiedContact,
  pageDate: string | null | undefined,
  now: number,
): VerifiedContact {
  if (verdict.verdict !== "verified" || !pageDate) return verdict;
  const t = Date.parse(pageDate);
  if (Number.isNaN(t)) return verdict;
  const age = now - t;
  if (age <= STALE_PROFILE_MS) return verdict;

  const months = Math.round(age / (30 * 24 * 60 * 60 * 1000));
  return {
    ...verdict,
    verdict: "uncertain",
    evidence: `${verdict.evidence} (evidence is ${months} months old, so it does not prove they are still there)`,
  };
}
```

Apply it to both the judged list and the omitted-candidate fallback, immediately before `return judged`:

```typescript
const now = Date.now();
return judged.map((v) => downgradeStale(v, indexed[v.index]?.pageDate, now));
```

> Careful: `judged[].index` is the _caller's_ index (`originalIndex`), which for a single call equals the position in `indexed`. If you ever reorder `indexed`, look the candidate up by `originalIndex` rather than by array position.

**Step 6: Run to verify pass**

Run: `pnpm vitest run src/__tests__/contact-filter.test.ts && pnpm typecheck`
Expected: PASS, including the three pre-existing failure-path tests (hallucinated indices, omitted candidates, LLM unavailable), and a clean typecheck.

> Widening `ContactVerdict` does not break the `===` comparisons in `contact-discovery.ts` and `enrichment-tools.ts`, so nothing fails to compile. What it does create is a transient behaviour gap inside the branch: between this commit and Task 4, a `former_employee` verdict falls through those comparisons and is treated as `uncertain`, so the person stays attached at `search_stamp`. That is wrong but not worse than today, and Task 4 closes it. Do not try to patch the callers here; that is Task 4's job and doing it twice is how the two judge-and-store paths drifted apart before.

**Step 7: Commit**

```bash
git add src/lib/services/contact-filter.ts src/__tests__/contact-filter.test.ts
git commit -m "feat(contact-filter): judge affiliation on profile text and dates"
```

---

## Task 4: Wire discovery to the evidence and act on the verdicts

**Files:**

- Modify: `src/lib/services/contact-discovery.ts:66-94` (result type), `:123-136` (`empty`), `:343-356` (candidate build), `:360-417` (verdict handling)
- Test: `src/__tests__/contact-discovery.test.ts`

**Step 1: Write the failing tests**

Add to `src/__tests__/contact-discovery.test.ts`. The `exaResults` mock currently types results as `{ url, title }`; widen it to `{ url: string; title: string; text?: string | null; publishedDate?: string | null }`.

```typescript
describe("evidence handed to the judge", () => {
  it("passes the page text and date Exa returned", async () => {
    // includeText is already set on the search, so this text is paid for
    // whether or not we read it. Dropping it is why every candidate at a
    // company whose staff do not name their employer came back uncertain.
    exaResults.results = [
      {
        url: "https://www.linkedin.com/in/a",
        title: "Ann A - Engineer",
        text: "Experience: Software Engineer, Browserbase, May 2025 - Present",
        publishedDate: "2026-07-23",
      },
    ];

    await run();

    const candidates = judged.mock.calls[0][1] as Array<{
      pageText: string | null;
      pageDate: string | null;
    }>;
    expect(candidates[0].pageText).toContain("May 2025 - Present");
    expect(candidates[0].pageDate).toBe("2026-07-23");
  });
});

describe("acting on the verdicts", () => {
  const oneCandidate = () => {
    exaResults.results = [
      { url: "https://www.linkedin.com/in/a", title: "Ann A - Engineer" },
    ];
  };

  it("detaches someone the evidence says has left", async () => {
    oneCandidate();
    judged.mockResolvedValue([
      {
        index: 0,
        name: "Ann A",
        title: "Engineer",
        verdict: "former_employee",
        employerSeen: "Browserbase",
        datesSeen: "Oct 2024 - Mar 2026",
        evidence: "role ended Mar 2026",
      },
    ]);

    const result = await run();

    const last = affiliations[affiliations.length - 1];
    expect(last.source).toBe("former_employee");
    expect(last.organizationId).toBeNull();
    expect(result.departedCount).toBe(1);
    // Reporting them as a contact at this company one line after detaching
    // them is how a caller ends up drafting for someone who left.
    expect(result.contacts).toHaveLength(0);
  });

  it("detaches someone the evidence places elsewhere", async () => {
    oneCandidate();
    judged.mockResolvedValue([
      {
        index: 0,
        name: "Ann A",
        title: "Engineer",
        verdict: "rejected",
        employerSeen: "Chronicle Labs",
        datesSeen: "May 2024 - Present",
        evidence: "profile names Chronicle Labs",
      },
    ]);

    const result = await run();

    const last = affiliations[affiliations.length - 1];
    expect(last.source).toBe("employer_mismatch");
    expect(last.organizationId).toBeNull();
    expect(last.evidence).toContain("Chronicle Labs");
    expect(result.rejectedAsWrongCompany).toBe(1);
  });

  it("still keeps uncertain people attached and flagged", async () => {
    // The whole point of `uncertain` is that we keep them. This must not
    // regress into the old hard filter that deleted real employees.
    oneCandidate();
    judged.mockResolvedValue([
      {
        index: 0,
        name: "Ann A",
        title: "Engineer",
        verdict: "uncertain",
        evidence: "page text unavailable",
      },
    ]);

    const result = await run();

    expect(result.contacts).toHaveLength(1);
    expect(result.uncertainCount).toBe(1);
    expect(affiliations[affiliations.length - 1].source).toBe("search_stamp");
  });
});
```

**Step 2: Run and watch it fail**

Run: `pnpm vitest run src/__tests__/contact-discovery.test.ts -t "evidence handed"`
Expected: FAIL. `pageText` is undefined on the candidate; `departedCount` is undefined.

**Step 3: Pass the evidence through**

In the candidate push at `contact-discovery.ts:343`:

```typescript
candidates.push({
  name: parsed.name,
  // Only a title we actually read off this person's headline. This used
  // to fall back to `search.title`, the title we *queried* for, which
  // stamped the ICP target title onto anyone whose headline did not
  // parse. The result was a 15-person startup showing three Heads of
  // Growth and four Revenue Operations.
  title: parsed.title,
  linkedinUrl,
  rawHeadline: result.title,
  pageText: result.text ?? null,
  pageDate: result.publishedDate ?? null,
  searchTitle: search.title,
});
```

**Step 4: Map the four verdicts onto affiliation**

Replace the body of the judged loop (`:361-416`). The shape changes from "rejected or not" to a per-verdict decision:

```typescript
if (candidates.length > 0) {
  for (const judged of await filterContactsByCompany(company, candidates)) {
    const candidate = candidates[judged.index];
    if (!candidate) continue;

    const detaching =
      judged.verdict === "rejected" || judged.verdict === "former_employee";

    // A detached candidate is a real person who works somewhere else, or
    // used to work here. Keep them, unattached, rather than pretending they
    // are an employee, but only when we can actually identify them.
    // findOrCreatePerson dedups by LinkedIn URL, or by name within an
    // organization; a detached candidate has no organization, so one with no
    // profile URL matches neither path and would be INSERTED fresh on every
    // run, leaving the mis-filed original untouched and adding an orphan
    // each time.
    if (detaching && !candidate.linkedinUrl) {
      if (judged.verdict === "rejected") rejectedAsWrongCompany++;
      else departedCount++;
      continue;
    }

    const attachTo = detaching ? null : organizationId;
    const source: AffiliationSource =
      judged.verdict === "verified"
        ? "llm_verified"
        : judged.verdict === "former_employee"
          ? "former_employee"
          : judged.verdict === "rejected"
            ? "employer_mismatch"
            : "search_stamp";

    // Fold what the judge saw into the stored evidence. Without it the row
    // says "profile names a different employer" and the user has to go and
    // look up which one.
    const evidence = judged.employerSeen
      ? `${judged.evidence} (saw: ${judged.employerSeen}${judged.datesSeen ? `, ${judged.datesSeen}` : ""})`
      : judged.evidence;

    const person = await findOrCreatePerson({
      name: judged.name,
      title: judged.title,
      linkedin_url: candidate.linkedinUrl,
      organization_id: attachTo,
      source: "exa",
    });

    await recordAffiliation(supabase, {
      personId: person.id,
      organizationId: attachTo,
      source,
      evidence,
    });

    if (judged.verdict === "rejected") {
      rejectedAsWrongCompany++;
      continue;
    }
    if (judged.verdict === "former_employee") {
      departedCount++;
      continue;
    }
    if (judged.verdict === "verified") verifiedCount++;
    else uncertainCount++;

    if (campaignId) await linkPersonToCampaign(person.id, campaignId);

    contacts.push({
      id: person.id,
      name: person.name,
      title: person.title,
      work_email: person.work_email,
      personal_email: person.personal_email,
      linkedinUrl: person.linkedin_url,
      source: "exa",
      affiliation: source,
      affiliationEvidence: evidence,
    });
  }
}
```

Declare `let departedCount = 0;` alongside the other counters.

**Step 5: Extend the result type**

In `ContactDiscoveryResult` (line 66), after `rejectedAsWrongCompany`:

```typescript
/** Worked here once, and the evidence shows the role has ended. Detached. */
departedCount: number;
```

Add it to the returned object **and** to the `empty()` helper at line 123. Missing it there is a type error and a lie in the error path.

**Step 6: Run to verify pass**

Run: `pnpm vitest run src/__tests__/contact-discovery.test.ts && pnpm typecheck`
Expected: PASS, including the existing `alreadyLinked`, domain-gate and title tests.

**Step 7: Surface the count to the agent**

In `src/lib/tools/enrichment-tools.ts`, in the `findContacts` return (line 1479):

```typescript
      departedCount: result.departedCount,
```

Then update `src/lib/system-prompt.ts:121`, which currently documents three counters, to describe four. Departed means the evidence showed a dated stint that has ended, so they were detached. Keep the existing wording for the other three.

**Step 8: Commit**

```bash
git add src/lib/services/contact-discovery.ts src/__tests__/contact-discovery.test.ts src/lib/tools/enrichment-tools.ts src/lib/system-prompt.ts
git commit -m "feat(contact-discovery): act on evidence-based verdicts"
```

---

## Task 5: The same wiring for searchPeople

`searchPeople` is the other judge-and-store path, and it is the one that actually pulled in the Browserbase noise. It already captures `result.text` at `enrichment-tools.ts:201` and then drops it before judging at `:223-228`.

**Files:**

- Modify: `src/lib/tools/enrichment-tools.ts:196-203` (candidate build), `:214-236` (judge call), `:248-311` (verdict handling), `:313-333` (return)
- Test: `src/__tests__/search-people-verdicts.test.ts` (create)

**Step 1: Write the failing test**

There is no test for `searchPeople` today. Create a focused one that mocks the Exa service, the judge and `findOrCreatePerson`, and asserts on what `recordAffiliation` was called with. Mirror the mock setup in `src/__tests__/contact-discovery.test.ts:15-60` rather than inventing a new style.

```typescript
it("hands the judge the text Exa returned", async () => {
  // Captured at line 201 today and then dropped before the judge sees it.
  // ...assert candidates[0].pageText is populated
});

it("detaches a candidate judged former_employee", async () => {
  // ...assert recordAffiliation got { organizationId: null, source: "former_employee" }
});
```

> If mocking the tool's module graph proves heavy, extract the candidate-to-verdict block into an exported helper in `contact-discovery.ts` and test that instead. Do not skip the test: this is the path that produced the bug.

**Step 2: Run and watch it fail**

Run: `pnpm vitest run src/__tests__/search-people-verdicts.test.ts`

**Step 3: Implement**

Pass the evidence through at `:223-228`:

```typescript
          candidates.map((c) => ({
            name: c.name,
            title: c.title,
            linkedinUrl: c.linkedin_url,
            rawHeadline: c.rawTitle,
            pageText: c.text,
            pageDate: c.publishedDate,
          })),
```

`SearchCandidate` (line 162) needs a `publishedDate: string | null` field, set from `result.publishedDate` in the loop at `:196`.

Then mirror Task 4's verdict mapping in the storage loop at `:248-311`: `detaching` covers `rejected` and `former_employee`, `attachTo` is null for both, the source is `employer_mismatch` or `former_employee` respectively, and both are counted separately in the return. Add `departedCount` to the returned object and to the `note` string so the agent can say what happened.

**Step 4: Run to verify pass**

Run: `pnpm vitest run && pnpm typecheck`

**Step 5: Commit**

```bash
git add src/lib/tools/enrichment-tools.ts src/__tests__/search-people-verdicts.test.ts
git commit -m "feat(searchPeople): judge on profile text and detach departed people"
```

---

## Task 6: Stop buying emails for people we cannot email

`enrichContactById` runs email discovery whenever a contact has no address (`enrichment-tools.ts:631-640`), with no affiliation check. That is how six people who never worked at Browserbase acquired plausible `@browserbase.com` addresses, which then read to the user as confirmation.

**Files:**

- Modify: `src/lib/tools/enrichment-tools.ts:625-640`
- Test: `src/__tests__/enrich-contact-summary.test.ts`

**Step 1: Write the failing test**

```typescript
it("does not look for an email for an unconfirmed contact", async () => {
  // A pattern-guessed address at the company domain is the single most
  // convincing thing on the row. Minting one for a person we cannot place at
  // the company manufactures the confirmation the user is looking for.
});
```

**Step 2: Run and watch it fail**

**Step 3: Implement.** Widen the post-enrichment select at `:625` to include `affiliation_confidence`, and gate the discovery block:

```typescript
  // Email discovery costs a provider credit and, more importantly, produces a
  // company-domain address that reads as proof of employment. Neither is
  // justified for someone below the send threshold: they are blocked from
  // outreach anyway, so the address could not be used even if it were right.
  const confirmed =
    (personAfter?.affiliation_confidence ?? 0) >= AFFILIATION_SEND_THRESHOLD;

  if (confirmed && !personAfter?.work_email && !personAfter?.personal_email) {
```

Import `AFFILIATION_SEND_THRESHOLD` from `@/lib/services/affiliation`.

**Step 4: Run, typecheck, commit**

```bash
git commit -m "fix(enrich): stop guessing emails for unconfirmed contacts"
```

---

## Task 7: Keep dates through person enrichment

The Victor Lue summary bug. `summarizePerson` receives `Array<{title, url, text}>` (`enrichment-tools.ts:595-603`) because `SearchResultLike` (`enrichment-summarizer.ts:20-24`) has no date field, so `formatResults` (`:131-136`) emits undated blobs. His material contained a March snapshot and a July one plus a live headline saying Anthropic; with nothing to order them by, the model picked Browserbase, called Anthropic "previous", and wrote that title back to `people.title` at `:611-617`.

**Files:**

- Modify: `src/lib/services/enrichment-summarizer.ts:20-24`, `:81-92`, `:131-143`, `:150-176`
- Modify: `src/lib/tools/enrichment-tools.ts:595-617`, `src/app/api/enrich/route.ts` (same call if it summarises)
- Test: `src/__tests__/enrich-contact-summary.test.ts`

**Step 1: Write the failing tests**

```typescript
it("puts each source's date in the prompt", async () => {
  // ...assert the prompt contains the publishedDate of a news item
});

it("does not overwrite the stored title when sources conflict", async () => {
  // Live headline says one employer, archived text says another. Picking one
  // silently is how enrichment overwrote a correct title with a stale one.
  // ...assert the people.update call carries bio_summary but no title
});
```

**Step 2: Run and watch it fail**

**Step 3: Implement**

- Add `publishedDate?: string | null` to `SearchResultLike`.
- In `formatResults`, prefix each block with its date: `` `${r.title} (${r.publishedDate ?? "undated"})` ``.
- Label the live LinkedIn headline in the prompt as scraped today, and add: the freshest source wins; an archived page saying "Present" only proves where they worked on the day it was taken.
- Add `sourcesConflict: z.boolean()` to the schema, described as "true when the freshest source names a different employer than an older one".
- In `enrichment-tools.ts`, stop dropping `publishedDate` when building the arrays, and skip the `title` write when `sourcesConflict` is true, keeping `bio_summary`.

Probe 3 confirmed this shape works: given both sources with dates, Haiku returned `rejected` and `conflict=true` for Victor Lue and `verified` / `conflict=false` for Lindsay Gilson.

**Step 4: Run, typecheck, commit**

```bash
git commit -m "fix(enrich): date every source and stop overwriting titles on conflict"
```

---

## Task 8: The review queue

The reason none of this was visible: `companies-list.tsx` renders no provenance at all, so a 0.2 stranger and a confirmed employee look identical. `AffiliationBadge` already exists (`provenance-badge.tsx:156`) and is already used by two other tables (`campaign/contacts-table.tsx:186`, `outreach/review/page.tsx:903`).

**Files:**

- Modify: `src/components/campaign/companies-list.tsx:658-790` (`ContactsTable`)

**Step 1: Confirm the data is already loaded**

Run: `grep -n "affiliation" src/app/campaigns/\[id\]/page.tsx src/lib/types/campaign.ts`

`affiliation_source`, `affiliation_confidence` and `affiliation_evidence` are already on every `CampaignContact` (`campaign.ts:262-264`). No query changes needed.

**Step 2: Split the table**

Partition `contacts` on `(affiliation_confidence ?? 0) >= 0.6` and render two groups with a small header row each: "Confirmed (n)" and "Needs review (n)". Keep one table, not two components: the columns, the expand behaviour and the email editor are all shared, and duplicating them is how the two contact tables in this codebase drifted apart in the first place.

Render `<AffiliationBadge person={contact} />` in the Name cell beside the LinkedIn link (around line 755). The badge returns null above the threshold, so the confirmed group stays visually quiet.

**Step 3: Add the two actions**

On rows in the needs-review group, add "Confirm" and "Not here" buttons calling the endpoints that already exist:

- Confirm: `POST /api/people/[id]/to-company` with `{ organizationId, campaignId }`. Writes `user_entered` at 1.0, which outranks everything and is permanent.
- Not here: `DELETE /api/people/[id]/from-company?campaignId=...`.

Copy the `apiFetch` call shape from `src/components/company/add-person-dialog.tsx:80`. Optimistically update the row, and roll back on failure the way the existing `onEmailEdit` handler does.

**Step 4: Verify by eye**

Run: `pnpm dev`, open a campaign with unproven contacts.

> Note: local Supabase (`127.0.0.1:54321`) does not have the Browserbase data; that lives in the deployed instance. Either seed a low-confidence row locally or check this on the deployed app after Task 9.

**Step 5: Commit**

```bash
git commit -m "feat(ui): split company contacts into confirmed and needs review"
```

---

## Task 9: Verify against the real case, and keep the probe

**Step 1: Save the probe as a re-runnable check**

The three probe scripts are in the session scratchpad. Save the first one as `scripts/probe-affiliation.ts`, parameterised on company name and titles, and add `"probe:affiliation": "tsx scripts/probe-affiliation.ts"` to `package.json` scripts next to `audit:data`. It is read-only, it writes nothing, and it is the only way to see whether the judge is over-rejecting at scale.

**Step 2: Re-run it against Browserbase**

Run: `pnpm probe:affiliation Browserbase`

Expected, from the 2026-08-01 baseline: roughly 33 verified, 3 former_employee, 1 rejected, 3 uncertain out of 39. A run that returns mostly `uncertain` means the page text is not reaching the prompt. A run that returns mostly `rejected` means the prompt has tipped over into the old hard-filter failure and real employees are being deleted; stop and re-read the `uncertain` instruction before shipping.

**Step 3: Confirm the flagged people are now detached**

Trigger "Find more people" on Browserbase in the deployed app, then against the deployed database:

```sql
select p.name, p.affiliation_source, p.affiliation_confidence,
       p.affiliation_evidence, o.name as org
from people p left join organizations o on o.id = p.organization_id
where p.name in ('Bianca Andreea Buzea','Chris Sev','Carter Rabasa',
                 'Ejaz Merchant','Pratik Sapra','Braxton Lancial');
```

Expected: `employer_mismatch`, confidence 0, `org` null, and the evidence naming Chronicle Labs / Okta / Box / Hashgraph / Amazon / Stash respectively.

**Step 4: Confirm nobody real was lost**

```sql
select affiliation_source, count(*) from people
where organization_id is null group by 1;
```

`employer_mismatch` and `former_employee` should both be small. If either is large, the judge is over-rejecting; the most likely cause is a company whose profile text names it differently from our stored name (a rebrand, or "Acme (YC W24)").

**Step 5: Open the PR**

Title: `feat(affiliation): judge employment from profile evidence, not headlines`. Body: link this plan, quote the 39-of-39 baseline, and note the added Haiku input cost of roughly $0.012 per discovery call.

---

## Out of scope, deliberately

- **Backfilling the 55 contacts already stored at 0.2.** Re-running discovery only re-judges people the search returns again, so anyone already in the list who does not come back stays where they are. The review queue from Task 8 is what makes them visible and confirmable by hand, which is the human loop this is aiming at anyway. A bulk re-judge job is a follow-up once the mismatch rate from Task 9 Step 4 is known to be sane.
- **Fixing the namesake bug in person enrichment.** `/api/enrich/route.ts:157-160` pins the org name into the Exa query with no check that a result is about the person _at_ that company. Probe 2 hit this live: searching "Alexander Phan" by name returned a different Alexander Phan at Edwards Lifesciences. It wants its own plan, though this one shrinks the blast radius since detached people stop being enriched as employees.
- **Switching the Exa search to `keyword`.** Making `contact-discovery.ts:275` literal would stop topically-similar profiles being retrieved at all, but it also loses the semantic recall the whole discovery flow depends on. Worth measuring separately with the Task 9 probe, not bundling here.
- **A LinkedIn profile actor that returns positions.** `LinkedinService.scrapeProfile` runs a _posts_ actor and reconstructs `{username, name, headline}` from post metadata (`linkedin-service.ts:145-152`), so there is no structured employment history anywhere in the system. Swapping actors would give real job timestamps instead of ones inferred from page text. Probe 1 showed the inferred ones resolve 36 of 39, so this is an upgrade, not a prerequisite.
