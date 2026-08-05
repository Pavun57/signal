# Sender Fact Bank + Fictional Swipe Personas Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task.
> Design rationale: `~/.claude/plans/2026-08-04-signal-sender-fact-bank-swipe-personas-design.md`

**Goal:** Give the email drafter a categorized bank of researched facts about the sender to pick from per recipient, and replace the voice-swipe flow's pinned real contact with ICP-generated fictional personas that rotate per batch.

**Architecture:** A new RLS-scoped `sender_facts` table is populated by an Exa-research service (anchored to the URLs already on `user_profile`) and appended to over time by agent tools and the profile page. All facts render into the stable, prompt-cached system prompt; the drafting model picks at most 1–2 per recipient. In the swipe flow, the batch model invents a persona from the campaign ICP inside the same call that writes the drafts; the persona rides in the batch response, the run transcript, and the deck UI. The real-contact path (`swipe-recipient.ts`) is deleted.

**Tech Stack:** Next.js App Router, Supabase (Postgres + RLS, Clerk JWT `requesting_user_id()`), Vercel AI SDK (`generateObject`), Exa via `ExaService`, Zod, Vitest.

**Conventions that bind every task:**

- TDD: write the failing test, see it fail, implement, see it pass, commit.
- Run `pnpm typecheck` before every commit.
- All model-bound stored text goes through `wrapUntrusted` from `@/lib/prompt-safety`.
- Commit messages end with `Co-Authored-By:` line per repo convention (see `git log`).
- Local DB: apply migrations with `supabase migration up` (NOT `db reset`).

---

## Part A — Sender fact bank

### Task A1: Migration for `sender_facts`

**Files:**

- Create: `supabase/migrations/20260805000000_sender_facts.sql`

**Step 1: Write the migration**

Follow the `email_voice_profiles` migration's shape (explicit `begin/commit`, RLS via `requesting_user_id()`). Insert/update also verify the profile belongs to the caller, per the tenant-hardening style in `20260804000000_tenant_policy_hardening.sql`:

```sql
-- Sender fact bank
-- 2026-08-05
--
-- One row per fact about the *sender* (the signed-in user), categorized so the
-- compose prompt can render them grouped and the drafting model can pick the
-- one or two that connect to a given recipient. Populated by researchSenderProfile
-- (source='research'), appended to by the agent (source='agent') and the
-- profile page (source='user'). See docs/plans/2026-08-04-sender-fact-bank-swipe-personas.md.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

create table sender_facts (
  id uuid primary key default gen_random_uuid(),
  -- Clerk sub, same tenant key as email_voice_profiles.
  user_id text not null,
  profile_id uuid not null references user_profile(id) on delete cascade,
  -- background | proof_point | story | pov | credibility | personal
  category text not null,
  -- One plain sentence. Bounded so a runaway insert can't stuff the prompt.
  fact text not null check (char_length(fact) <= 500),
  -- research | user | agent — who wrote it, shown in the UI.
  source text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_sender_facts_profile on sender_facts(profile_id);

create trigger sender_facts_updated_at before update on sender_facts
  for each row execute function update_updated_at_column();

alter table sender_facts enable row level security;

-- profile_id ownership is checked on the writes, not just user_id: without it
-- a request could attach its facts to another tenant's profile row.
create policy "sender_facts_select" on sender_facts
  for select to authenticated using (user_id = requesting_user_id());
create policy "sender_facts_insert" on sender_facts
  for insert to authenticated with check (
    user_id = requesting_user_id()
    and profile_id in (select id from user_profile where user_id = requesting_user_id())
  );
create policy "sender_facts_update" on sender_facts
  for update to authenticated using (user_id = requesting_user_id())
  with check (
    profile_id in (select id from user_profile where user_id = requesting_user_id())
  );
create policy "sender_facts_delete" on sender_facts
  for delete to authenticated using (user_id = requesting_user_id());

commit;
```

**Step 2: Apply and verify**

Run: `supabase migration up`
Then: `supabase db diff --schema public | head` (expect no drift) or `psql`-check via `supabase db psql -c "\d sender_facts"` — table exists with the policies and index as written.

**Step 3: Commit**

```bash
git add supabase/migrations/20260805000000_sender_facts.sql
git commit -m "feat(db): sender_facts table for the sender fact bank"
```

