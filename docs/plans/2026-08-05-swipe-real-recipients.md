# Swipe Deck Real Recipients Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Voice-swipe drafts are written to real contacts from the campaign instead of invented personas, with the invented-persona path kept as a silent fallback.

**Architecture:** The server (not the model) picks one real contact per batch from `campaign_people`, rotating so nobody repeats until everyone has been drafted to. The contact's real context replaces the "invent the recipient" prompt block with a facts-only rule; the server stamps the card label so the model can never misname anyone. No campaign, no contacts, or a load failure all degrade to today's invented-persona behavior. Kept drafts remain training-only.

**Tech Stack:** Next.js, Supabase (RLS-scoped client), Vercel AI SDK `generateObject` via `apiSafeSchema`, Vitest.

**Design doc:** `/Users/jay/.claude/plans/2026-08-05-swipe-real-recipients-design.md`

**Prerequisite:** Branch from `main` only after PR #71 (`fix/swipe-run-reliability`) is merged — this plan builds on its `generateWithRetry` version of `swipe-service.ts`.

---

### Task 1: Recipient picking and fact extraction (pure logic)

**Files:**

- Create: `src/lib/email-skills/swipe-recipient.ts`
- Test: `src/__tests__/swipe-recipient.test.ts`

**Step 1: Write the failing tests**

```ts
import { describe, expect, it } from "vitest";

import {
  candidateFromRow,
  pickRecipient,
  recipientLabel,
  type RealRecipient,
} from "@/lib/email-skills/swipe-recipient";

function person(
  name: string,
  opts: Partial<RealRecipient> = {},
): RealRecipient {
  return {
    personId: name,
    name,
    title: "Head of Growth",
    company: "Kindra",
    headline: null,
    signals: [],
    enriched: false,
    ...opts,
  };
}

describe("recipientLabel", () => {
  it("matches the persona label shape", () => {
    expect(recipientLabel(person("Priya Raman"))).toBe(
      "Priya Raman · Head of Growth, Kindra",
    );
  });

  it("omits missing title and company", () => {
    expect(
      recipientLabel(person("Priya Raman", { title: null, company: null })),
    ).toBe("Priya Raman");
  });
});

describe("pickRecipient", () => {
  it("prefers enriched contacts", () => {
    const picked = pickRecipient(
      [person("A"), person("B", { enriched: true })],
      [],
    );
    expect(picked?.name).toBe("B");
  });

  it("skips contacts already judged, by label", () => {
    const a = person("A", { enriched: true });
    const b = person("B", { enriched: true });
    const picked = pickRecipient([a, b], [recipientLabel(a)]);
    expect(picked?.name).toBe("B");
  });

  it("wraps around when every contact has been drafted to", () => {
    const a = person("A", { enriched: true });
    const picked = pickRecipient([a], [recipientLabel(a)]);
    expect(picked?.name).toBe("A");
  });

  it("returns null for an empty candidate list", () => {
    expect(pickRecipient([], [])).toBeNull();
  });
});

describe("candidateFromRow", () => {
  it("maps an enriched row with signals from news and articles", () => {
    const row = {
      person: {
        id: "p1",
        name: "Priya Raman",
        title: "Head of Growth",
        enrichment_status: "enriched",
        enrichment_data: {
          linkedin: { profileInfo: { headline: "Growth at Kindra" } },
          news: [
            { title: "Kindra raises Series B", publishedDate: "2026-07-01" },
          ],
          articles: [{ title: "PLG teardown", publishedDate: null }],
        },
        organization: { name: "Kindra" },
      },
    };
    const c = candidateFromRow(row);
    expect(c).toMatchObject({
      personId: "p1",
      name: "Priya Raman",
      company: "Kindra",
      enriched: true,
      headline: "Growth at Kindra",
    });
    expect(c!.signals).toEqual([
      "Kindra raises Series B (2026-07-01)",
      "PLG teardown",
    ]);
  });

  it("returns null for a row with no person or no name", () => {
    expect(candidateFromRow({ person: null })).toBeNull();
    expect(candidateFromRow({ person: { id: "x", name: "" } })).toBeNull();
  });

  it("caps signals at 5 and signal length at 200 chars", () => {
    const news = Array.from({ length: 8 }, (_, i) => ({
      title: `t${i}`.padEnd(300, "x"),
      publishedDate: null,
    }));
    const c = candidateFromRow({
      person: {
        id: "p1",
        name: "A",
        title: null,
        enrichment_status: "pending",
        enrichment_data: { news },
        organization: null,
      },
    });
    expect(c!.signals.length).toBe(5);
    expect(c!.signals[0]!.length).toBeLessThanOrEqual(200);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run src/__tests__/swipe-recipient.test.ts`
