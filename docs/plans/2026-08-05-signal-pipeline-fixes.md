# Signal Pipeline Fixes Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix the signal-tracking → email-sending pipeline so every signal type can actually fire outreach, tracking scales past the system-partition queue cap, users can trigger runs and see intent gaps, sends respect a send window, and high-confidence fires can (opt-in) send without manual review.

**Architecture:** The pipeline is: Vercel cron (1 min) → Postgres job queue → `tracking.dispatch` (15 min) → `tracking.run` per config → snapshot/hash/diff → Haiku intent verdict → `outreach.process` → draft (pending) → human approves in `/outreach/review` → `claimAndSendDraft` (the single send chokepoint). We fix the snapshot layer to be execution-type-aware instead of hiring-only, thread `user_id` through job enqueues, add a send-window gate inside the chokepoint, and add a narrowly-scoped auto-approve path that preserves the "only a human writes `approved`" invariant everywhere else.

**Tech Stack:** Next.js 16 (App Router), Supabase (Postgres + RLS, admin client for jobs), Vercel AI SDK (`generateObject`, Anthropic models), Vitest (`pnpm test`), Zod. Tests live in `src/__tests__/*.test.ts`.

**Verification commands:** `pnpm typecheck`, `pnpm lint`, `pnpm test` (all must pass before each commit).

**Deploy note:** Prod migrations are applied manually with `supabase db push` (migrate.yaml secrets are unset in prod) — flag this in the PR description.

---

## Context: the bugs being fixed

1. **Hiring-shaped snapshot bug (P0):** `src/lib/jobs/executors/tracking-run.ts:79-88` unconditionally reads `rawOutput.jobs` and calls `normalizeHiringData`. For `exa_search` signals (funding-news, executive-changes, product-launches) and recipe signals (pricing-changes), `jobs` is undefined → every run produces the same empty snapshot → same hash → early-exit "no change" at line 125. Only `hiring-activity` can ever fire outreach. The executors already compute a usable `diff` (`SignalOutput.diff`, `src/lib/signals/types.ts:8-13`) that tracking-run discards.
2. **Queue partition ceiling:** `dispatchDueTracking` (`src/lib/jobs/executors/tracking-dispatch.ts:24-30`) and the `outreach.process` enqueue (`tracking-run.ts:253`) pass no `userId`, so all tracking jobs share the `'<system>'` partition in `claim_jobs` (`per_user_cap = 5` per tick ≈ 300 runs/hour total across all users).
3. **Empty intent silently disables firing:** `evaluateIntent` returns `fire: false` for blank intent (`src/lib/services/intent-evaluator.ts:47-53`) with no UI indication.
4. **No manual "run now":** only the 15-min dispatcher and creation-time baseline trigger runs.
5. **No send window:** approved drafts send whenever cron fires, including 3am recipient time.
6. **No auto-send tier:** positioning is "agent takes end-to-end action" but every send requires manual approval, even for high-confidence fires the user pre-authorized.
7. **Cleanups:** stale `sendEmail` tool description (`src/lib/tools/email-tools.ts:887` claims writeEmail drafts are born approved — `save.ts` makes them pending); `agent_instructions` signals can be tracked but can never run; vestigial `threshold_rules` column; `maxPicks` hardcoded to 1 contact per signal fire; `sendEmail`/`sendBulkEmails` each hand-maintain the claim+send+advance invariant.

---

### Task 0: Branch setup

**Step 1: Create a branch off main**

```bash
cd /Users/jay/signal
git checkout main && git pull
git checkout -b feat/tracking-pipeline-fixes
```

Expected: clean branch created. (Current work branch `feat/fact-bank-personas` is clean and unrelated — leave it alone.)

---

### Task 1: Migration — all schema changes

**Files:**

- Create: `supabase/migrations/20260805000001_tracking_pipeline_fixes.sql` (renamed from `...000000` — that version number was taken by the sender-facts migration merged 2026-08-05; DONE, commit 372e7b9. Includes column-level SELECT grants for the send-window columns, required by tenant policy hardening.)

**Step 1: Write the migration**

```sql
-- Tracking pipeline fixes: auto-send opt-in, per-fire contact count,
-- send-window settings; drop the vestigial threshold_rules column
-- (superseded by the free-text intent column + LLM verdict; no reader
-- anywhere in the codebase).

alter table tracking_configs
  add column if not exists auto_send boolean not null default false,
  add column if not exists max_contacts_per_fire smallint not null default 1
    check (max_contacts_per_fire between 1 and 5);

alter table tracking_configs
  drop column if exists threshold_rules;

-- Send window: null start/end = no window (send any time). Hours are 0-23
-- in send_timezone. A window may wrap midnight (start > end).
alter table user_settings
  add column if not exists send_window_start smallint
    check (send_window_start between 0 and 23),
  add column if not exists send_window_end smallint
    check (send_window_end between 0 and 23),
  add column if not exists send_timezone text;
```

**Step 2: Apply locally and verify**

```bash
supabase migration up
```

Expected: applies cleanly. Verify with:

```bash
supabase db execute --sql "select column_name from information_schema.columns where table_name in ('tracking_configs','user_settings') and column_name in ('auto_send','max_contacts_per_fire','threshold_rules','send_window_start','send_window_end','send_timezone');"
```