Note: prod migration is manual (`supabase db push` against prod) per repo memory — flag it in the PR description, do not attempt it from this plan.

---

### Task A2: Fact-bank module (`renderFactBank`, loader, types)

**Files:**

- Create: `src/lib/sender-facts.ts`
- Test: `src/__tests__/sender-facts.test.ts`

**Step 1: Write the failing tests**

```ts
import { describe, expect, it } from "vitest";
import {
  FACT_CATEGORIES,
  renderFactBank,
  type SenderFact,
} from "@/lib/sender-facts";

const fact = (over: Partial<SenderFact>): SenderFact => ({
  id: "f1",
  category: "proof_point",
  fact: "Grew Signal to 200 customers in 6 months",
  source: "research",
  ...over,
});

describe("renderFactBank", () => {
  it("returns null for an empty bank so prompts render exactly as today", () => {
    expect(renderFactBank([])).toBeNull();
  });

  it("groups facts under category headings, in canonical order", () => {
    const block = renderFactBank([
      fact({
        category: "story",
        fact: "Started out cold-calling as employee #1",
      }),
      fact({ category: "proof_point" }),
    ])!;
    const proofIdx = block.indexOf("proof_point");
    const storyIdx = block.indexOf("story");
    expect(proofIdx).toBeGreaterThan(-1);
    expect(proofIdx).toBeLessThan(storyIdx); // canonical order, not insert order
    expect(block).toContain("Grew Signal to 200 customers");
  });

  it("fences the facts as untrusted content", () => {
    const block = renderFactBank([fact({})])!;
    expect(block).toContain("<untrusted>"); // wrapUntrusted marker
  });

  it("carries the selection rule: at most two, zero is fine, never invent", () => {
    const block = renderFactBank([fact({})])!;
    expect(block).toMatch(/at most (one or two|two)/i);
    expect(block).toMatch(/zero/i);
    expect(block).toMatch(/never invent/i);
  });

  it("drops unknown categories instead of throwing on bad rows", () => {
    expect(
      renderFactBank([fact({ category: "nonsense" as never })]),
    ).toBeNull();
  });
});
```

Check the actual marker `wrapUntrusted` emits (read `src/lib/prompt-safety.ts`) and adjust the fence assertion to the real delimiter before running.

**Step 2: Run to verify failure**

Run: `pnpm vitest run src/__tests__/sender-facts.test.ts`
Expected: FAIL — module not found.

**Step 3: Implement `src/lib/sender-facts.ts`**

```ts
import type { SupabaseClient } from "@supabase/supabase-js";
import { wrapUntrusted } from "@/lib/prompt-safety";

/** Canonical order: how the categories render in every prompt. */
export const FACT_CATEGORIES = [
  "background",
  "proof_point",
  "story",
  "pov",
  "credibility",
  "personal",
] as const;

export type FactCategory = (typeof FACT_CATEGORIES)[number];

export interface SenderFact {
  id: string;
  category: FactCategory;
  fact: string;
  source: "research" | "user" | "agent";
}

/** Hard cap on facts rendered into a prompt; the bank is append-forever. */
export const MAX_FACTS_IN_PROMPT = 40;

/**
 * The SENDER FACT BANK prompt block, or null when there is nothing to say —
 * null keeps every existing prompt byte-identical for users with no facts.
 *
 * The whole bank renders and the *drafting model* picks: a separate selection
 * call per recipient would break the stable-system-prompt cache during
 * fan-out, and picking one relevant detail from forty labeled sentences is
 * exactly what the model is good at.
 */
export function renderFactBank(facts: SenderFact[]): string | null {
  const byCategory = new Map<FactCategory, string[]>();
  for (const f of facts.slice(0, MAX_FACTS_IN_PROMPT)) {
    if (!FACT_CATEGORIES.includes(f.category)) continue;
    const list = byCategory.get(f.category) ?? [];
    list.push(f.fact.trim());
    byCategory.set(f.category, list);
  }
  if (![...byCategory.values()].some((l) => l.length)) return null;

  const body = FACT_CATEGORIES.filter((c) => byCategory.get(c)?.length)
    .map(
      (c) =>
        `${c}:\n${byCategory
          .get(c)!
          .map((f) => `- ${f}`)
          .join("\n")}`,
    )
    .join("\n\n");

  return `SENDER FACT BANK: true facts about the sender, grouped by kind.