Expected: FAIL (module not found).

**Step 3: Write the implementation**

```ts
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * A real campaign contact a batch can be written to. `signals` are compact
 * one-liners drawn from enrichment (news/articles/background titles with
 * dates); everything is bounded because enrichment is scraped content.
 */
export interface RealRecipient {
  personId: string;
  name: string;
  title: string | null;
  company: string | null;
  /** LinkedIn headline, when enrichment scraped one. */
  headline: string | null;
  signals: string[];
  enriched: boolean;
}

const MAX_SIGNALS = 5;
const MAX_SIGNAL_CHARS = 200;

/** Same joining rules as personaLabel, so transcript rotation keys match. */
export function recipientLabel(r: RealRecipient): string {
  const where = [r.title, r.company]
    .map((v) => v?.trim() ?? "")
    .filter(Boolean)
    .join(", ");
  return where ? `${r.name} · ${where}` : r.name;
}

/**
 * One contact per batch, enriched first, never repeating until every
 * candidate has been drafted to (then wrap around). Rotation state is the
 * judged transcript's persona labels, so it survives reloads for free.
 */
export function pickRecipient(
  candidates: RealRecipient[],
  judgedLabels: string[],
): RealRecipient | null {
  if (candidates.length === 0) return null;
  const seen = new Set(judgedLabels);
  const ordered = [...candidates].sort(
    (a, b) => Number(b.enriched) - Number(a.enriched),
  );
  return ordered.find((c) => !seen.has(recipientLabel(c))) ?? ordered[0]!;
}

interface SignalSource {
  title?: unknown;
  publishedDate?: unknown;
}

/** Maps one campaign_people row (with embedded person) to a candidate. */
export function candidateFromRow(row: {
  person?: {
    id?: unknown;
    name?: unknown;
    title?: unknown;
    enrichment_status?: unknown;
    enrichment_data?: unknown;
    organization?: { name?: unknown } | null;
  } | null;
}): RealRecipient | null {
  const p = row.person;
  if (!p?.id || typeof p.name !== "string" || !p.name.trim()) return null;

  const data = (p.enrichment_data ?? {}) as Record<string, unknown>;
  const linkedin = data.linkedin as
    | { profileInfo?: { headline?: unknown } | null }
    | undefined;
  const headline =
    typeof linkedin?.profileInfo?.headline === "string"
      ? linkedin.profileInfo.headline
      : null;

  const signals: string[] = [];
  for (const key of ["news", "articles", "background"] as const) {
    const items = data[key];
    if (!Array.isArray(items)) continue;
    for (const item of items as SignalSource[]) {
      if (signals.length >= MAX_SIGNALS) break;
      if (typeof item?.title !== "string" || !item.title.trim()) continue;
      const date =
        typeof item.publishedDate === "string" && item.publishedDate
          ? ` (${item.publishedDate})`
          : "";
      signals.push(`${item.title}${date}`.slice(0, MAX_SIGNAL_CHARS));
    }
  }

  return {
    personId: String(p.id),
    name: p.name.trim(),
    title: typeof p.title === "string" && p.title.trim() ? p.title : null,
    company:
      typeof p.organization?.name === "string" && p.organization.name.trim()
        ? p.organization.name
        : null,
    headline,
    signals,
    enriched: p.enrichment_status === "enriched",
  };
}

/**
 * All non-rejected contacts in the campaign. Any failure returns [] so the
 * caller falls back to invented personas; voice building never blocks here.
 */
export async function loadRecipientCandidates(
  supabase: SupabaseClient,
  campaignId: string,
): Promise<RealRecipient[]> {
  try {
    const { data, error } = await supabase
      .from("campaign_people")
      .select(
        // !organization_id disambiguates the second people->organizations FK,
        // same hint as PERSON_ENRICH_COLUMNS.
        "person:people(id, name, title, enrichment_status, enrichment_data, organization:organizations!organization_id(name))",
      )
      .eq("campaign_id", campaignId)
      .neq("status", "rejected")
      .limit(200);
    if (error || !data) return [];
    return data
      .map((row) =>
        candidateFromRow(row as Parameters<typeof candidateFromRow>[0]),
      )
      .filter((c): c is RealRecipient => c !== null);
  } catch {
    return [];
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/__tests__/swipe-recipient.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add src/lib/email-skills/swipe-recipient.ts src/__tests__/swipe-recipient.test.ts
git commit -m "feat(voice): recipient picking and fact extraction for real-contact drafts"
```

