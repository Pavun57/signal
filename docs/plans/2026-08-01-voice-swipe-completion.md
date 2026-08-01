# Voice Swipe Completion Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Take the working `/email-skills/swipe` prototype to something mergeable: driven by the main agent, grounded in the user's real profile, campaign and contacts, and free of the review findings.

**Architecture:** No new schema. The run lives in `sessionStorage` and is handed to the agent through the chat body, both of which this codebase already does. Server-side tools return drafts through the message stream; a context provider carries them to the deck, which sits in the same React tree as `AgentPanel`. That lets the private chat panel be deleted entirely — the conversation moves to the main agent panel already mounted beside every page.

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

### Task 1.1: Run state in sessionStorage

**Files:**

- Create: `src/lib/email-skills/swipe-run.ts`
- Test: `src/__tests__/swipe-run.test.ts`

**A migration was written for this and reverted (`d7c7044`, reverted). Do not
reintroduce one.** The reasoning matters, because a table looks like the obvious
answer:

- `voice-wizard.tsx:38` already persists an in-progress interview in
  `sessionStorage`, deliberately and with the reasoning written down: an
  unfinished run is worth nothing to the composer, but losing eight answers to
  a reload is what makes people give up.
- `src/app/api/chat/route.ts:89-95` already accepts `campaignId` and
  `pageContext` from the client body, so there is an existing channel for
  handing the agent arbitrary per-message context.

Between them the two things a table would buy — the agent seeing your swipes,
and the run surviving a reload — are already solved. A migration also reaches
production through CI on merge, so it is not a free addition.

Implement `toTranscript`, `readRun`, `saveRun`, `clearRun`, keyed by user and
campaign exactly as `storageKey` in `voice-wizard.tsx:47` does. A campaign run
must never resume into the user-level default.

### Task 1.2: Share the run with `AgentPanel`

**Files:**

- Create: `src/lib/voice-run-context.tsx`
- Modify: `src/components/dashboard-shell.tsx` (wrap, so both halves see it)

`AgentPanel` and the page content are siblings under `DashboardShell`, so a
context reaches both. The provider holds the run, hydrates from
`sessionStorage`, and writes back on change.

The deck subscribes for drafts. `AgentPanel` sends the transcript in the chat
body on each message, alongside the `campaignId` and `pageContext` it already
sends, and watches the message stream for a `writeVoiceDrafts` tool result to
push into the provider.

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
