# Voice Swipe Completion Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Take the working `/email-skills/swipe` prototype to something mergeable: driven by the main agent, grounded in the user's real profile, campaign and contacts, and free of the review findings.

**Architecture:** A `voice_swipe_runs` row becomes the single source of truth for a run. Server-side agent tools write drafts into it; the deck reads it and writes verdicts back. Supabase realtime keeps the two in sync, which lets the private chat panel be deleted entirely — the conversation moves to the main `AgentPanel` that already sits beside every page.

**Tech Stack:** Next.js App Router, Supabase (Postgres + RLS + realtime), AI SDK `tool()`, Anthropic Opus 5, vitest, Tailwind v4.

---

## Context for someone new to this codebase

Read these before starting. They are short and each one prevents a wrong turn:

- `docs/plans/2026-08-01-voice-by-swiping-design.md` — why this exists and why typed instructions go to the model rather than a parser. **Not in git** (`docs/plans/*-design.md` is gitignored); it is on disk in this worktree.
- `src/lib/email-skills/swipe-prompts.ts` — the two prompts. Do not re-derive them; they were validated against live runs.
- `src/lib/voice-swipe.ts` — convergence maths. Pure, tested, no React.
- `src/components/email-skills/voice-swipe.tsx` — the current UI. **Roughly half of this gets deleted in Phase 1.**
- `src/lib/tools/tracking-tools.ts` — the shape every tool file follows.
- `src/lib/tools/index.ts` — the registry. Tools are wrapped with telemetry by `withTelemetry`; just export from the file and add to `rawTools`.
- `supabase/migrations/20260801000001_canonical_linkedin_urls.sql` — the house style for migrations. Comments explain _why_, including what a naive version gets wrong.

**Things that will bite you:**

- Tools execute **server-side**. They cannot call `setState`. Everything the UI must react to goes through the database.
- `getSupabaseAndUser()` returns an **RLS-scoped** client. Use it, not the admin client, unless you have a specific reason — RLS is what stops one user reading another's run.
- Anthropic intermittently wraps a correct payload in a `value` key. Every `generateObject` call needs the `salvageObject(err, schema)` fallback. See `src/lib/ai/salvage-object.ts`.
- `maxOutputTokens` caps thinking _plus_ visible output on Opus 5. A budget sized for the text alone truncates and fails `generateObject` outright.
- Husky + lint-staged runs eslint and prettier on commit. Run `pnpm format` first to avoid surprises.
- Dev server for this worktree: `cd /Users/jay/signal-swipe && pnpm dev`. It shares port 3000, so stop any other one first.

**Run the full suite with `pnpm test`.** Baseline at the start of this plan: 426 passing.

---

# Phase 1 — Wire the deck to the main agent

The private chat panel in `voice-swipe.tsx` is a third chat engine, alongside the real agent and the old interview wizard. This deletes it.

### Task 1.1: Migration for `voice_swipe_runs`

**Files:**

- Create: `supabase/migrations/20260802000000_voice_swipe_runs.sql`

**Step 1: Write the migration**

```sql
-- Voice-swipe runs
-- 2026-08-02
--
-- One row per in-progress run. It exists because the agent's tools execute
-- server-side and cannot touch React state: the tool writes drafts here, the
-- deck reads them, and the deck writes verdicts back for the next tool call to
-- read. Without a shared row the agent would have to learn each swipe from a
-- narrated chat message, which pollutes the conversation it is trying to hold.
--
-- Only one run per (user, campaign) is live at a time. A second would leave the
-- agent's tools ambiguous about which deck they are writing into, so the unique
-- index below makes that unrepresentable rather than a race.

create table if not exists public.voice_swipe_runs (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  campaign_id uuid references public.campaigns(id) on delete cascade,
  -- Drafts currently queued, newest batch appended. Same shape the batch prompt
  -- returns: { subject, body, axes }.
  drafts jsonb not null default '[]'::jsonb,
  -- Judged drafts with their verdicts and any phrase comments.
  judged jsonb not null default '[]'::jsonb,
  -- Everything the user typed, in order.
  instructions jsonb not null default '[]'::jsonb,
  -- Emails they pasted as samples of their own writing (Phase 2).
  samples jsonb not null default '[]'::jsonb,
  status text not null default 'active' check (status in ('active', 'complete', 'abandoned')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- campaign_id is nullable (the user-level default voice), and NULL never equals
-- NULL in a unique index — so a plain unique(user_id, campaign_id) would let a
-- user accumulate unlimited default-scope runs. coalesce onto a sentinel closes
-- that, matching how email_voice_profiles.campaign_key already handles it.
create unique index if not exists voice_swipe_runs_one_active
  on public.voice_swipe_runs (
    user_id,
    coalesce(campaign_id, '00000000-0000-0000-0000-000000000000'::uuid)
  )
  where status = 'active';

alter table public.voice_swipe_runs enable row level security;

-- Clerk puts the user id in `sub`. requesting_user_id() is defined by an
-- earlier migration and is what every other policy in this schema uses.
create policy "own runs" on public.voice_swipe_runs
  for all to authenticated
  using (user_id = requesting_user_id())
  with check (user_id = requesting_user_id());

-- The deck subscribes to its own row so the agent's writes appear without
-- polling.
alter publication supabase_realtime add table public.voice_swipe_runs;
```