---

### Task 2: Prompt block and optional persona in the batch schema

**Files:**

- Modify: `src/lib/email-skills/swipe-prompts.ts`
- Test: `src/__tests__/swipe-real-recipient-prompts.test.ts`

**Step 1: Write the failing tests**

```ts
import { describe, expect, it } from "vitest";

import {
  BatchSchema,
  buildBatchSystem,
} from "@/lib/email-skills/swipe-prompts";
import type { RealRecipient } from "@/lib/email-skills/swipe-recipient";

const recipient: RealRecipient = {
  personId: "p1",
  name: "Priya Raman",
  title: "Head of Growth",
  company: "Kindra",
  headline: "Growth at Kindra",
  signals: ["Kindra raises Series B (2026-07-01)"],
  enriched: true,
};

describe("buildBatchSystem with a real recipient", () => {
  it("renders the real-recipient block instead of the invented one", () => {
    const system = buildBatchSystem(null, {}, recipient);
    expect(system).toContain("Priya Raman");
    expect(system).toContain("Kindra raises Series B");
    expect(system).toContain("REAL PERSON");
    expect(system).not.toContain("INVENT THE RECIPIENT");
  });

  it("keeps the invented block when no recipient is given", () => {
    const system = buildBatchSystem(null, {});
    expect(system).toContain("INVENT THE RECIPIENT");
  });

  it("emits the no-enrichment variant for unenriched contacts", () => {
    const system = buildBatchSystem(
      null,
      {},
      {
        ...recipient,
        headline: null,
        signals: [],
        enriched: false,
      },
    );
    expect(system).toContain("No enrichment is available");
  });
});

describe("BatchSchema persona optionality", () => {
  const draft = {
    subject: "s",
    body: "b",
    axes: {
      opener: "signal",
      tone: "warm",
      close: "question",
      greeting: "hi",
      signoff: "name",
    },
  };

  it("accepts a response without a persona (real-recipient mode)", () => {
    expect(BatchSchema.safeParse({ drafts: [draft, draft] }).success).toBe(
      true,
    );
  });

  it("still accepts a response with a persona (invented mode)", () => {
    const persona = {
      name: "A",
      title: "T",
      company: "C",
      situation: "S",
      signals: ["x"],
    };
    expect(
      BatchSchema.safeParse({ persona, drafts: [draft, draft] }).success,
    ).toBe(true);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run src/__tests__/swipe-real-recipient-prompts.test.ts`
Expected: FAIL (`buildBatchSystem` takes 2 args; persona required).

**Step 3: Implement**

In `src/lib/email-skills/swipe-prompts.ts`:

1. Import the recipient type: `import type { RealRecipient } from "@/lib/email-skills/swipe-recipient";` and reuse `field`/`wrapUntrusted`.

2. Make persona optional on the batch response:

```ts
export const BatchSchema = z.object({
  // Present only on the invented-persona path. With a real recipient the
  // server stamps the card label itself, so the model returns drafts only.
  persona: PersonaSchema.optional(),
  drafts: z.array(DraftSchema).min(2).max(8),
});
```

