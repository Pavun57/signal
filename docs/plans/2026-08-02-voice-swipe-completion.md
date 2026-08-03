# Voice Swipe Completion Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Take `/email-skills/swipe` from a merged prototype to the only email-voice flow, and delete the interview it replaces.

**Architecture:** No new schema. The run lives in `sessionStorage` and reaches the agent through the chat body, both of which this codebase already does elsewhere. Server-side tools return drafts through the message stream; a context provider carries them to the deck, which sits in the same React tree as `AgentPanel`.

**Tech Stack:** Next.js App Router, Supabase (Postgres + RLS), AI SDK `tool()`, Anthropic Opus 5, vitest, Tailwind v4.

**Supersedes** `docs/plans/2026-08-01-voice-swipe-completion.md`, which was written before 72 commits landed on main. Line numbers here are verified against `d60ba26`.

---

## State of play

Shipped and merged (PR #48). `/email-skills/swipe` generates varied drafts, rewrites them from typed instructions, converges on keeping 4 of any 5, and writes a real skill to `email_voice_profiles` that the composer applies to every future email.

**Baseline: `pnpm test` = 636 passing.**

Two things changed since that landed which affect this work:

- **Em dashes are now a lint error** in strings, template chunks and JSX text (`eslint.config.mjs`, rule `no-restricted-syntax`). Comments are exempt. The rule's reasoning applies directly here: _"the agent imitates whatever the prompts do"_ — so anything added to `swipe-prompts.ts` must obey it, and `pnpm lint` will catch you if not.
- **The prompts were rewritten** by that sweep: `swipe-prompts.ts` took 36 edits, `voice-swipe-deck.ts` 20. Read them before editing; they are not what the original plan described.

## Context for someone new

- `src/lib/email-skills/swipe-prompts.ts` — the two prompts. Validated against live runs; do not re-derive them.
- `src/lib/voice-swipe.ts` — convergence maths. Pure, tested, no React.
- `src/components/email-skills/voice-swipe.tsx` — 1266 lines. **Roughly a third is deleted in Phase 1.**
- `src/lib/tools/tracking-tools.ts` — the shape every tool file follows.
- `src/lib/tools/index.ts` — the registry; `withTelemetry` wraps everything automatically.

**Things that will bite you:**

- Tools execute **server-side**. They cannot call `setState`. Anything the UI must react to goes through the message stream or the client's own state.
- Anthropic intermittently wraps a correct payload in a `value` key. Every `generateObject` needs the `salvageObject(err, schema)` fallback.
- `maxOutputTokens` caps thinking _plus_ visible output on Opus 5.
- Husky + lint-staged runs eslint and prettier on commit. Run `pnpm format` first.

---

# Phase 1 — one chat, not three

The right panel in `voice-swipe.tsx` is a third chat engine, alongside `AgentPanel` and the interview wizard. This deletes it.

### Task 1.1: Run state in sessionStorage

**Files:** create `src/lib/email-skills/swipe-run.ts`, test alongside it.

**A migration was written for this and deliberately reverted.** Do not reintroduce one:

- `voice-wizard.tsx` already persists an in-progress interview in `sessionStorage`, with the reasoning written down: an unfinished run is worth nothing to the composer, but losing eight answers to a reload is what makes people give up.
- `src/app/api/chat/route.ts` already accepts `campaignId` and `pageContext` from the client body, so a channel for per-message context exists.

Between them, the two things a table would buy are already solved. A migration also reaches production through CI on merge.

Implement `toTranscript`, `readRun`, `saveRun`, `clearRun`, keyed by user and campaign exactly as `storageKey` in `voice-wizard.tsx` does. A campaign run must never resume into the user-level default.

### Task 1.2: Share the run with `AgentPanel`

**Files:** create `src/lib/voice-run-context.tsx`; modify `src/components/dashboard-shell.tsx`.

`AgentPanel` and the page content are siblings under `DashboardShell`, so a context reaches both. The provider holds the run, hydrates from `sessionStorage`, writes back on change.

The deck subscribes for drafts. `AgentPanel` sends the transcript in the chat body alongside the `campaignId` and `pageContext` it already sends, and watches the message stream for a draft-writing tool result.

### Task 1.3: Three agent tools

**Files:** create `src/lib/tools/voice-tools.ts`; modify `src/lib/tools/index.ts` and `src/lib/system-prompt.ts`.

- `startVoiceRun({ campaignId? })` — creates the run, writes the opening batch, returns counts. **Never returns draft bodies**: the system prompt already forbids pasting email bodies into chat, and the deck is where they belong.
- `rewriteVoiceDrafts({ instruction })` — appends the instruction, regenerates from the full transcript. Append **before** generating, so a failed generation still records what was asked.
- `saveVoiceProfile({})` — writes the skill and ends the run.

### Task 1.4: Deck reads from the provider

Replace local `queue`/`verdicts`/`judgedEmails` with the shared run. Swiping writes through the provider; do not optimistically mutate local state _and_ write.

### Task 1.5: Delete the private panel

Remove the `<aside>`, the thread, the composer, `say`, `thread`, `observe`, `said`, and the stall modal's send path. Delete `src/app/api/email-skills/swipe/route.ts` — the tools replace it. `AgentPanel` is already mounted to the deck's right by `DashboardShell`, so no layout work.

**This closes three review findings by deletion:** the comment popover's `pointerup` bug (`voice-swipe.tsx:506`), the `aria-modal` stall prompt with no focus trap, and the duplicate chat engine.

---

# Phase 2 — what the interview can do and swipe cannot

**These are the prerequisites for Phase 4.** Removing the interview without them is a feature regression, not a migration.

### Task 2.1: Refine an existing voice

The interview supports "what should be different?" by replaying its transcript (`buildRefinementTranscript`). Swipe has **no refine path at all** — grep returns zero.

It does not need one. `email_voice_profiles` already stores `instructions` and `source_transcript`, and the skill prompt already takes a transcript. Feed it the saved rules plus "make it blunter" and re-run. Small, and it removes the largest functional gap.

### Task 2.2: Paste your own writing

The interview's `request_samples` move lets you paste emails you have actually sent. That is the highest-signal input in the feature, and swipe cannot accept it — the opening batch is written blind.

Add `samples: string[]` to the transcript. The batch prompt imitates them; the skill prompt already ranks what the user supplied above everything else, so state that samples outrank both.

Reuse the interview's copy for the paste step; it is well judged.

---

# Phase 3 — accessibility parity

**This gates Phase 4.** Deleting the accessible flow and leaving only the less accessible one is a regression you cannot walk back.

- **Live region.** `voice-swipe.tsx` has one `aria-live`; `voice-wizard.tsx` has two, mounted permanently _because_ swapping one card for another announces nothing. Add one announcing the current draft, and `role="log"` on the thread if any thread survives Phase 1.
- **Progress bar.** `Progress` is a bare styled div. `voice-wizard.tsx` gives its bar `role="progressbar"` with `aria-valuenow/min/max`.
- **Two `h1`s** — `Result` renders one while the page already does. Demote to `h2`.
- **Phrase comments are mouse-only.** Triggered from `pointerup`, so a keyboard user selecting with Shift+Arrow never sees the affordance. Add a keyboard path or drop the feature; do not leave it undiscoverable.
- If the stall modal survives Phase 1, rebuild it on `src/components/ui/dialog.tsx` rather than hand-rolling `aria-modal`.

---

# Phase 4 — remove the interview

**It is not "delete `/email-skills`".** That page does four jobs and only one is the wizard:

|                     | Keep?                                           |
| ------------------- | ----------------------------------------------- |
| `VoiceWizard`       | replaced by the deck                            |
| `VoiceProfileView`  | **keep** — viewing your saved voice             |
| `onRefine`          | **keep** — needs Task 2.1 first                 |
| `CampaignVoiceList` | **keep** — which campaigns have their own voice |

### Task 4.1: Swap the wizard branch

`src/app/email-skills/page.tsx` keeps its profile view, campaign list and empty state. Only the branch that renders `VoiceWizard` changes to render the deck.

### Task 4.2: Delete

- `src/components/email-skills/voice-wizard.tsx`
- `src/components/email-skills/interview-move.tsx`
- `src/app/api/email-skills/interview/route.ts`

**Keep** `voice-profile-view.tsx` (shared) and check `confirm-dialog.tsx` for other callers before touching it.

### Task 4.3: Copy that becomes false on merge

- `src/lib/system-prompt.ts` — _"built by answering interview questions"_ and _"there is no way to author it by hand and no tools for it"_. Both false once the tools exist.
- `src/lib/tools/sequence-tools.ts` — the `needsVoice` message says _"about 8-14 questions"_.
- `src/components/app-sidebar.tsx` — the nav entry survives; the URL does not change.

### Task 4.4: `/email-skills/swipe` redirects to `/email-skills`

**Data:** nothing to migrate. Both flows write the same columns with the same conflict target. Existing `source_transcript` rows are only read by the refine path, which Task 2.1 rewrites.

---

## Sequencing

Phase 1 before Phase 3: three accessibility findings live in code Phase 1 deletes.

**Phase 4 is gated on 2.1, 2.2 and all of Phase 3.** Removing the interview before those ships a flow that cannot refine, cannot accept your writing, and announces nothing to a screen reader.

**Interim, worth doing immediately and independently of all the above:** nothing links to `/email-skills/swipe` — not the sidebar, not the interview page, not the agent. It is unreachable unless you type the URL, which is why it looks like nothing shipped. One link on `/email-skills` and a fix to the swipe page's back-link unblocks dogfooding, and neither prejudges Phase 4.