Pick AT MOST one or two that genuinely connect to THIS recipient; most emails
need zero or one. A fact used because it fits beats three used because they
exist. Never invent a sender fact that is not listed here.
${wrapUntrusted(body)}`;
}

/** All facts for a profile, canonical category order then insertion order. */
export async function loadSenderFacts(
  supabase: SupabaseClient,
  profileId: string | null | undefined,
): Promise<SenderFact[]> {
  if (!profileId) return [];
  const { data } = await supabase
    .from("sender_facts")
    .select("id, category, fact, source")
    .eq("profile_id", profileId)
    .order("created_at", { ascending: true })
    .limit(MAX_FACTS_IN_PROMPT);
  return (data ?? []) as SenderFact[];
}
```

**Step 4: Run tests**

Run: `pnpm vitest run src/__tests__/sender-facts.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add src/lib/sender-facts.ts src/__tests__/sender-facts.test.ts
git commit -m "feat(email): sender fact bank module with grouped prompt block"
```

---

### Task A3: Wire the bank + dropped profile fields into the compose prompts

**Files:**

- Modify: `src/lib/email-composition/skill.ts` (`buildEmailSystemPrompt`, `buildComposeUserPrompt`)
- Modify: `src/lib/email-composition/compose.ts` (thread `factBank` through `ComposeInput`)
- Test: `src/__tests__/email-composition-skill.test.ts` (create; none exists today)

**Step 1: Failing tests**

```ts
import { describe, expect, it } from "vitest";
import {
  buildComposeUserPrompt,
  buildEmailSystemPrompt,
} from "@/lib/email-composition/skill";
import { renderFactBank } from "@/lib/sender-facts";

const baseInput = {
  contact: { name: "A", title: null, email: "a@b.co", enrichmentData: null },
  company: null,
  step: { stepNumber: 1, totalSteps: 1, condition: "always", isFinal: false },
  campaign: { name: "C", icp: null, offering: null, positioning: null },
  senderProfile: {
    name: "Jay",
    title: "Founder",
    company: "Signal",
    signature: null,
    offeringSummary: "AI sales agent",
    notes: "prefers plain speech",
  },
};

describe("buildEmailSystemPrompt with a fact bank", () => {
  const bank = renderFactBank([
    { id: "1", category: "proof_point", fact: "200 customers", source: "user" },
  ])!;

  it("appends the fact bank after the voice profile", () => {
    const sys = buildEmailSystemPrompt(null, bank);
    expect(sys).toContain("SENDER FACT BANK");
    expect(sys).toContain("200 customers");
  });

  it("is byte-identical to today when there is no bank", () => {
    expect(buildEmailSystemPrompt(null, null)).toBe(
      buildEmailSystemPrompt(null),
    );
  });
});

describe("buildComposeUserPrompt sender fields", () => {
  it("carries offering summary and notes that were previously dropped", () => {
    const prompt = buildComposeUserPrompt(baseInput);
    expect(prompt).toContain("AI sales agent");
    expect(prompt).toContain("prefers plain speech");
  });

  it("omits the lines when unset instead of printing placeholders", () => {
    const prompt = buildComposeUserPrompt({
      ...baseInput,
      senderProfile: {
        ...baseInput.senderProfile,
        offeringSummary: null,
        notes: null,
      },
    });
    expect(prompt).not.toContain("Offering summary");
    expect(prompt).not.toContain("Sender notes");
  });
});
```

**Step 2: Run, expect FAIL** (`buildEmailSystemPrompt` takes 1 arg; `senderProfile` has no such fields).

**Step 3: Implement**

In `skill.ts`:

- `buildEmailSystemPrompt(voice: VoiceProfile | null, factBank?: string | null)`. Append after the voice block (or after base when no voice):

```ts
export function buildEmailSystemPrompt(
  voice: VoiceProfile | null,
  factBank?: string | null,
): string {
  // ...existing body producing `prompt`...
  if (!factBank) return prompt;
  return `${prompt}\n\n---\n${factBank}`;
}
```

(The bank is stable per profile, so it belongs in the cached system prompt.)

- `senderProfile` input type gains `offeringSummary: string | null` and `notes: string | null`. In the `SENDER:` section, append conditionally:

```ts
const senderLines = [
  `- Name: ${input.senderProfile.name ?? "(not set)"}`,
  `- Title: ${input.senderProfile.title ?? "(not set)"}`,
  `- Company: ${input.senderProfile.company ?? "(not set)"}`,
];
if (input.senderProfile.offeringSummary)
  senderLines.push(
    `- Offering summary: ${input.senderProfile.offeringSummary}`,
  );
if (input.senderProfile.notes)
  senderLines.push(`- Sender notes: ${input.senderProfile.notes}`);
sections.push(`SENDER:\n${senderLines.join("\n")}`);
```

In `compose.ts`: `ComposeInput` gains `factBank?: string | null`; pass to `buildEmailSystemPrompt(voice ?? null, factBank ?? null)`. Note the cache comment: system prompt is now stable per (user, profile, campaign, voice, **facts**) — still stable across a fan-out.

**Step 4: Run tests + `pnpm typecheck`.** Typecheck will fail at every `composeEmail`/`buildComposeUserPrompt` caller missing the new sender fields — fix them in Task A4, but keep this commit green by making the two new senderProfile fields **optional** (`offeringSummary?: string | null`). Tests PASS, typecheck PASS.

**Step 5: Commit** — `feat(email): fact bank and dropped profile fields reach the compose prompts`

---

### Task A4: Load facts in every composeEmail caller

**Files:**

- Modify: `src/lib/jobs/executors/outreach-process.ts` (~line 268–282 profile load, ~line 396 senderProfile)
- Modify: `src/lib/tools/sequence-tools.ts` (its composeEmail fan-out; find with `rg -n "composeEmail|senderProfile" src/lib/tools/sequence-tools.ts`)
- Modify: `src/app/api/outreach/regenerate/route.ts` (same)

**Step 1:** In each caller, where `user_profile` is loaded, widen the select to `name, role_title, company_name, offering_summary, notes, id` and load facts once per batch (never per contact):

```ts
import { loadSenderFacts, renderFactBank } from "@/lib/sender-facts";
// after loading profile:
const factBank = renderFactBank(
  await loadSenderFacts(supabase, campaign?.profile_id ?? profile?.id ?? null),
);
```

Pass `factBank` into `composeEmail({ ...input, factBank })` and the new fields into `senderProfile: { ..., offeringSummary: profile?.offering_summary ?? null, notes: profile?.notes ?? null }`.

**Step 2:** `pnpm typecheck && pnpm test` — all green. There are existing tests around outreach; run the full suite.

**Step 3: Commit** — `feat(email): all composers load the sender fact bank`

---

### Task A5: Research service (Exa → categorized facts, deduped)

**Files:**

- Create: `src/lib/services/sender-research.ts`
- Test: `src/__tests__/sender-research.test.ts` (pure parts only: dedupe + prompt shaping)

**Step 1: Failing tests** for the pure helpers:

```ts
import { describe, expect, it } from "vitest";
import { dedupeFacts, factsFromModel } from "@/lib/services/sender-research";

describe("dedupeFacts", () => {
  it("drops a fact already in the bank, ignoring case and punctuation", () => {
    const existing = [{ fact: "Grew Signal to 200 customers." }];
    const fresh = [
      { category: "proof_point", fact: "grew signal to 200 customers" },
      { category: "pov", fact: "Cold email should read like a text" },
    ];
    expect(dedupeFacts(fresh, existing)).toHaveLength(1);
  });
});

describe("factsFromModel", () => {
  it("drops facts with unknown categories and over-length facts", () => {
    const out = factsFromModel([
      { category: "proof_point", fact: "x".repeat(600) },
      { category: "made_up", fact: "hi" },
      { category: "story", fact: "Started as employee #1" },
    ]);
    expect(out).toEqual([
      { category: "story", fact: "Started as employee #1" },
    ]);
  });
});
```

**Step 2: FAIL, then implement.** Shape of the service:

```ts
import { z } from "zod";
import { generateObject } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { MODELS } from "@/lib/ai/models";
import { ExaService } from "@/lib/services/exa-service";
import { llmTimeout } from "@/lib/utils/timeout";
import { UNTRUSTED_NOTICE, wrapUntrusted } from "@/lib/prompt-safety";
import { FACT_CATEGORIES } from "@/lib/sender-facts";
import type { UserProfile } from "@/lib/types/profile";

const ResearchedFactsSchema = z.object({
  facts: z
    .array(
      z.object({
        category: z.enum(FACT_CATEGORIES),
        fact: z.string().max(500),
      }),
    )
    .max(25),
});
```