**Step 2: Verify `requesting_user_id()` exists and is what other policies use**

Run: `grep -rn "requesting_user_id" supabase/migrations | head -3`
Expected: at least one match in an earlier migration. **If it does not exist, stop** and copy the RLS predicate from whichever policy `email_voice_profiles` uses instead — getting this wrong silently exposes every user's runs to every other user.

**Step 3: Apply locally**

Run: `supabase db push` (or `supabase migration up` depending on your local setup)
Expected: applies without error.

**Step 4: Verify RLS actually denies**

Run in `supabase studio` SQL editor, as an anon session:

```sql
select count(*) from public.voice_swipe_runs;
```

Expected: 0 rows or a permission error — never another user's data.

**Step 5: Commit**

```bash
git add supabase/migrations/20260802000000_voice_swipe_runs.sql
git commit -m "feat(email-voice): voice_swipe_runs table"
```

---

### Task 1.2: Run accessors

**Files:**

- Create: `src/lib/email-skills/swipe-run.ts`
- Test: `src/__tests__/swipe-run.test.ts`

Thin, typed helpers so neither the tools nor the deck hand-roll queries.

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { toTranscript } from "@/lib/email-skills/swipe-run";

describe("toTranscript", () => {
  it("builds the prompt transcript from a run row", () => {
    const row = {
      judged: [{ subject: "s", body: "b", axes: {}, kept: true, notes: [] }],
      instructions: ["no em dashes"],
      samples: ["Hi — this is one I sent."],
    };
    const t = toTranscript(row as never);
    expect(t.judged).toHaveLength(1);
    expect(t.instructions).toContain("no em dashes");
    // Samples are the strongest evidence there is, so they must reach the
    // prompt — dropping them here is a silent quality regression.
    expect(JSON.stringify(t)).toContain("this is one I sent");
  });
});
```

**Step 2: Run it, confirm it fails**

Run: `pnpm vitest run src/__tests__/swipe-run.test.ts`
Expected: FAIL, module not found.

**Step 3: Implement**

Export `VoiceSwipeRun` (the row type), `toTranscript(row)`, `getActiveRun(supabase, userId, campaignId)`, `startRun(...)`, `appendDrafts(...)`, `recordVerdict(...)`, `addInstruction(...)`, `completeRun(...)`. Keep every one a single query; no business logic.

**Step 4: Run it, confirm it passes. Then `pnpm test` for the whole suite.**

**Step 5: Commit**

---

### Task 1.3: The three agent tools

**Files:**

- Create: `src/lib/tools/voice-tools.ts`
- Modify: `src/lib/tools/index.ts` (add to `rawTools`)
- Modify: `src/lib/system-prompt.ts` (a short section telling the agent when to use them)
- Test: `src/__tests__/voice-tools.test.ts`

Three tools, mirroring what the route already does:

- `startVoiceRun({ campaignId? })` — creates the run, writes the opening batch, returns a count and the review URL. **Never returns the draft bodies**: the system prompt already forbids pasting full email bodies into chat, and the deck is where they belong.
- `rewriteVoiceDrafts({ instruction })` — appends the instruction, regenerates the queued drafts from the full transcript, replaces them.
- `saveVoiceProfile({})` — writes the skill to `email_voice_profiles` and marks the run complete.

**Step 1: Write the failing test** — mock the Supabase client the way `src/__tests__/company-detail-tool.test.ts` does, and assert `rewriteVoiceDrafts` appends the instruction to the run _before_ generating, so a failed generation still leaves the instruction recorded.

**Step 2–4: red, implement, green.**

**Step 5: Add the system-prompt section.** Keep it to five lines under `### Email Voice`, in the imperative voice the rest of the file uses. State plainly that the drafts live on the page and must not be pasted into chat.

**Step 6: Commit**

---

### Task 1.4: Deck reads the run

**Files:**

- Modify: `src/components/email-skills/voice-swipe.tsx`

**Step 1:** Replace local `queue`/`verdicts`/`judgedEmails` state with a subscription to the run row (`supabase.channel(...).on('postgres_changes', ...)`), seeded by an initial fetch.

**Step 2:** Swiping calls `recordVerdict` and lets the subscription update the view. Do not optimistically mutate local state _and_ write — pick one source of truth, which is the row.