Expected: the five new columns present, `threshold_rules` absent. (If `supabase db execute` isn't available in this CLI version, use `psql "$(supabase status --output json | jq -r .DB_URL)" -c "..."`.)

**Step 3: Check tenant policy hardening**

Read `supabase/migrations/20260804000000_tenant_policy_hardening.sql` around line 192 — `user_settings` columns are enumerated in a grant/policy there. If column grants are explicit, add the three new send-window columns to the authenticated-role grant in this migration (they must be readable/writable by the settings UI). `auto_send`/`max_contacts_per_fire` ride tracking_configs' existing campaign-scoped policies (`initial_schema.sql:865-871`) — nothing to add.

**Step 4: Commit**

```bash
git add supabase/migrations/20260805000000_tracking_pipeline_fixes.sql
git commit -m "feat(db): auto_send + max_contacts_per_fire on tracking, send window on user_settings"
```

---

### Task 2: Generic snapshot helpers (fixes P0, pure functions first)

**Files:**

- Modify: `src/lib/services/tracking-differ.ts` (add `buildGenericSnapshot`, loosen `hashSnapshot`)
- Read first: `src/lib/signals/diff.ts` (the `structuralDiff` you'll reuse in Task 3 — understand its input/output shape before writing tests)
- Test: `src/__tests__/tracking-generic-snapshot.test.ts`

**Step 1: Write the failing tests**

```ts
import { describe, it, expect } from "vitest";
import {
  buildGenericSnapshot,
  hashSnapshot,
} from "@/lib/services/tracking-differ";

describe("buildGenericSnapshot", () => {
  it("projects exa_search output to sorted (title, url) pairs, dropping volatile fields", () => {
    const raw = {
      query: "Acme funding",
      resultCount: 2,
      results: [
        {
          title: "B",
          url: "https://b.com",
          publishedDate: "2026-08-05",
          text: "varies",
        },
        {
          title: "A",
          url: "https://a.com",
          publishedDate: "2026-08-04",
          text: "varies too",
        },
      ],
    };
    const snap = buildGenericSnapshot("exa_search", raw);
    expect(snap.data).toEqual({
      results: [
        { title: "A", url: "https://a.com" },
        { title: "B", url: "https://b.com" },
      ],
    });
  });

  it("hashes identically when only volatile exa fields change", () => {
    const base = {
      results: [
        { title: "A", url: "https://a.com", text: "x", publishedDate: "1" },
      ],
      resultCount: 1,
    };
    const later = {
      results: [
        { title: "A", url: "https://a.com", text: "y", publishedDate: "2" },
      ],
      resultCount: 1,
    };
    expect(hashSnapshot(buildGenericSnapshot("exa_search", base))).toBe(
      hashSnapshot(buildGenericSnapshot("exa_search", later)),
    );
  });

  it("hashes differently when a new result appears", () => {
    const base = { results: [{ title: "A", url: "https://a.com" }] };
    const later = {
      results: [
        { title: "A", url: "https://a.com" },
        { title: "B", url: "https://b.com" },
      ],
    };
    expect(hashSnapshot(buildGenericSnapshot("exa_search", base))).not.toBe(
      hashSnapshot(buildGenericSnapshot("exa_search", later)),
    );
  });

  it("passes through non-exa output unchanged", () => {
    const raw = { tiers: [{ name: "Pro", price: 49 }] };
    const snap = buildGenericSnapshot("browser_script", raw);
    expect(snap.data).toEqual(raw);
    expect(snap.execution_type).toBe("browser_script");
  });

  it("hashSnapshot is key-order independent (existing behavior, now on generic snapshots)", () => {
    const a = buildGenericSnapshot("tool_call", { x: 1, y: { b: 2, a: 1 } });
    const b = buildGenericSnapshot("tool_call", { y: { a: 1, b: 2 }, x: 1 });
    expect(hashSnapshot(a)).toBe(hashSnapshot(b));
  });
});
```

**Step 2: Run to verify failure**

```bash
pnpm test src/__tests__/tracking-generic-snapshot.test.ts
```

Expected: FAIL — `buildGenericSnapshot` is not exported.

**Step 3: Implement in `tracking-differ.ts`**

Loosen `hashSnapshot`'s parameter type from `HiringSnapshot` to `unknown` (its implementation at `tracking-differ.ts:63-76` already handles any JSON value — only the annotation narrows it). Then add:

```ts
export interface GenericSnapshot {
  kind: "generic";
  execution_type: string;
  data: Record<string, unknown>;
}

/**
 * Project a signal's raw output into a stable, diffable snapshot for
 * non-hiring signals. Volatile fields (result counts, text excerpts,
 * publish dates) are stripped so the hash only changes when the
 * underlying facts change — otherwise every exa run would look like a
 * change and spam the intent evaluator.
 */
export function buildGenericSnapshot(
  executionType: string,
  rawOutput: Record<string, unknown>,
): GenericSnapshot {
  if (executionType === "exa_search") {
    const results = Array.isArray(rawOutput.results)
      ? (rawOutput.results as Array<Record<string, unknown>>)
      : [];
    const stable = results
      .map((r) => ({
        title: (r.title as string) ?? "",
        url: (r.url as string) ?? "",
      }))
      .sort((a, b) => a.url.localeCompare(b.url));
    return {
      kind: "generic",
      execution_type: executionType,
      data: { results: stable },
    };
  }
  return { kind: "generic", execution_type: executionType, data: rawOutput };
}
```

**Step 4: Run tests**

```bash
pnpm test src/__tests__/tracking-generic-snapshot.test.ts && pnpm typecheck
```

Expected: PASS. (Typecheck confirms the `hashSnapshot` loosening broke no callers — `tracking-run.ts` passes a `HiringSnapshot`, which still satisfies `unknown`.)

**Step 5: Commit**

```bash
git add src/lib/services/tracking-differ.ts src/__tests__/tracking-generic-snapshot.test.ts
git commit -m "feat(tracking): generic snapshot builder for non-hiring signals"
```

---

### Task 3: Wire the generic branch into tracking-run (P0 fix)

**Files:**

- Modify: `src/lib/jobs/executors/tracking-run.ts`
- Read first: `src/lib/signals/diff.ts` (`structuralDiff` signature and return shape)

This restructures `runTrackingConfig` (`tracking-run.ts:25-282`) so snapshot/hash/store stay shared, and only diff-computation branches on shape. The intent-verdict + fire block also gets extracted so Task 8 (auto-send) has one place to touch.

**Step 1: Restructure**

Keep lines 27-76 (config load, signal execution) as-is, but keep the full `signalOutput` in scope (currently only `rawOutput = signalOutput.data` survives — the executor's `diff` is discarded, which is half the bug).

Replace the normalize block (lines 78-88) with:

```ts
// ── Normalize into snapshot ────────────────────────────────────────
// Hiring-shaped output (the hiring-activity scraper) keeps its rich
// title-level diffing; everything else gets a stable generic snapshot.
// Detection is on output shape, not slug, so any future signal that
// emits { jobs: [...] } inherits the hiring pipeline.
const isHiring = Array.isArray(rawOutput.jobs);
const jobs = isHiring
  ? (rawOutput.jobs as Array<{
      title: string;
      department?: string;
      location?: string;
      url?: string;
    }>)
  : [];
const careersUrl = (rawOutput.careersUrl as string) || null;
const snapshot = isHiring
  ? normalizeHiringData(jobs, careersUrl)
  : buildGenericSnapshot(signalRecord.execution_type, rawOutput);
const hash = hashSnapshot(snapshot);
```

Lines 90-146 (fetch previous, always-insert snapshot + signal_result, bump `last_run_at`, early-exit on unchanged hash / missing baseline) stay exactly as they are — they're shape-agnostic. Only fix the `jobCount` fields in the two early returns to `jobCount: isHiring ? (snapshot as HiringSnapshot).job_count : undefined`.

Then branch the diff section (current lines 148-223):

```ts
let changeDescription: string;
let rawDiffForIntent: unknown;

if (isHiring) {
  // ... existing lines 148-209 verbatim: diffHiringSnapshots, classifyNewRoles,
  // describeHiringChanges, changesToInsert build + insert ...
  changeDescription = describeHiringChanges(diff);
  rawDiffForIntent = diff;
} else {
  const prevGeneric = prevSnapshot.snapshot_data as GenericSnapshot;
  // Prefer the executor's own diff (exa_search and recipes compute one
  // against signal_results); fall back to a structural diff of snapshots.
  const executorDiff = signalOutput.diff;
  const structural = structuralDiff(
    prevGeneric.data,
    (snapshot as GenericSnapshot).data,
  );
  const meaningful = executorDiff?.changed ?? structural.changed;
  if (!meaningful) {
    // Hash moved but nothing semantically changed (e.g. result reordering
    // a projection didn't catch). Don't wake the intent evaluator.
    return { trackingConfigId, changed: false };
  }
  changeDescription =
    executorDiff?.description ||
    structural.description ||
    "Signal output changed";
  rawDiffForIntent = executorDiff ?? structural;

  await getAdminClient()
    .from("tracking_changes")
    .insert({
      tracking_config_id: trackingConfigId,
      change_type: "added",
      field_path: "data",
      previous_value: prevGeneric.data,
      current_value: (snapshot as GenericSnapshot).data,
      description: changeDescription,
    });
}
```

(Adjust to `structuralDiff`'s real signature after reading `src/lib/signals/diff.ts` — if it returns `SignalDiff | null` for no-change, treat `null` as `changed: false`.)

Finally, the intent + fire section (current lines 211-266) becomes shared code using `changeDescription` / `rawDiffForIntent`:

```ts
const verdict = await evaluateIntent({
  intent: (typedConfig.intent as string) ?? "",
  signalName: signal?.name ?? "Unknown signal",
  signalCategory: signal?.category ?? "custom",
  snapshotSummary: changeDescription,
  rawDiff: rawDiffForIntent,
  isFirstRun: false,
});

if (verdict.fire) {
  // ... existing threshold_crossed insert + readiness_tag update (lines 226-249) verbatim ...
  void enqueueJob({ ... existing payload ... }).catch(...);
}
```

(Task 4 adds `userId` and Task 8/9 extend the payload — leave those for their tasks; keep this diff minimal.)

Imports to add: `buildGenericSnapshot`, `GenericSnapshot` from `tracking-differ`, `structuralDiff` from `@/lib/signals/diff`.

**Step 2: Verify types and existing tests**

```bash
pnpm typecheck && pnpm test
```

Expected: PASS. There is no existing tracking-run test (the logic was untestable-by-shape before); the pure pieces are covered by Task 2's tests.

**Step 3: Manual smoke test (local)**

With `supabase start` and the dev server running, create an `exa_search` tracking config via chat (e.g. funding-news for a known company, daily, with an intent), let the baseline run, then force a second run by resetting `next_run_at`:

```bash
psql "$(supabase status --output json | jq -r .DB_URL)" -c "update tracking_configs set next_run_at = now() where id = '<config-id>';"
```

Wait for the dispatcher (or hit the Task 6 run-now route once it exists) and confirm `tracking_snapshots.snapshot_data` for the config now contains `{"kind":"generic","execution_type":"exa_search",...}` rather than `{"job_count":0,...}`.

**Step 4: Commit**

```bash
git add src/lib/jobs/executors/tracking-run.ts
git commit -m "fix(tracking): non-hiring signals get real snapshots and can fire outreach"
```

---

### Task 4: Queue partition fix — thread user_id through tracking enqueues

**Files:**

- Modify: `src/lib/jobs/executors/tracking-dispatch.ts`
- Modify: `src/lib/jobs/executors/tracking-run.ts` (the `outreach.process` enqueue)
- Modify: `src/lib/tools/tracking-tools.ts` (baseline enqueues)

The `claim_jobs` per-user fairness cap (`per_user_cap = 5`/tick) partitions on `user_id`; `null` collapses everything into one `'<system>'` partition. The owner is always reachable via `campaigns.user_id` (`initial_schema.sql:775`).

**Step 1: `tracking-dispatch.ts`** — extend the select and pass `userId`:

```ts
const { data: configs, error } = await getAdminClient()
  .from("tracking_configs")
  .select("id, schedule, campaign:campaigns(user_id)")
  .eq("status", "active")
  .lte("next_run_at", new Date().toISOString());
```

and in the loop:

```ts
await enqueueJob({
  type: "tracking.run",
  payload: { trackingConfigId: config.id },
  userId:
    (config.campaign as { user_id?: string | null } | null)?.user_id ?? null,
  maxAttempts: 2,
});
```

**Step 2: `tracking-run.ts`** — extend the config select at line 30 to include the campaign owner:

```ts
"*, organization:organizations(*), signal:signals(*), campaign:campaigns(icp, offering, user_id)";
```

(update the `typedConfig.campaign` type annotation to include `user_id: string | null`), and pass `userId: typedConfig.campaign.user_id ?? null` in the `outreach.process` enqueue.

**Step 3: `tracking-tools.ts`** — `dispatchImmediateRun` gains a `userId` param:

```ts
async function dispatchImmediateRun(
  trackingConfigId: string,
  userId: string | null,
): Promise<void> {
  try {
    await enqueueJob({
      type: "tracking.run",
      payload: { trackingConfigId },
      userId,
      maxAttempts: 2,
    });
  } catch (err) { ... }
}
```

Both callers fetch the campaign owner once: in `createTracking` and `bulkCreateTracking`, before dispatching, `select user_id from campaigns where id = input.campaignId` (via the existing RLS client — the row is theirs by definition) and pass it through.

**Step 4: Verify + commit**

```bash
pnpm typecheck && pnpm test
git add src/lib/jobs/executors/tracking-dispatch.ts src/lib/jobs/executors/tracking-run.ts src/lib/tools/tracking-tools.ts
git commit -m "fix(jobs): tracking jobs carry the campaign owner's user_id for queue fairness"
```

---

### Task 5: Intent guard + "observe only" badge

**Files:**

- Modify: `src/lib/tools/tracking-tools.ts` (validate intent in create/bulk-create/update)
- Modify: `src/app/tracking/page.tsx` (include `intent` in the query + row mapping)
- Modify: `src/components/tracking/tracking-table.tsx` (badge)

`evaluateIntent` hard-returns `fire: false` on blank intent — correct behavior, invisible to the user. Two-part fix: stop new blank intents at the tool boundary, and badge existing ones.

**Step 1: Tool validation** — in `tracking-tools.ts`, change the `intent` schema on `createTracking` and `bulkCreateTracking` to:

```ts
intent: z
  .string()
  .trim()
  .min(10, "Intent is required — without it tracking observes but never fires outreach.")
  .describe(...)
```

and in `updateTracking`, reject clearing it:

```ts
if (input.intent !== undefined && input.intent.trim().length < 10) {
  throw new Error(
    "Intent can't be blank: tracking with no intent observes changes but never fires outreach. Describe what should flag this company as ready to contact.",
  );
}
```

**Step 2: UI badge** — read `src/app/tracking/page.tsx`, add `intent` to the tracking_configs select and to the `TrackingRow` mapping. In `tracking-table.tsx`, add `intent: string | null` to `TrackingRow` and render next to the schedule cell in `ExpandableSignalRow`:

```tsx
{
  !row.intent?.trim() && (
    <span
      className="text-muted-foreground ml-1.5 rounded border px-1 py-0.5 text-[10px]"
      title="No intent configured — this config records changes but will never fire outreach. Update it in Chat."
    >
      observe only
    </span>
  );
}
```

**Step 3: Verify + commit**

```bash
pnpm typecheck && pnpm lint && pnpm test
git add src/lib/tools/tracking-tools.ts src/app/tracking/page.tsx src/components/tracking/tracking-table.tsx
git commit -m "feat(tracking): require intent on new configs, badge intent-less configs as observe-only"
```

---

### Task 6: Manual "run now"

**Files:**

- Create: `src/app/api/tracking/[trackingConfigId]/run/route.ts`
- Modify: `src/components/tracking/tracking-table.tsx` (button)

**Step 1: Read the auth pattern** — open `src/app/api/outreach/send-now/route.ts:14-60` and mirror its Clerk auth + client construction exactly.

**Step 2: The route**

```ts
import { NextResponse } from "next/server";
// auth + createClient imports copied from the send-now route's pattern

import { enqueueJob } from "@/lib/services/jobs";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ trackingConfigId: string }> },
) {
  const { trackingConfigId } = await params;
  // ... Clerk auth check, 401 on no user (mirror send-now) ...

  const supabase = await createClient();
  // The RLS-scoped read doubles as the ownership check: tracking_configs
  // policies resolve through campaigns.user_id, so a foreign config reads
  // as not-found rather than needing an explicit join here.
  const { data: config } = await supabase
    .from("tracking_configs")
    .select("id, status, campaign:campaigns(user_id)")
    .eq("id", trackingConfigId)
    .maybeSingle();

  if (!config) {
    return NextResponse.json(
      { error: "Tracking config not found" },
      { status: 404 },
    );
  }
  if (config.status !== "active") {
    return NextResponse.json(
      { error: "Tracking is paused — resume it before running" },
      { status: 409 },
    );
  }

  const jobId = await enqueueJob({
    type: "tracking.run",
    payload: { trackingConfigId },
    userId:
      (config.campaign as { user_id?: string | null } | null)?.user_id ?? null,
    // Double-clicks queue at most one extra run; the claim_jobs singleton
    // guard keeps them from executing concurrently.
    singletonKey: `tracking-run:${trackingConfigId}`,
    maxAttempts: 1,
  });

  return NextResponse.json({ ok: true, jobId });
}
```

Note `next_run_at` deliberately does not move: a manual run is an extra check, not a rescheduling.

**Step 3: Button** — in `ExpandableSignalRow` (`tracking-table.tsx`), next to the pause button, add a `RefreshCw` icon button:

```tsx
const [running, setRunning] = useState(false);

const runNow = async (e: React.MouseEvent) => {
  e.stopPropagation();
  setRunning(true);
  const res = await fetch(`/api/tracking/${row.id}/run`, { method: "POST" });
  setRunning(false);
  if (res.ok) {
    toast.success("Check queued — results land within a minute or two");
  } else {
    const body = await res.json().catch(() => null);
    toast.error(body?.error ?? "Failed to queue check");
  }
};
```

```tsx
<button
  type="button"
  onClick={runNow}
  disabled={running || localStatus !== "active"}
  className="text-muted-foreground hover:text-foreground p-1 transition-colors disabled:opacity-40"
  title="Run this check now"
>
  <RefreshCw className={`size-3.5 ${running ? "animate-spin" : ""}`} />
</button>
```

(Import `RefreshCw` from `lucide-react`; widen the actions `<td>`/`colSpan` if needed.)

**Step 4: Verify + commit**

```bash
pnpm typecheck && pnpm lint && pnpm test
```

Manual check: click the button locally, confirm a `jobs` row appears (`type = 'tracking.run'`) and executes on the next tick.

```bash
git add src/app/api/tracking src/components/tracking/tracking-table.tsx
git commit -m "feat(tracking): manual run-now trigger (API route + table button)"
```

---

### Task 7: Send window

**Files:**

- Modify: `src/lib/services/gmail-service.ts` (pure helper next to `getEffectiveDailyLimit`)
- Modify: `src/lib/services/email-transport.ts` (resolve + expose window)
- Modify: `src/lib/services/outreach-sender.ts` (gate inside `claimAndSendDraft`, threaded `opts`)
- Modify: `src/app/api/outreach/send-now/route.ts`, `src/lib/tools/email-tools.ts` (bypass for interactive sends)
- Modify: `src/app/api/settings/email/route.ts`, `src/components/settings/email-settings.tsx` (settings)
- Check: `src/lib/outreach/status.ts` (the `deferred` label currently says "Daily send limit reached" — make it generic or derive from `last_error`)
- Test: `src/__tests__/send-window.test.ts`

**Step 1: Write the failing tests**

```ts
import { describe, it, expect } from "vitest";
import { isWithinSendWindow } from "@/lib/services/gmail-service";

// 2026-08-05T15:30:00Z == 08:30 in America/Los_Angeles, 17:30 in Europe/Berlin
const now = new Date("2026-08-05T15:30:00Z");

describe("isWithinSendWindow", () => {
  it("no window configured → always sendable", () => {
    expect(isWithinSendWindow(null, null, "America/Los_Angeles", now)).toBe(
      true,
    );
  });
  it("inside a same-day window", () => {
    expect(isWithinSendWindow(8, 17, "America/Los_Angeles", now)).toBe(true);
  });
  it("outside a same-day window", () => {
    expect(isWithinSendWindow(9, 17, "Europe/Berlin", now)).toBe(false); // 17:30, end is exclusive
  });
  it("overnight window wrapping midnight", () => {
    expect(isWithinSendWindow(16, 9, "Europe/Berlin", now)).toBe(true); // 17:30 ∈ [16, 9)
    expect(isWithinSendWindow(20, 6, "Europe/Berlin", now)).toBe(false);
  });
  it("degenerate equal start/end → no window", () => {
    expect(isWithinSendWindow(9, 9, "Europe/Berlin", now)).toBe(true);
  });
  it("invalid timezone fails open — a window is a deliverability nicety, not a safety gate", () => {
    expect(isWithinSendWindow(0, 1, "Not/AZone", now)).toBe(true);
  });
});
```

**Step 2: Run** — `pnpm test src/__tests__/send-window.test.ts` — expected FAIL (not exported).

**Step 3: Implement** in `gmail-service.ts` next to `getEffectiveDailyLimit`:

```ts
/**
 * Whether `now` falls inside the user's configured send window.
 * Hours are 0-23 in `timeZone`; end is exclusive; start > end wraps
 * midnight (e.g. 16 → 9 covers evening + early morning). Null bounds or
 * an unparseable timezone mean "no window" — this is a deliverability
 * nicety, and a bad setting must never silently halt all sending.
 */
export function isWithinSendWindow(
  startHour: number | null,
  endHour: number | null,
  timeZone: string | null,
  now: Date = new Date(),
): boolean {
  if (startHour === null || endHour === null || startHour === endHour)
    return true;
  let hour: number;
  try {
    hour = Number(
      new Intl.DateTimeFormat("en-US", {
        hour: "numeric",
        hourCycle: "h23",
        timeZone: timeZone ?? "UTC",
      }).format(now),
    );
  } catch {
    return true;
  }
  return startHour < endHour
    ? hour >= startHour && hour < endHour
    : hour >= startHour || hour < endHour;
}
```

Run: `pnpm test src/__tests__/send-window.test.ts` — expected PASS.

**Step 4: Resolve the window** — in `email-transport.ts`, add to `SenderConfig`:

```ts
/** Send window in sender-local hours; null start/end = send any time. */
sendWindowStart: number | null;
sendWindowEnd: number | null;
sendTimezone: string | null;
```

extend the select with `send_window_start, send_window_end, send_timezone` and map them (`?? null`).

**Step 5: Gate in `claimAndSendDraft`** — add an options param and the check directly after the pause kill switch (`outreach-sender.ts:126`), before the data-quality gate so a deferred send spends nothing:

```ts
export async function claimAndSendDraft(
  supabase: SupabaseClient,
  draft: DraftForSend,
  sender: SenderConfig,
  trackMetadata?: Record<string, unknown>,
  opts?: { bypassSendWindow?: boolean },
): Promise<SendResult> {
```

```ts
// Send window: cron-driven paths wait for the window; interactive paths
// (send-now click, agent send confirmed in chat) pass bypassSendWindow —
// an explicit human "send" beats a schedule preference.
if (
  !opts?.bypassSendWindow &&
  !isWithinSendWindow(
    sender.sendWindowStart,
    sender.sendWindowEnd,
    sender.sendTimezone,
  )
) {
  return refuse(
    supabase,
    draft.id,
    "deferred",
    `Outside the configured send window (${sender.sendWindowStart}:00–${sender.sendWindowEnd}:00 ${sender.sendTimezone ?? "UTC"}); will send during the next window.`,
  );
}
```

Thread `opts` through `sendApprovedDraft` (add the same optional param, pass it down). Callers:

- `send-now` route → `{ bypassSendWindow: true }`
- `sendEmail` / `sendBulkEmails` in `email-tools.ts` (their `claimAndSendDraft` calls at ~line 949 and ~1120) → `{ bypassSendWindow: true }` (the user just confirmed in chat)
- followups + signal loops in `outreach-process.ts` → no opts (respect the window)

**Step 6: `status.ts`** — read `src/lib/outreach/status.ts:15-83`. The `deferred` copy is hardcoded to the daily-limit case; since `last_error` now carries the specific reason, prefer showing `last_error` when present, falling back to a generic "Deferred — will retry automatically".

**Step 7: Settings API + UI** — in `src/app/api/settings/email/route.ts`, mirror the `set_sending_paused` action (lines 110-128) with a `set_send_window` action accepting `{ start, end, timezone }`; validate `start`/`end` as integers 0-23 or null, and validate timezone with:

```ts
try {
  new Intl.DateTimeFormat("en-US", { timeZone: input.timezone });
} catch {
  return NextResponse.json({ error: "Unknown timezone" }, { status: 400 });
}
```

Include the three fields in the settings GET payload. In `email-settings.tsx`, add a "Send window" block near the pause toggle (lines 303-322): two hour `<select>`s (`—`/0-23) and a timezone `<select>` populated from `Intl.supportedValuesOf("timeZone")`, defaulting to `Intl.DateTimeFormat().resolvedOptions().timeZone`. Follow the existing save-button pattern in that file.

**Step 8: Verify + commit**

```bash
pnpm typecheck && pnpm lint && pnpm test
git add -A
git commit -m "feat(send): configurable send window enforced in claimAndSendDraft, bypassed by interactive sends"
```

---

### Task 8: Opt-in auto-send for high-confidence fires

**Files:**

- Modify: `src/lib/email-composition/save.ts` (add `autoApproveDraft`; confirm `saveDraft` returns the draft id — if not, extend its return)
- Modify: `src/lib/jobs/executors/tracking-run.ts` (payload)
- Modify: `src/lib/jobs/executors/outreach-process.ts` (`SignalPayload`, `pickAndDraft`)
- Modify: `src/lib/tools/tracking-tools.ts` (expose `autoSend` on create/bulk/update)
- Modify: `src/components/tracking/tracking-table.tsx` (badge)
- Test: `src/__tests__/auto-approve-draft.test.ts`

Design: the only writer of `review_status = 'approved'` today is a human in `/outreach/review` — that's the prompt-injection defense and it stays the default. Auto-send is safe to add **narrowly** because every layer below still applies: `canSendTo`, JIT verification, daily cap + warmup, pause switch, send window. Conditions, all required: config has `auto_send = true` (explicit user opt-in per config) AND the intent verdict is `confidence: "high"`.

**Step 1: `autoApproveDraft` + test.** In `save.ts`:

```ts
/**
 * Flip a signal-drafted email straight to approved, skipping the review
 * queue. ONLY callable from the signal outreach path, and only when the
 * tracking config opted in (auto_send) AND the intent verdict was
 * high-confidence. Guarded on pending so it can never resurrect a
 * rejected draft. Every other writer of 'approved' is a human click in
 * /outreach/review — keep it that way.
 */
export async function autoApproveDraft(
  supabase: SupabaseClient,
  draftId: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from("email_drafts")
    .update({ review_status: "approved" })
    .eq("id", draftId)
    .eq("review_status", "pending")
    .select("id")
    .maybeSingle();
  return !error && !!data;
}
```

(Match `save.ts`'s existing client typing convention.) Check `saveDraft`'s return shape — if `{ ok: true }` doesn't include the inserted draft id, add `draftId` to the success return (the insert already `select`s or can).

Test (mock the supabase client minimally, following the style of `src/__tests__/outreach-sender.test.ts`):

```ts
// asserts: (1) the update is guarded on review_status = 'pending',
// (2) returns false when no row matched (already rejected/approved).
```

Run the test, watch it fail, implement, watch it pass.

**Step 2: tracking-run payload** — the fire block gains:

```ts
const autoSend =
  Boolean(typedConfig.auto_send) && verdict.confidence === "high";
```

and the enqueue payload gains `autoSend`.

**Step 3: outreach-process** — extend `SignalPayload`:

```ts
autoSend?: boolean;
```

In `pickAndDraft`, after `saveResult.ok` (line ~438):

```ts
if (saveResult.ok) {
  drafted++;
  if (payload.autoSend && saveResult.draftId) {
    // High-confidence fire on an auto_send config: skip the review queue.
    // The send loop in handleSignalTrigger picks it up this same run, and
    // claimAndSendDraft still applies every hard gate (canSendTo, JIT
    // verification, daily cap, warmup, pause, send window).
    await autoApproveDraft(supabase, saveResult.draftId);
  }
  getPostHogClient().capture({
    ...
    properties: { ..., auto_send: Boolean(payload.autoSend) },
  });
}
```

Also pass `aiReasoning` with an audit marker when auto-sending, e.g. prefix `payload.reason` with `"[auto-send: high-confidence signal] "` so the outreach dashboard shows how the email got out.

The existing send loop in `handleSignalTrigger` (lines 144-156) then sends it via `sendApprovedDraft` with no further changes — enrollment is `waiting`, `current_step` 1, draft approved.

**Step 4: Tools + UI** — add to `createTracking`/`bulkCreateTracking` input schemas:

```ts
autoSend: z
  .boolean()
  .default(false)
  .describe(
    "When true AND a signal fire has high confidence, the drafted email is sent automatically without human review (daily caps, verification, and send window still apply). Only set this when the user explicitly asks for fully automatic sending.",
  ),
```

insert `auto_send: input.autoSend`, and add the same optional field to `updateTracking`. In `tracking-table.tsx`, add `autoSend: boolean` to `TrackingRow` (and the page query) and render an `auto-send` chip beside the signal name with a tooltip ("High-confidence fires send without review").

**Step 5: Verify + commit**

```bash
pnpm typecheck && pnpm lint && pnpm test
git add -A
git commit -m "feat(outreach): opt-in auto-send for high-confidence signal fires"
```

---

### Task 9: Configurable contacts-per-fire

**Files:**

- Modify: `src/lib/jobs/executors/tracking-run.ts` (payload), `src/lib/jobs/executors/outreach-process.ts` (`pickAndDraft`), `src/lib/tools/tracking-tools.ts` (tool params)

**Step 1:** tracking-run fire payload gains `maxContacts: (typedConfig.max_contacts_per_fire as number) ?? 1` (include `auto_send`/`max_contacts_per_fire` via the existing `*` select — they're already on the row). `SignalPayload` gains `maxContacts?: number`. In `pickAndDraft`, replace the hardcoded `maxPicks: 1` (line ~259-265) with:

```ts
maxPicks: Math.min(Math.max(payload.maxContacts ?? 1, 1), 5),
```

**Step 2:** tool schemas on `createTracking`/`bulkCreateTracking`/`updateTracking`:

```ts
maxContactsPerFire: z
  .number()
  .int()
  .min(1)
  .max(5)
  .default(1)
  .describe(
    "How many contacts at the company to draft for when this signal fires (default 1). A funding round might justify 2-3; each still counts against the daily send cap.",
  ),
```

mapped to the `max_contacts_per_fire` column on insert/update.

**Step 3: Verify + commit**

```bash
pnpm typecheck && pnpm test
git add -A
git commit -m "feat(tracking): configurable contacts-per-fire (1-5, default 1)"
```

---

### Task 10: Cleanups

**Files:**

- Modify: `src/lib/tools/email-tools.ts:885-887` (stale description)
- Modify: `src/lib/tools/tracking-tools.ts` (block `agent_instructions`)

**Step 1: Fix the stale `sendEmail` description.** Replace the description at `email-tools.ts:886-887` with:

```ts
"Send a previously written email draft via the user's connected Gmail. Only approved drafts can be sent: ALL drafts (including ad-hoc writeEmail drafts) start pending and must be approved by the user in the outreach review queue first. Rejected drafts can never be sent.",
```

Check `writeEmail`'s own description (~line 817-830) and the system prompt (`src/lib/system-prompt.ts:145-153`) for the same stale claim; align any that says ad-hoc drafts are born approved.

**Step 2: Block untrackable signals.** In `createTracking` and `bulkCreateTracking`, after resolving inputs, fetch the signal's `execution_type` and refuse:

```ts
const { data: signalRow } = await supabase
  .from("signals")
  .select("execution_type, name")
  .eq("id", input.signalId)
  .single();
if (signalRow?.execution_type === "agent_instructions") {
  throw new Error(
    `"${signalRow.name}" is an agent-instructions signal and cannot run on a schedule — it needs a live agent conversation. Pick an exa_search, tool_call, or browser_script signal for tracking.`,
  );
}
```

(`threshold_rules` was already dropped in Task 1's migration.)

**Step 3: Verify + commit**

```bash
pnpm typecheck && pnpm lint && pnpm test
git add -A
git commit -m "fix(tools): correct stale sendEmail description, block agent_instructions signals from tracking"
```

---

### Task 11: Consolidate the agent tools' send-and-advance path

**Files:**

- Modify: `src/lib/services/outreach-sender.ts` (new `sendDraftAndAdvance`)
- Modify: `src/lib/tools/email-tools.ts` (`sendEmail` ~line 949, `sendBulkEmails` ~line 1120)
- Existing tests must keep passing: `src/__tests__/email-tools-send.test.ts`, `src/__tests__/outreach-sender.test.ts`

`sendEmail` and `sendBulkEmails` each call `claimAndSendDraft` then hand-call `advanceEnrollmentForDraft` — two call sites maintaining one invariant (the comment at `outreach-sender.ts:440-441` records that both historically forgot the advance). Extract one helper.

**Step 1:** Read the exact call sites in `email-tools.ts` (the `claimAndSendDraft` + `advanceEnrollmentForDraft` pairs) and `advanceEnrollmentForDraft` in `outreach-sender.ts`. Then add to `outreach-sender.ts`:

```ts
/**
 * Send a draft and advance its enrollment — the composed operation the
 * agent's sendEmail/sendBulkEmails tools need. Exists so the
 * "send succeeded ⇒ enrollment advanced" invariant lives in one place
 * instead of being re-implemented at every tool call site.
 */
export async function sendDraftAndAdvance(
  supabase: SupabaseClient,
  draft: DraftForSend,
  sender: SenderConfig,
  trackMetadata?: Record<string, unknown>,
  opts?: { bypassSendWindow?: boolean },
): Promise<SendResult> {
  const result = await claimAndSendDraft(
    supabase,
    draft,
    sender,
    trackMetadata,
    opts,
  );
  if (result.ok) {
    await advanceEnrollmentForDraft(supabase, draft);
  }
  return result;
}
```

(Match the real signature/shape of the existing pair — if the tools do anything between send and advance, preserve it or fold it in.)

**Step 2:** Replace both call sites in `email-tools.ts` with `sendDraftAndAdvance(..., { bypassSendWindow: true })`, deleting the now-duplicated advance calls.

**Step 3: Verify + commit**

```bash
pnpm typecheck && pnpm test
```

Expected: `email-tools-send.test.ts` and `outreach-sender.test.ts` PASS unchanged — this is a pure refactor; if a test needed editing, the refactor changed behavior — stop and re-check.

```bash
git add -A
git commit -m "refactor(send): single sendDraftAndAdvance helper for agent tool call sites"
```

---

### Task 12: Full verification + PR

**Step 1: Full suite**

```bash
pnpm typecheck && pnpm lint && pnpm test
```

Expected: all green.

**Step 2: End-to-end local smoke test**

1. `supabase start` + `pnpm dev`.
2. Create an exa_search tracking config with an intent via chat → confirm baseline snapshot is generic-shaped.
3. Click run-now → confirm a second snapshot and, if results changed, a `tracking_changes` row with a real description.
4. Set a send window that excludes the current hour → approve a pending draft → confirm the followups cron defers it with the window message in `last_error`; send-now still sends immediately.
5. Toggle `auto_send` on a config (via `updateTracking` in chat), fake a high-confidence fire if practical, and confirm the draft lands approved with the audit marker in `ai_reasoning`.

**Step 3: Push and open PR**

```bash
git push -u origin feat/tracking-pipeline-fixes
gh pr create --base main --title "Signal pipeline: fix non-hiring signal firing, queue fairness, send windows, opt-in auto-send" --body "$(cat <<'EOF'
## Summary
- **P0:** non-hiring signals (exa_search, recipes, tool_call) produced empty hiring-shaped snapshots and could never fire outreach — snapshots are now execution-type-aware and reuse the executors' own diffs
- tracking jobs now carry the campaign owner's user_id (previously all shared the <system> queue partition, capping ALL tracking at ~300 runs/hour)
- blank tracking intents are rejected at creation and badged "observe only" in the UI
- manual "run now" for tracking configs (API route + table button)
- configurable send window (sender-local hours, wraps midnight), enforced in claimAndSendDraft, bypassed by explicit interactive sends
- opt-in auto-send: high-confidence fires on auto_send configs skip the review queue; all hard send gates still apply
- cleanups: stale sendEmail tool description, agent_instructions signals blocked from tracking, threshold_rules dropped, contacts-per-fire configurable (1-5), send+advance consolidated

## Deploy notes
⚠️ Contains a migration (`20260805000001_tracking_pipeline_fixes.sql`) — prod migrations are manual: `supabase db push` against the prod project.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```
