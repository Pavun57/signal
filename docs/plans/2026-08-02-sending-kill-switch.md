# Sending Kill Switch Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** A per-user pause switch on `user_settings` that stops every outbound email (follow-ups, send-now, agent sends) with one toggle in Settings > Email, without touching drafting, reply tracking, or signal monitoring.

**Architecture:** One boolean column, `user_settings.sending_paused`, carried through `resolveSenderConfig()` (the single place a sender identity is built) into `claimAndSendDraft()` (the single chokepoint every email leaves through), checked before anything else so a paused send spends nothing and changes nothing. A dedicated `set_sending_paused` API action keeps the toggle atomic, and an optimistic Switch in the email settings panel makes it feel like a kill switch rather than a form save.

**Tech Stack:** Postgres (Supabase), Next.js App Router, shadcn Switch, vitest, pnpm.

---

## Design

### Where the switch bites (and where it deliberately doesn't)

Every outbound email goes through `claimAndSendDraft` (`src/lib/services/outreach-sender.ts:56`) — its own docblock says so, and all four callers confirm it:

| Caller                                      | Path                                                                           |
| ------------------------------------------- | ------------------------------------------------------------------------------ |
| Follow-ups (recurring job)                  | `outreach-process` executor → `sendApprovedDraft` (:337) → `claimAndSendDraft` |
| Signal-fire sends                           | same executor, `handleSignalTrigger` → `sendApprovedDraft`                     |
| Send-now button                             | `src/app/api/outreach/send-now/route.ts:118` → `sendApprovedDraft`             |
| Agent tools (`sendEmail`, `sendBulkEmails`) | `src/lib/tools/email-tools.ts:851, :999` → `claimAndSendDraft`                 |

All four resolve the sender via `resolveSenderConfig` (`src/lib/services/email-transport.ts:24`) first, so adding the flag to `SenderConfig` covers everything with one check.

**Check placement matters:** the check goes at the very top of `claimAndSendDraft`, BEFORE the send-gate person read, BEFORE just-in-time email verification (which spends Hunter credits), and BEFORE the CAS claim. A paused send therefore: costs nothing, leaves the draft in `status='draft'` (immediately sendable on resume), and returns a distinguishable `reason` string per the invariant at `outreach-sender.ts` ("never swallow the reason").