- `researchSender(profile: UserProfile)`:
  1. Collect the URLs on the profile: `linkedin_url`, `personal_url`, `company_url`, `twitter_url`. **Zero URLs → return `{ ok: false, error }` telling the user to add URLs first.**
  2. For each URL, `exa.search(url, { includeText: true, numResults: 3, includeDomains: [hostOf(url)] })` — **anchored to the exact URL/domain, never a bare name search**. This is the namesake-merge lesson from prospect enrichment: a name query pulls strangers who share it.
  3. Concatenate the page texts (cap ~6k chars per source, ~20k total), then one `generateObject` on `MODELS.LIGHT` with system prompt: _"Extract facts about THIS person/company for use in their own outreach emails. Only what the sources state. Categories: background (career), proof_point (numbers, wins), story (anecdotes), pov (opinions they hold), credibility (press, talks, logos), personal (interests). One sentence each, written in third person."_ Sources go through `wrapUntrusted`; include `UNTRUSTED_NOTICE`.
  4. `factsFromModel` validates category/length; `dedupeFacts` normalizes (lowercase, collapse whitespace, strip trailing punctuation — same normalization as `normaliseInstructions` in swipe-prompts) against existing rows.
  5. Return `{ ok: true, facts }` — the **tool** does the insert, not the service, so the service stays testable without a DB.

**Step 3: tests PASS, typecheck, commit** — `feat(email): sender research service extracts categorized facts from profile URLs`

---

### Task A6: Agent tools + registration

**Files:**

- Create: `src/lib/tools/sender-fact-tools.ts`
- Modify: `src/lib/tools/index.ts` (import + add to `rawTools`)
- Modify: `src/lib/system-prompt.ts` (one line in the profile guidance: mention researching the profile and adding facts over time)

**Step 1:** Three tools, following `profile-tools.ts` patterns (`createClient`, `auth()` from Clerk):

- `researchSenderProfile({ profileId? })`: resolve profile (given id, else most recent, same as `getUserProfile`); call `researchSender`; `dedupeFacts` against `loadSenderFacts`; insert survivors with `source: 'research'`, `user_id` from `auth()`; return `{ added, skippedAsDuplicates, facts }`.
- `addSenderFacts({ profileId?, facts: [{ category, fact }] (max 10) })`: insert with `source: 'agent'`. This is what makes "add to my profile that we crossed 200 customers" work from chat.
- `listSenderFacts({ profileId? })`: returns the bank grouped by category.

Tool descriptions must say what the bank is _for_ (drafting picks 1–2 per recipient) so the agent volunteers it. Register all three in `rawTools`.

**Step 2:** `pnpm typecheck && pnpm test`, then manual check: `pnpm dev`, ask the agent "research my profile" and "add to my profile that …", verify rows in the local DB.

**Step 3: Commit** — `feat(agent): researchSenderProfile / addSenderFacts / listSenderFacts tools`

---

### Task A7: Profile page facts section

**Files:**

- Modify: `src/app/profile/[id]/page.tsx` (facts UI lives on the per-profile edit page)
- Create: `src/app/api/profile/research-facts/route.ts` (POST `{ profileId }` → runs the research path server-side; Exa key never reaches the browser)

**Step 1:** Facts section on the profile edit page, using the browser Supabase client exactly like the rest of the page (RLS enforces tenancy):

- List grouped by category with the `source` shown as a small tag.
- Inline add (category select + one-line input, insert `source: 'user'`), edit, delete.
- "Research my profile" button → POST the API route, then re-fetch the list. Disable with a spinner while running; surface `{ error }` inline (e.g. "add your LinkedIn/website URLs first").

The route handler authenticates like sibling routes (see `src/app/api/outreach/regenerate/route.ts` for the pattern), loads the profile through the RLS client, calls `researchSender`, dedupes, inserts, returns `{ added }`.

**Step 2:** Manual verification in `pnpm dev` (add/edit/delete/research). Run `pnpm test:e2e` if the pages navigation suite touches /profile.

**Step 3: Commit** — `feat(profile): fact bank section with research button`

---