3. Add the real-recipient renderer next to `INVENT_RECIPIENT`:

```ts
/**
 * The flip side of INVENT_RECIPIENT: the person is real, so nothing about
 * them may be invented. Enrichment lines are scraped content and ride inside
 * the untrusted fence like the sender rows.
 */
function renderRealRecipient(r: RealRecipient): string {
  const rows = [
    field("Name", r.name),
    field("Title", r.title),
    field("Company", r.company),
    field("LinkedIn headline", r.headline),
    r.signals.length
      ? `Known signals:\n${r.signals.map((s) => `- ${s}`).join("\n")}`
      : null,
  ].filter(Boolean) as string[];

  const noEnrichment = !r.headline && r.signals.length === 0;

  return `WHO THESE ARE TO: A REAL PERSON in this campaign. Every draft in this batch is written to them. Only reference the facts listed below; if none of them makes a usable opener, write a signal-free opener instead. Never invent details, signals, or history about this person.${
    noEnrichment
      ? "\nNo enrichment is available for them: assume nothing beyond the title and company."
      : ""
  }
${wrapUntrusted(rows.join("\n"))}

THE SENDER IS REAL TOO. Never invent facts about the sender: everything the drafts claim about who is writing must come from the sender context above. Do not return a persona object; return the drafts only.`;
}
```

4. Thread the recipient through `buildBatchSystem`:

```ts
export function buildBatchSystem(
  campaign: SwipeCampaign | null,
  context: SwipeSenderContext = {},
  recipient: RealRecipient | null = null,
): string {
  return `${BATCH_SYSTEM}\n\n---\n${UNTRUSTED_NOTICE}\n\n${renderSender(
    context.sender,
  )}\n\n${recipient ? renderRealRecipient(recipient) : INVENT_RECIPIENT}\n\n${campaignBlock(campaign)}`;
}
```

5. In `BATCH_SYSTEM`'s closing line ("Return the persona and the drafts, nothing else.") change to: `Return the drafts, plus the persona when the recipient block asked you to invent one.`

**Step 4: Run tests**

Run: `npx vitest run src/__tests__/swipe-real-recipient-prompts.test.ts src/__tests__ 2>&1 | tail -3`
Expected: new tests PASS; existing suites still green (check `email-skills`/swipe tests in particular).

**Step 5: Commit**

```bash
git add src/lib/email-skills/swipe-prompts.ts src/__tests__/swipe-real-recipient-prompts.test.ts
git commit -m "feat(voice): real-recipient prompt block; persona optional in batch schema"
```

---

### Task 3: Wire recipient selection into generateVoiceBatch

**Files:**

- Modify: `src/lib/email-skills/swipe-service.ts` (the `generateVoiceBatch` function and `loadPromptContext` doc comment)

**Step 1: Implement**

1. Imports:

```ts
import {
  loadRecipientCandidates,
  pickRecipient,
  recipientLabel,
} from "@/lib/email-skills/swipe-recipient";
```

2. In `generateVoiceBatch`, after `loadPromptContext`, pick the recipient:

```ts
// Real recipient when the campaign has contacts; invented persona
// otherwise. Any load failure returns [] and falls through to invented.
const candidates = input.campaignId
  ? await loadRecipientCandidates(supabase, input.campaignId)
  : [];
const recipient = pickRecipient(
  candidates,
  input.transcript.judged
    .map((j) => j.personaLabel)
    .filter((l): l is string => Boolean(l)),
);
```

3. Pass it to the system prompt: `system: buildBatchSystem(campaign, senderContext, recipient),`

4. Build the result label server-side. Replace the current return with:

```ts
if (!result.ok) {
  return { ok: false, error: result.error };
}
// Real recipient: the server stamps the label so the model cannot misname
// anyone. Invented: the label comes from the returned persona as before.
const label = recipient
  ? recipientLabel(recipient)
  : result.value.persona
    ? personaLabel(result.value.persona)
    : null;
return {
  ok: true,
  drafts: result.value.drafts,
  persona: label ? { label, real: recipient !== null } : null,
};
```