**Refusal shape (post PR #52):** `outreach-sender.ts` now records every non-send on the draft via `refuse(supabase, draftId, kind, reason)` (`last_error`, `last_error_at`, `last_error_kind`), so refusal reasons survive to the Sent/activity UI. The pause refusal uses this with `kind: "deferred"` (temporary, resumes later; `blocked` means fix-the-contact, `failed` means the send itself broke).

**Deliberately unaffected:**

- The Settings > Email test send (`/api/settings/email/test`) sends via `gmail-service` directly, not through `claimAndSendDraft` — you can verify your mailbox works while paused. This is a feature, not a gap.
- The job queue keeps running: drafting (`pickAndDraft`), reply/bounce tracking (`email.track`), signal monitoring, and cleanup all continue. Pause gates the outbox, not the system.
- Paused follow-ups: `handleFollowups` still iterates due enrollments each run; each send returns the paused refusal and is tallied in the `failures` map. Enrollments stay `active` with `next_send_at` in the past, so they send on the first run after resume. Expect a benign `[outreach/process] followup send failed ... paused` log line per due enrollment per run while paused.

### Migration numbering

`20260803000003_sending_pause.sql` — main's tip now ends at `20260803000002_seed_reply_backfill.sql` (PRs #51-#55 added `20260802000000` and three `20260803...` migrations), so ours goes next.

### Prod rollout ordering (IMPORTANT)

Apply the migration to prod BEFORE merging the code. The new `resolveSenderConfig` selects `sending_paused`; against a DB without the column, PostgREST errors, the settings row comes back null, and every send refuses with "Email is not configured" — fail-closed (no emails escape) but confusing and noisy. Migration-first avoids the window entirely. Note: the GitHub auto-migrate workflow is a no-op (secrets unconfigured), so this is a manual `supabase db push` from this branch's checkout.

Also: an interim stopgap was recommended in prod (deferring the recurring `outreach.process` job by 10 years via SQL editor). The rollout section below re-arms it — AFTER the switch is on.

---

### Task 1: Migration

**Files:**

- Create: `supabase/migrations/20260803000003_sending_pause.sql`

**Step 1: Write the migration**

```sql
-- Kill switch: pauses every outbound email for the user at the send
-- chokepoint (claimAndSendDraft). Drafting, reply tracking, and signal
-- monitoring keep running; nothing leaves the outbox while true.
alter table user_settings
    add column if not exists sending_paused boolean not null default false;
```

**Step 2: Apply locally**

The supabase CLI has a known history mismatch on the local DB (entries from other branches). Do NOT run `supabase db reset` or `migration repair`. Apply directly:

Run: `psql postgresql://postgres:postgres@127.0.0.1:54322/postgres -f supabase/migrations/20260803000003_sending_pause.sql`
Expected: `ALTER TABLE`

NOTE: the four migrations main merged since (20260802000000 through 20260803000002) may also be missing from the local DB. Before Task 5's manual verification, apply any that are missing the same way (psql -f, in order); check with `psql ... -c "\d email_drafts" | grep last_error` (the send-failure columns must exist locally or the refuse() bookkeeping will error).

**Step 3: Commit**

```bash
git add supabase/migrations/20260803000003_sending_pause.sql
git commit -m "feat(sending): add user_settings.sending_paused kill-switch column"
```

---

### Task 2: Enforce at the chokepoint (TDD)

**Files:**

- Modify: `src/lib/services/email-transport.ts` (3 small edits)
- Modify: `src/lib/services/outreach-sender.ts:113` (one refuse() block at the top of claimAndSendDraft)
- Test: `src/__tests__/outreach-sender.test.ts` (new test)
- Modify: `src/__tests__/email-feedback-loop.test.ts:~198` (compile fix: the inline `SenderConfig` literal gains the new required field)
- Modify: `src/__tests__/email-transport.test.ts:~40-46` (the `toEqual` on resolveSenderConfig's full output gains `sendingPaused: false`)

**Step 1: Write the failing test**

In `src/__tests__/outreach-sender.test.ts`, inside `describe("sendApprovedDraft claim semantics")`, before the `"sends after winning the claim"` test. The file's `settingsRow(overrides)` helper (line 86) and `fakeSupabase` recorder make this small:

```typescript
it("refuses when sending is paused, before the gate read and the claim", async () => {
  const { client, calls } = fakeSupabase([
    { data: { id: "step_1" } }, // step select
    { data: draft }, // draft select
    { data: settingsRow({ sending_paused: true }) }, // sender config
    {}, // refuse() bookkeeping: last_error update on the draft
  ]);

  const result = await sendApprovedDraft(client, enrollment);

  expect(result).toMatchObject({
    ok: false,
    reason: expect.stringContaining("paused"),
  });
  expect(sendGmailMock).not.toHaveBeenCalled();
  // The kill switch fires before JIT verification and the claim: no gate
  // read, no credits, no claim. The only write is refuse()'s bookkeeping,
  // which records the reason on the draft as a deferred (retryable) refusal.
  expect(calls.map((c) => c.table)).toEqual([
    "sequence_steps",
    "email_drafts",
    "user_settings",
    "email_drafts",
  ]);
  expect(calls[3].ops).toContainEqual({
    name: "update",
    args: [expect.objectContaining({ last_error_kind: "deferred" })],
  });
});
```

Note: if the existing tests' fake builder does not already record `update` args this way, mirror however the neighboring refusal tests (daily cap, gate blocks) assert `last_error_kind` — match the file's existing idiom over this snippet.

**Step 2: Run it, verify it fails**

Run: `pnpm vitest run src/__tests__/outreach-sender.test.ts`
Expected: FAIL — the new test's result is `ok: true`-shaped or a different refusal (the send-gate person read fires because no pause check exists). All existing tests still pass.

**Step 3: Implement**

`src/lib/services/email-transport.ts` — three edits:

1. `SenderConfig` interface (after `connectedAt`):

```typescript
/** Kill switch from Settings > Email: claimAndSendDraft refuses while true. */
sendingPaused: boolean;
```

2. The `select(...)` string in `resolveSenderConfig` gains `, sending_paused` (line 31).
3. The return object gains:

```typescript
    sendingPaused: settings.sending_paused ?? false,
```

`src/lib/services/outreach-sender.ts` — at the top of `claimAndSendDraft`, immediately after `const now = ...` (line ~113), before the data-quality gate comment block. Uses the module's own `refuse()` helper so the reason lands on the draft like every other non-send:

```typescript
// Kill switch. Checked before everything else so a paused send spends
// nothing (no JIT verification credits, no claim) and the draft stays
// sendable for the moment sending resumes. "deferred": resuming sends it,
// nothing about the draft or contact needs fixing.
if (sender.sendingPaused) {
  return refuse(
    supabase,
    draft.id,
    "deferred",
    "Sending is paused in Settings > Email. Unpause to resume.",
  );
}
```

`src/__tests__/email-feedback-loop.test.ts` — the inline sender literal around line 198 (the `"skips the write for a draft with no person"` test) no longer satisfies `SenderConfig`; add after its `connectedAt` line:

```typescript
        sendingPaused: false,
```

`src/__tests__/email-transport.test.ts` — the `toEqual` assertion on `resolveSenderConfig`'s full output (around line 40) gains:

```typescript
      sendingPaused: false,
```

**Step 4: Run tests, verify they pass**

Run: `pnpm vitest run src/__tests__/outreach-sender.test.ts src/__tests__/email-feedback-loop.test.ts src/__tests__/email-transport.test.ts && pnpm typecheck`
Expected: all PASS, typecheck clean. (Typecheck is the guard that no other `SenderConfig` constructor exists; vitest does not typecheck, so do not skip the tsc run.)

**Step 5: Commit**

```bash
git add src/lib/services/email-transport.ts src/lib/services/outreach-sender.ts src/__tests__/outreach-sender.test.ts src/__tests__/email-feedback-loop.test.ts src/__tests__/email-transport.test.ts
git commit -m "feat(sending): enforce sending_paused at the claimAndSendDraft chokepoint"
```

---

### Task 3: Settings API

**Files:**

- Modify: `src/app/api/settings/email/route.ts`

**Step 1: Expose the flag in GET**

Two edits in the GET handler (lines 20-43):

- The `select(...)` string gains `, sending_paused`.
- The not-yet-configured fallback object gains `sending_paused: false,`.

**Step 2: Add the toggle action in POST**

Insert before the `disconnect_gmail` block (line ~107), matching the existing action pattern:

```typescript
// Kill switch. Its own action rather than part of the plain settings save,
// so toggling is atomic and can never be lost to a half-filled form.
if (body.action === "set_sending_paused") {
  if (typeof body.paused !== "boolean") {
    return NextResponse.json(
      { error: "paused must be a boolean" },
      { status: 400 },
    );
  }
  const { error } = await supabase.from("user_settings").upsert(
    {
      user_id: user.id,
      sending_paused: body.paused,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id" },
  );
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ sending_paused: body.paused });
}
```

(Upsert, not update: a user who has never saved settings has no row yet — same reason the plain save upserts.)

**Step 3: Verify and commit**

Run: `pnpm typecheck && pnpm test`
Expected: clean (no route tests exist for this file; the repo's convention is service-level tests, added in Task 2).

```bash
git add src/app/api/settings/email/route.ts
git commit -m "feat(sending): set_sending_paused action on the email settings API"
```

---

### Task 4: Settings UI toggle

**Files:**

- Modify: `src/components/settings/email-settings.tsx`

The panel is a single client component with an action-per-handler pattern. Four edits:

**Step 1: Import + state**

- Add `import { Switch } from "@/components/ui/switch";` next to the Button/Input imports (line ~7).
- Next to the `dailyLimit` state (line 47):

```typescript
const [sendingPaused, setSendingPaused] = useState(false);
const [pauseToggling, setPauseToggling] = useState(false);
```

**Step 2: Hydrate in `load()`**

After `setDailyLimit(String(configured));` (line ~84):

```typescript
setSendingPaused(data.settings.sending_paused ?? false);
```

**Step 3: Handler**

After `handleSave` (line ~297):

```typescript
const handleTogglePause = async (paused: boolean) => {
  // Optimistic: a kill switch must flip instantly, not after a form save.
  setSendingPaused(paused);
  setPauseToggling(true);
  try {
    const res = await apiFetch("/api/settings/email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "set_sending_paused", paused }),
    });
    const data = await res.json();
    if (!res.ok) {
      setSendingPaused(!paused);
      toast.error(data.error ?? "Failed to update pause state");
      return;
    }
    toast.success(paused ? "All sending paused" : "Sending resumed");
  } catch {
    setSendingPaused(!paused);
    toast.error("Failed to update pause state");
  } finally {
    setPauseToggling(false);
  }
};
```

**Step 4: The card**

Insert between the connect-Gmail conditional's closing `)}` and the `{/* From Name */}` block (line ~508), so it sits at the top of the settings form and renders whether or not Gmail is connected:

```tsx
{
  /* Kill switch */
}
<div
  className={`flex items-center justify-between gap-4 rounded-lg border p-4 ${
    sendingPaused ? "border-destructive/50 bg-destructive/5" : ""
  }`}
>
  <div className="space-y-1">
    <p className="text-sm font-medium">Pause all sending</p>
    <p className="text-muted-foreground text-xs">
      {sendingPaused
        ? "No emails will leave your mailbox. Follow-ups, send now, and agent sends are all blocked until you resume."
        : "Kill switch for every outbound email: follow-ups, send now, and agent sends. Drafting and reply tracking keep running."}
    </p>
  </div>
  <Switch
    checked={sendingPaused}
    onCheckedChange={handleTogglePause}
    disabled={pauseToggling}
    aria-label="Pause all sending"
  />
</div>;
```

(No em dashes in any string — repo policy.)

**Step 5: Verify and commit**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: clean.

```bash
git add src/components/settings/email-settings.tsx
git commit -m "feat(sending): pause-all-sending switch in Settings > Email"
```

---

### Task 5: Manual verification (local, port 3000 must be free)

1. `pnpm dev` from this worktree. Open Settings > Email: the "Pause all sending" card renders; toggle ON → toast "All sending paused"; reload the page → switch stays ON (persistence).
2. `psql postgresql://postgres:postgres@127.0.0.1:54322/postgres -c "select sending_paused from user_settings;"` → `t`.
3. With the switch ON, trigger any send path if convenient (send-now on a draft, or the agent's sendEmail) → expect the refusal reason "Sending is paused in Settings > Email." and the draft still in `status='draft'`.
4. Toggle OFF → toast "Sending resumed"; column back to `f`.
5. `pnpm typecheck && pnpm test && pnpm lint` one final time. Working tree clean after commits.

---

### Task 6: Rollout (production)

Ordering is deliberate; do not reorder:

0. **Check the prod backlog first**: `supabase migration list` from this branch's checkout. Main merged four migrations (20260802000000 through 20260803000002) whose code is ALREADY deployed, and the auto-migrate workflow is still a no-op — if they show as pending, prod is currently running reply-capture/send-failure code against missing columns, and the push below fixes that too. Report what was pending.
1. **Migration push**: `supabase db push` (worktree is linked to prod project `ucbgjgnvkznlejlemekj`; the CLI has stored credentials and the confirm defaults to yes with stdin closed). Applies any pending backlog plus `20260803000003`. Verify with `supabase migration list`: everything paired up. Old code ignores the new column; nothing changes yet.
2. **Merge the PR** → Vercel deploys the enforcing code.
3. **Flip the switch ON** in the deployed app's Settings > Email (the user wants sending paused right now).
4. **Re-arm the stopgap** (only if the deferred-job SQL was run earlier) in the Supabase SQL editor — the pause switch now provides the protection, and the queue should run normally so drafting and reply tracking resume:

```sql
update jobs set run_at = now()
where type = 'outreach.process' and recurring_interval_seconds is not null;
```

5. Sanity: next `outreach.process` run's Vercel log shows due follow-ups tallied under `failures` with the paused reason, and nothing lands in `sent_emails`.