## Part B — Fictional swipe personas

### Task B1: Persona in the batch schema and prompts

**Files:**

- Modify: `src/lib/email-skills/swipe-prompts.ts`
- Test: `src/__tests__/swipe-prompts.test.ts` (update existing describe blocks; they assert the old recipient behavior)

**Step 1: Failing tests first.** Update/add:

```ts
describe("fictional personas", () => {
  it("batch schema requires a persona alongside the drafts", () => {
    expect(() =>
      BatchSchema.parse({ drafts: [validDraft, validDraft] }),
    ).toThrow();
    expect(
      BatchSchema.parse({
        persona: {
          name: "Riya Shah",
          title: "VP Sales",
          company: "Northbeam Labs",
          situation: "Scaling outbound after a Series B",
          signals: ["Hiring 4 SDRs this quarter"],
        },
        drafts: [validDraft, validDraft],
      }).persona.name,
    ).toBe("Riya Shah");
  });

  it("the batch system prompt tells the model to invent the recipient and keep the sender true", () => {
    const sys = buildBatchSystem(campaign, { sender });
    expect(sys).toMatch(/invent/i);
    expect(sys).toMatch(/fiction/i);
    expect(sys).toMatch(/never invent .*sender/i);
    expect(sys).not.toContain("NEVER INVENT DATA. This is a real person");
  });

  it("personaLabel reads as a To line and marks it invented", () => {
    expect(
      personaLabel({
        name: "Riya Shah",
        title: "VP Sales",
        company: "Northbeam Labs",
        situation: "",
        signals: [],
      }),
    ).toBe("Riya Shah · VP Sales, Northbeam Labs");
  });

  it("judged drafts carry which persona they addressed into the transcript", () => {
    const prompt = buildBatchPrompt(
      {
        judged: [{ ...judgedDraft, personaLabel: "Riya Shah · VP Sales" }],
        instructions: [],
      },
      4,
    );
    expect(prompt).toContain("Riya Shah");
  });
});
```

Delete/replace the now-wrong tests: `recipientLabel` describe block, "adds the no-fabrication rule as soon as a real person is named", "renders enrichment inside the untrusted fence", "carries sender and recipient even with no campaign" (recipient half).

**Step 2: FAIL, then implement in `swipe-prompts.ts`:**

- Add:

```ts
export const PersonaSchema = z.object({
  name: z.string().max(80),
  title: z.string().max(120),
  company: z.string().max(120),
  situation: z
    .string()
    .max(300)
    .describe("One line: what is going on for them right now."),
  signals: z
    .array(z.string().max(200))
    .min(1)
    .max(2)
    .describe("Invented but plausible specifics the drafts may reference."),
});
export type Persona = z.infer<typeof PersonaSchema>;

export const BatchSchema = z.object({
  persona: PersonaSchema,
  drafts: z.array(DraftSchema).min(2).max(8),
});

export function personaLabel(p: Persona): string {
  const where = [p.title, p.company].filter(Boolean).join(", ");
  return where ? `${p.name} · ${where}` : p.name;
}
```

- Delete `SwipeRecipient`, `renderRecipient`, `recipientLabel`, `MAX_ENRICHMENT_CHARS`, `NO_FABRICATION`; `SwipePersona` becomes `{ sender?: SwipeSender | null }` (rename to `SwipeSenderContext` to stop the name lying).
- `SwipeSender` gains `factBank?: string | null`; `renderSender` appends it after the profile rows.
- Replace the recipient block in the batch system prompt with:

```
WHO THESE ARE TO — INVENT THE RECIPIENT: before writing the drafts, invent one
fictional but plausible person squarely inside the campaign's ICP (or a
plausible generic B2B buyer when no campaign context is given): name, title,
company, situation, and 1-2 invented specifics. Every draft in this batch is
written to that same person, and you return the persona with the drafts.
Recipient details are yours to invent: the person is fictional, so a made-up
signal is not a lie, it is the exercise. Never reuse a persona that already
appears in the judged drafts below.

THE SENDER IS REAL. Never invent facts about the sender: everything the drafts
claim about who is writing — their offer, numbers, story — must come from the
sender context above.
```