**Step 3:** Verify by hand: open the page, ask the agent in the main panel to start a voice run, and watch the deck populate without a reload.

**Step 4: Commit**

---

### Task 1.5: Delete the private panel

**Files:**

- Modify: `src/components/email-skills/voice-swipe.tsx` (remove the `<aside>`, the thread, the composer, `say`, `thread`, `observe`, `said`, the stall modal's send path)
- Modify: `src/app/api/email-skills/swipe/route.ts` — **delete it**; the tools replace it
- Modify: `src/app/email-skills/swipe/page.tsx` (full-width deck)

The deck becomes one column. `AgentPanel` is already mounted to its right by `DashboardShell`, so no layout work is needed to put the chat there.

**This closes three review findings by deletion:** the comment popover's `pointerup` bug, the `aria-modal` stall prompt without a focus trap, and the duplicate chat engine.

**Step: Verify the full loop by hand**, then `pnpm test`, then commit.

---

# Phase 2 — Personal context

Right now the opening batch is written blind: no profile, no campaign, no contact, no samples. This is the largest lever on whether a draft sounds like you.

### Task 2.1: Sender profile and campaign scope

**Files:**

- Modify: `src/app/email-skills/swipe/page.tsx` — read `?campaign=<id>` exactly as `src/app/email-skills/page.tsx:45` does, and load the profile server-side
- Modify: `src/lib/tools/voice-tools.ts` — pass `SwipePersona` from `user_profiles`

`UserProfile` fields worth passing: `name`, `role_title`, `company_name`, `offering_summary`. See `src/lib/types/profile.ts`.

### Task 2.2: A real recipient

**Files:**

- Modify: `src/lib/tools/voice-tools.ts`

Pick the highest-scored contact in the campaign with enrichment, and pass their name, title, company and `enrichment_data` into the batch prompt.

**Hold the recipient constant for the whole run.** If the recipient changes between drafts, a keep or pass could be about the prospect rather than the voice, and voice is the only thing this flow is trying to measure.

### Task 2.3: Paste your own emails

**Files:**

- Modify: `src/components/email-skills/voice-swipe.tsx` (an entry step before the first batch)
- Modify: `src/lib/email-skills/swipe-prompts.ts` (render samples in the transcript; the batch prompt imitates them, the skill prompt ranks them above everything else)

The interview already has this (`request_samples` in `src/app/api/email-skills/interview/route.ts:78`). Reuse its copy — it is well judged.

### Task 2.4: Result screen calls `complete`

**Files:**

- Modify: `src/components/email-skills/voice-swipe.tsx`

Today the Result screen shows `deriveRules()` output — the attribute-derived fallback — not the model-written skill. Call `saveVoiceProfile` and show what came back. `deriveRules` stays as the offline fallback and keeps its tests.

---

# Phase 3 — Findings that survive Phase 1

Re-read the review findings before starting; several are deleted by Phase 1 and should not be re-fixed.

### Task 3.1: Live region

`voice-wizard.tsx:280-295` mounts a permanent `role="status" aria-live="polite"` region precisely because swapping one card for another announces nothing. The deck has none, so a screen reader user swipes in silence. Add one announcing the current draft.

### Task 3.2: Progress bar semantics

`Progress` renders a bare styled div. Give it `role="progressbar"` with `aria-valuenow/min/max`, as `voice-wizard.tsx:481` does.

### Task 3.3: Two `h1`s

`Result` renders an `<h1>` while `page.tsx` already does. Demote to `<h2>`.

### Task 3.4: Keyboard access to phrase comments

The comment affordance is triggered only from `pointerup`, so a keyboard user selecting with Shift+Arrow never sees it. Either add a keyboard path or drop the feature — **do not leave it mouse-only and undocumented.**

### Task 3.5: Re-run the code review

Use the same two-lens split that found the original findings: one pass on logic and tests, one on React and accessibility.

---

# Phase 4 — Merge

1. `pnpm test` — expect ≥ 426 passing plus whatever this plan adds
2. `pnpm build` — expect exit 0 and `/email-skills/swipe` in the route manifest
3. Manually run one full voice build end to end and confirm the row lands in `email_voice_profiles`
4. Confirm the composer picks it up: draft a sequence email and check the voice rules are applied
5. Open the PR from `feat/voice-swipe`
6. Decide the fate of the old interview — **do not delete it in this PR.** Two flows writing the same table is fine; removing the one users currently have is a separate decision with its own blast radius.
7. `git worktree remove /Users/jay/signal-swipe` once merged

---

## Sequencing note

Phase 1 before Phase 3, deliberately. Three of the review findings live in code Phase 1 deletes, so fixing them first is work thrown away.

Phase 2 is the one a user would notice most. If time is short, **do Phase 2 before Phase 1** — grounded drafts in a slightly awkward UI beat generic drafts in an elegant one.