5. Update the `generateVoiceBatch` return type: `persona: { label: string; real: boolean } | null;` and adjust its doc comment ("The recipient this batch is written to: a real campaign contact, or the invented persona as a fallback."). Update the stale sentence in `loadPromptContext`'s comment ("The recipient is not loaded at all") to point at the new selection step.

**Step 2: Typecheck and run the full suite**

Run: `pnpm typecheck && pnpm test 2>&1 | grep -E "Test Files|Tests "`
Expected: clean; all suites pass.

**Step 3: Commit**

```bash
git add src/lib/email-skills/swipe-service.ts
git commit -m "feat(voice): batches draft to a rotating real campaign contact"
```

---

### Task 4: Surface the real flag through voice tools and the deck

**Files:**

- Modify: `src/lib/tools/voice-tools.ts` (emitDrafts data + `personaNote` in `startVoiceRun` and `rewriteVoiceDrafts`)
- Modify: `src/lib/voice-run-context.tsx` (draft ingest, ~line 247)
- Modify: `src/lib/email-skills/swipe-run.ts` (`RunDraft`)
- Modify: `src/components/email-skills/voice-swipe.tsx` (`Card`, ~line 665)

**Step 1: Implement**

1. `voice-tools.ts`: widen `emitDrafts`'s `persona` param type to `{ label: string; real?: boolean } | null` (the service now supplies `real`). Make the note honest in both tools:

```ts
      personaNote: result.persona?.real
        ? "The recipient is a real contact from this campaign; drafts only reference enriched facts about them."
        : "The recipient is a fictional persona invented from the campaign ICP; a fresh one appears each batch.",
```

2. `swipe-run.ts`: add to `RunDraft`:

```ts
  /** True when personaLabel names a real campaign contact, not an invented persona. */
  personaReal?: boolean;
```

3. `voice-run-context.tsx` ingest (`data-voice-drafts` branch): stamp the flag alongside the label:

```ts
const label = data.persona?.label ?? null;
const real = data.persona?.real ?? false;
const withIds: RunDraft[] = data.drafts.map((d) => ({
  ...d,
  id: crypto.randomUUID(),
  personaLabel: label,
  personaReal: real,
}));
```

Also widen the local `DraftsPart` persona type to `{ label: string; real?: boolean } | null`.

4. `voice-swipe.tsx`: thread `personaReal` from the card's `RunDraft` into `Card` (follow how `personaLabel` reaches the `to` prop, ~lines 113-116) and render:

```tsx
<span className="text-muted-foreground mb-3.5 text-[0.8125rem]">
  To {to ?? "an invented prospect"}
  {to && (
    <span className="text-muted-foreground/70 ml-1.5 text-[0.6875rem]">
      {toReal ? "· in this campaign" : "· ✨ invented"}
    </span>
  )}
</span>
```

Update the `Card` doc comment ("This batch's invented persona. Never a real contact...") — it is no longer true; the marker now says which mode the batch used.

**Step 2: Verify**

Run: `pnpm typecheck && pnpm test 2>&1 | grep -E "Test Files|Tests " && pnpm lint 2>&1 | tail -2`
Expected: clean. Then `npx prettier --write` the four touched files.

**Step 3: Commit**

```bash
git add src/lib/tools/voice-tools.ts src/lib/voice-run-context.tsx src/lib/email-skills/swipe-run.ts src/components/email-skills/voice-swipe.tsx
git commit -m "feat(voice): deck cards show real-contact recipients"
```

---

### Task 5: Full verification and PR

**Step 1:** `pnpm typecheck && pnpm lint && pnpm test && npx prettier --check src/`
**Step 2:** Manual smoke (optional, needs local stack): start a swipe run on a campaign with contacts; card header should show a real contact with "· in this campaign"; a campaign with zero contacts should still show "✨ invented".
**Step 3:** Push the branch and open a PR titled `feat(voice): swipe drafts written to real campaign contacts`. Body should cover: the design decisions (training-only keeps, silent fallback, server-side selection), the truthfulness rule, and the rotation mechanism. End the body with the standard Claude Code attribution line.