- `JudgedDraft` gains `personaLabel?: string`; `renderTranscript` prefixes each judged line with it when present (so the model can see which persona each judgement was against, and avoid reusing personas).
- In `SKILL_SYSTEM`, add one line under "Your evidence": _"The recipients in the judged drafts were fictional personas invented for practice. Write rules about the user's voice only; never a rule about any persona, their company, or their situation."_

**Step 3:** `pnpm vitest run src/__tests__/swipe-prompts.test.ts` — PASS. `pnpm typecheck` will fail in swipe-service/voice-tools — expected, fixed next task; commit only if typecheck can be kept green by doing B1+B2 as one commit. **Do B1 and B2 in a single commit if needed to stay green.**

---

### Task B2: Service + tools + run state + deck UI

**Files:**

- Modify: `src/lib/email-skills/swipe-service.ts`
- Delete: `src/lib/email-skills/swipe-recipient.ts`
- Modify: `src/lib/tools/voice-tools.ts`
- Modify: `src/lib/email-skills/swipe-run.ts`
- Modify: `src/components/email-skills/voice-swipe.tsx` and its ingest context (`rg -ln "data-voice-drafts" src` to find it)
- Modify: `src/app/email-skills/swipe/page.tsx` if it threads recipient props

**Step 1: swipe-service.ts**

- Remove the `resolveRecipient` import and the recipient branch of `loadPromptContext`; load sender facts instead:

```ts
const [campaignRes, profile] = await Promise.all([...]);
const factBank = renderFactBank(
  await loadSenderFacts(supabase, /* linked profile id, from getProfileForPrompt result */),
);
```

`getProfileForPrompt` returns the full row including `id`, so `loadSenderFacts(supabase, profile?.id)`.

- `generateVoiceBatch` loses `recipientPersonId`; returns `{ drafts, persona: { label: personaLabel(object.persona) } }`.
- `VoiceRunBodySchema`: drop `recipientPersonId`.
- Delete `swipe-recipient.ts` (and its test if one exists: `rg -l resolveRecipient src/__tests__`).

**Step 2: voice-tools.ts**

- `emitDrafts` data becomes `{ mode, drafts, persona: { label } | null }`.
- `startVoiceRun` return field `writtenAbout` → persona label with a note it is invented, e.g. `writtenTo: result.persona?.label, personaNote: "The recipient is a fictional persona invented from the campaign ICP; a fresh one appears each batch."`
- Remove `recipientPersonId` pass-throughs.

**Step 3: swipe-run.ts**

- `VoiceRun`: drop `recipientPersonId`/`recipientLabel`, add `personaLabel: string | null` (current batch's persona, updated on every ingest).
- `RunDraft` gains `personaLabel: string | null` so a queue holding two batches labels each card correctly.
- When judging, copy the draft's `personaLabel` onto the `JudgedDraft`.

**Step 4: voice-swipe.tsx + ingest**

- Ingest handler reads `persona` instead of `recipient`; stamps `personaLabel` onto each ingested draft.
- Card header renders `To: {draft.personaLabel}` with an "invented" affordance, e.g. `Riya Shah · VP Sales, Northbeam Labs · ✨ invented`. Keep the copy honest and small; it must never look like a real contact.
- Remove any pinning UI/props for `recipientPersonId` (`rg -n recipientPersonId src` until clean).

**Step 5: Full suite**

Run: `pnpm typecheck && pnpm test && pnpm lint`
Expected: all green; `rg -n "recipientPersonId|resolveRecipient|recipientLabel" src` returns nothing.

**Step 6: Manual run** — `pnpm dev`, start a voice run with a campaign: opening batch shows a persona, next batch shows a _different_ persona, finish saves rules containing nothing persona-specific.

**Step 7: Commit** — `feat(voice): fictional ICP personas replace the pinned real contact in swipe runs`

---

### Task B3: Final review pass

**Step 1:** `pnpm typecheck && pnpm test && pnpm lint && pnpm format:check` — all green.
**Step 2:** Re-read the diff for the two invariants that must survive review:

1. Sender truth-boundedness: every prompt that lets the model invent recipient details also states sender facts are truth-bound.
2. Empty-bank identity: a user with zero facts gets byte-identical prompts to today (the A3 test proves it).
   **Step 3:** Branch + PR (repo works via PRs to main): `git checkout -b feat/fact-bank-personas` at the start of Task A1 if not already done; open PR noting the **manual prod migration** (`supabase db push`) required before deploy.
