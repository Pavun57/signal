# Email Test Send + Reply Verification Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let a user send a test email from Settings → Email and watch the reply
land, proving the Gmail send + IMAP reply-matching round trip works before any
real prospect is touched.

**Architecture:** Four nullable `test_*` columns on `user_settings` hold the
single in-flight test — no new table, because nothing reads test history. All
matching logic is reused from `gmail-service.ts` unchanged: the test is fed to
`classifyInboundMessage` as a one-entry `pending` map, which gets bounce
detection for free. Pure helpers live in a new `email-test.ts` service so
cooldown and validation are unit-testable without HTTP.

**Tech Stack:** Next.js 16 App Router route handlers, Supabase (RLS via Clerk
`requesting_user_id()`), nodemailer + imapflow (already wired), Vitest, shadcn
UI primitives.

**Design doc:** `~/.claude/plans/2026-07-30-email-test-send-design.md`

---

## Background you need before starting

Read these first — the feature is mostly wiring existing pieces together:

- `src/lib/services/gmail-service.ts` — `sendGmailMessage`, `fetchInboundSince`,
  `classifyInboundMessage`. **Do not change the classifier's logic.**
- `src/app/api/settings/email/route.ts` — the `body.action` convention this new
  route mirrors.
- `src/app/api/email/track/route.ts` — how the cron builds its `pending` map.

Three constraints that are easy to get wrong:

1. **A test must never write a `sent_emails` row.** `campaign_people_id`,
   `campaign_id` and `person_id` are `not null` with FKs to real campaigns, and
   that table is what the warmup cap counts. A test row would both require a
   fake campaign and burn real quota (5/day on a fresh mailbox).
2. **The self-reply filter.** `classifyInboundMessage` drops inbound mail whose
   From equals the connected address (`gmail-service.ts:193`). A test sent to
   yourself can never resolve — the API must reject that up front with a clear
   message, not let the user watch a spinner forever.
3. **Never download bodies for non-daemon mail.** `fetchInboundSince` downloads
   only daemon bodies on purpose, and there is a regression test guarding the
   imapflow deadlock (`src/__tests__/gmail-imap.test.ts`). Envelope data is all
   this feature needs.

---

## Task 0: Branch

**Step 1: Cut a branch off main**

```bash
git checkout main
git checkout -b feat/email-test-send
```

Note: `ci/migrate-on-deploy` is a separate branch with the migration workflow.
Do not build on it.

---

## Task 1: Migration — four `test_*` columns

**Files:**

- Create: `supabase/migrations/20260730000002_email_test_send.sql`

**Step 1: Write the migration**

```sql
-- Diagnostic state for the Settings > Email "send test" button. Deliberately
-- columns on user_settings rather than a table: only one test is ever in
-- flight, and nothing reads test history. test_sent_at doubles as the
-- throttle clock; test_replied_at settles a test so it stops re-scanning
-- IMAP on every page load.
--
-- A test intentionally writes no sent_emails row, which keeps it invisible to
-- warmup cap counting, campaign stats and the reply-tracking cron.

alter table user_settings
  add column if not exists test_message_id text,
  add column if not exists test_to_email text,
  add column if not exists test_sent_at timestamptz,
  add column if not exists test_replied_at timestamptz;
```

No RLS changes — `user_settings` already carries owner-only policies keyed on
`requesting_user_id()`.

**Step 2: Apply locally**

```bash
npx supabase migration up --local
```

Expected: `Applying migration 20260730000002_email_test_send.sql...`

**Step 3: Verify the columns and PostgREST cache**

```bash
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
  -c "\d user_settings" | grep test_
```

Expected: all four `test_*` rows listed.

**Step 4: Commit**

```bash
git add supabase/migrations/20260730000002_email_test_send.sql
git commit -m "feat(email): add test_* columns to user_settings"
```

---

## Task 2: Add `subject` and `date` to `InboundSummary`

Additive only — the track route ignores both fields. Needed so the UI can show
"Reply received from X — 'Re: …' — 14:32" without downloading bodies.

**Files:**

- Modify: `src/lib/services/gmail-service.ts:103-108` and `:130-145`
- Test: `src/__tests__/gmail-imap.test.ts`

**Step 1: Write the failing test**

Append to the existing `describe` block in `src/__tests__/gmail-imap.test.ts`.
The fake in that file already yields envelopes; add `subject` and `date` to
both yielded envelopes first (`subject: "Re: Signal test"`, `date: new
Date("2026-07-30T14:32:00Z")`), then:

```ts
it("carries envelope subject and date through to the summary", async () => {
  const inbound = await fetchInboundSince(
    { address: "jay@sahnan.co", appPassword: "pw" },
    new Date(),
  );

  expect(inbound[1].subject).toBe("Re: Signal test");
  expect(inbound[1].date).toEqual(new Date("2026-07-30T14:32:00Z"));
});
```

**Step 2: Run it and watch it fail**

```bash
pnpm vitest run src/__tests__/gmail-imap.test.ts
```

Expected: FAIL — `subject` is `undefined`.

**Step 3: Implement**

Extend the interface:

```ts
export interface InboundSummary {
  fromAddress: string;
  inReplyTo: string | null;
  references: string[];
  bodyText: string;
  subject: string;
  date: Date | null;
}
```

And in the fetch loop, alongside the existing `results.push`:

```ts
results.push({
  fromAddress,
  inReplyTo: msg.envelope?.inReplyTo?.trim() || null,
  references: msg.headers?.toString().match(/<[^<>\s]+>/g) ?? [],
  bodyText: "",
  subject: msg.envelope?.subject ?? "",
  date: msg.envelope?.date ?? null,
});
```

**Step 4: Run the whole gmail suite**

```bash
pnpm vitest run src/__tests__/gmail-imap.test.ts src/__tests__/email-transport.test.ts
```

Expected: PASS, including the pre-existing deadlock-ordering test.

**Step 5: Commit**

```bash
git add src/lib/services/gmail-service.ts src/__tests__/gmail-imap.test.ts
git commit -m "feat(email): carry envelope subject and date on InboundSummary"
```

---

## Task 3: Pure helpers — recipient validation and cooldown

**Files:**

- Create: `src/lib/services/email-test.ts`
- Test: `src/__tests__/email-test.test.ts`

**Step 1: Write the failing tests**

```ts
import { describe, expect, it } from "vitest";

import {
  TEST_COOLDOWN_MS,
  checkTestCooldown,
  validateTestRecipient,
} from "@/lib/services/email-test";

describe("validateTestRecipient", () => {
  it("accepts a different address", () => {
    expect(
      validateTestRecipient("jaysahnan31@gmail.com", "jay@sahnan.co"),
    ).toEqual({ ok: true, to: "jaysahnan31@gmail.com" });
  });

  it("trims and lowercases", () => {
    expect(
      validateTestRecipient("  Jay31@GMAIL.com ", "jay@sahnan.co"),
    ).toEqual({ ok: true, to: "jay31@gmail.com" });
  });

  it("rejects the connected address regardless of case", () => {
    const result = validateTestRecipient("JAY@Sahnan.co", "jay@sahnan.co");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/different mailbox/i);
  });

  it("rejects a malformed address", () => {
    expect(validateTestRecipient("not-an-email", "jay@sahnan.co").ok).toBe(
      false,
    );
  });
});

describe("checkTestCooldown", () => {
  const now = new Date("2026-07-30T12:00:00Z");

  it("allows the first ever test", () => {
    expect(checkTestCooldown(null, now)).toEqual({ ok: true });
  });

  it("rejects at 59s and reports seconds remaining", () => {
    const last = new Date(now.getTime() - 59_000).toISOString();
    const result = checkTestCooldown(last, now);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.retryAfterSeconds).toBe(1);
  });

  it("allows at 61s", () => {
    const last = new Date(now.getTime() - 61_000).toISOString();
    expect(checkTestCooldown(last, now)).toEqual({ ok: true });
  });

  it("allows exactly at the boundary", () => {
    const last = new Date(now.getTime() - TEST_COOLDOWN_MS).toISOString();
    expect(checkTestCooldown(last, now)).toEqual({ ok: true });
  });
});
```

**Step 2: Run and watch it fail**

```bash
pnpm vitest run src/__tests__/email-test.test.ts
```

Expected: FAIL — module not found.

**Step 3: Implement**

```ts
import type { InboundSummary } from "@/lib/services/gmail-service";
import { classifyInboundMessage } from "@/lib/services/gmail-service";

/**
 * Diagnostic "send a test email" flow for Settings > Email. Pure helpers only
 * — the route owns IO so these stay unit-testable.
 */

/** One test a minute. Bounds a stuck retry loop to 60/hour, far under
 *  Gmail's ~500/day, without making the button feel sticky in normal use. */
export const TEST_COOLDOWN_MS = 60_000;

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export type Validation =
  | { ok: true; to: string }
  | { ok: false; error: string };

/**
 * A test sent to the connected address can never resolve: classifyInboundMessage
 * drops inbound mail from our own address so a reply from the same mailbox is
 * filtered out by design. Reject it here with an explanation rather than let
 * the user watch a spinner that will never settle.
 */
export function validateTestRecipient(
  raw: string,
  connectedAddress: string,
): Validation {
  const to = raw.trim().toLowerCase();
  if (!EMAIL_RE.test(to)) {
    return { ok: false, error: "Enter a valid email address." };
  }
  if (to === connectedAddress.trim().toLowerCase()) {
    return {
      ok: false,
      error:
        "Send the test to a different mailbox you own. Signal ignores replies from your own connected address, so a test to yourself can never show a reply.",
    };
  }
  return { ok: true, to };
}

export type Cooldown = { ok: true } | { ok: false; retryAfterSeconds: number };

export function checkTestCooldown(
  lastSentAt: string | null,
  now: Date = new Date(),
): Cooldown {
  if (!lastSentAt) return { ok: true };
  const elapsed = now.getTime() - new Date(lastSentAt).getTime();
  if (elapsed >= TEST_COOLDOWN_MS) return { ok: true };
  return {
    ok: false,
    retryAfterSeconds: Math.ceil((TEST_COOLDOWN_MS - elapsed) / 1000),
  };
}
```

**Step 4: Run and watch it pass**

```bash
pnpm vitest run src/__tests__/email-test.test.ts
```

Expected: PASS, 8 tests.

**Step 5: Commit**

```bash
git add src/lib/services/email-test.ts src/__tests__/email-test.test.ts
git commit -m "feat(email): add test recipient validation and send cooldown"
```

---

## Task 4: `matchTestReply` — reuse the classifier

**Files:**

- Modify: `src/lib/services/email-test.ts`
- Test: `src/__tests__/email-test.test.ts`

**Step 1: Write the failing tests**

```ts
import { matchTestReply } from "@/lib/services/email-test";

describe("matchTestReply", () => {
  const MSG_ID = "<test-1@sahnan.co>";
  const base = {
    inReplyTo: null,
    references: [],
    bodyText: "",
    subject: "",
    date: null,
  };

  it("matches a threaded reply and returns envelope details", () => {
    const inbound = [
      {
        ...base,
        fromAddress: "jaysahnan31@gmail.com",
        inReplyTo: MSG_ID,
        subject: "Re: Signal test",
        date: new Date("2026-07-30T14:32:00Z"),
      },
    ];

    expect(matchTestReply(inbound, MSG_ID, "jay@sahnan.co")).toEqual({
      status: "replied",
      fromAddress: "jaysahnan31@gmail.com",
      subject: "Re: Signal test",
      date: new Date("2026-07-30T14:32:00Z"),
    });
  });

  it("reports a daemon message as bounced", () => {
    const inbound = [
      {
        ...base,
        fromAddress: "mailer-daemon@googlemail.com",
        bodyText: `original message id ${MSG_ID}`,
        subject: "Delivery Status Notification (Failure)",
      },
    ];

    expect(matchTestReply(inbound, MSG_ID, "jay@sahnan.co")?.status).toBe(
      "bounced",
    );
  });

  it("ignores unrelated mail", () => {
    const inbound = [
      { ...base, fromAddress: "someone@example.com", inReplyTo: "<other@x>" },
    ];
    expect(matchTestReply(inbound, MSG_ID, "jay@sahnan.co")).toBeNull();
  });

  it("ignores a reply from our own address (self-reply filter)", () => {
    const inbound = [
      { ...base, fromAddress: "jay@sahnan.co", inReplyTo: MSG_ID },
    ];
    expect(matchTestReply(inbound, MSG_ID, "jay@sahnan.co")).toBeNull();
  });
});
```

**Step 2: Run and watch it fail**

```bash
pnpm vitest run src/__tests__/email-test.test.ts -t matchTestReply
```

Expected: FAIL — `matchTestReply` is not exported.

**Step 3: Implement**

```ts
export interface TestReply {
  status: "replied" | "bounced";
  fromAddress: string;
  subject: string;
  date: Date | null;
}

/**
 * Feeds the test's Message-ID to the shared classifier as a one-entry pending
 * map. Bounce detection comes along for free — a test aimed at a dead address
 * reports "bounced" rather than hanging as unanswered.
 */
export function matchTestReply(
  inbound: InboundSummary[],
  testMessageId: string,
  ourAddress: string,
): TestReply | null {
  const pending = new Map([[testMessageId, "test"]]);
  for (const message of inbound) {
    const hit = classifyInboundMessage(message, pending, ourAddress);
    if (!hit) continue;
    return {
      status: hit.status,
      fromAddress: message.fromAddress,
      subject: message.subject,
      date: message.date,
    };
  }
  return null;
}
```

**Step 4: Run the full suite**

```bash
pnpm vitest run
```

Expected: PASS, no regressions.

**Step 5: Commit**

```bash
git add src/lib/services/email-test.ts src/__tests__/email-test.test.ts
git commit -m "feat(email): match test replies via the shared inbound classifier"
```

---

## Task 5: API route

**Files:**

- Create: `src/app/api/settings/email/test/route.ts`

**Step 1: Write the route**

```ts
import { NextResponse } from "next/server";

import { decryptSecret } from "@/lib/crypto";
import {
  checkTestCooldown,
  matchTestReply,
  validateTestRecipient,
} from "@/lib/services/email-test";
import {
  fetchInboundSince,
  sendGmailMessage,
} from "@/lib/services/gmail-service";
import { getSupabaseAndUser } from "@/lib/supabase/server";

// The IMAP socket timeout is 60s, so the settings route's 30 is not enough
// for a check that has to connect, fetch and log out.
export const maxDuration = 60;

const TEST_SUBJECT = "Signal test send";

const SELECT =
  "gmail_address, gmail_app_password_enc, from_name, reply_to_email, test_message_id, test_to_email, test_sent_at, test_replied_at";

type Settings = {
  gmail_address: string | null;
  gmail_app_password_enc: string | null;
  from_name: string | null;
  reply_to_email: string | null;
  test_message_id: string | null;
  test_to_email: string | null;
  test_sent_at: string | null;
  test_replied_at: string | null;
};

function testState(settings: Settings) {
  return {
    to_email: settings.test_to_email,
    sent_at: settings.test_sent_at,
    replied_at: settings.test_replied_at,
  };
}

export async function GET() {
  const ctx = await getSupabaseAndUser();
  if (!ctx)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { supabase, user } = ctx;

  const { data } = await supabase
    .from("user_settings")
    .select(SELECT)
    .eq("user_id", user.id)
    .maybeSingle();

  const settings = (data ?? null) as Settings | null;
  const connected = settings?.gmail_address ?? null;

  // Pre-fill with something that is definitely NOT the connected address,
  // since a test to yourself can never resolve.
  const candidate = settings?.reply_to_email || user.email || "";
  const suggested =
    candidate.toLowerCase() === (connected ?? "").toLowerCase()
      ? ""
      : candidate;

  return NextResponse.json({
    connected,
    suggested_to: settings?.test_to_email || suggested,
    test: settings ? testState(settings) : null,
  });
}

export async function POST(request: Request) {
  const ctx = await getSupabaseAndUser();
  if (!ctx)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { supabase, user } = ctx;
  const body = await request.json();

  const { data } = await supabase
    .from("user_settings")
    .select(SELECT)
    .eq("user_id", user.id)
    .maybeSingle();
  const settings = (data ?? null) as Settings | null;

  if (!settings?.gmail_address || !settings.gmail_app_password_enc) {
    return NextResponse.json(
      { error: "Connect a Gmail mailbox before sending a test." },
      { status: 400 },
    );
  }

  let appPassword: string;
  try {
    appPassword = decryptSecret(settings.gmail_app_password_enc);
  } catch {
    return NextResponse.json(
      {
        error:
          "Stored credential could not be decrypted. Reconnect your mailbox in Settings > Email.",
      },
      { status: 400 },
    );
  }
  const creds = { address: settings.gmail_address, appPassword };

  if (body.action === "send") {
    const valid = validateTestRecipient(
      typeof body.to === "string" ? body.to : "",
      settings.gmail_address,
    );
    if (!valid.ok) {
      return NextResponse.json({ error: valid.error }, { status: 400 });
    }

    const cooldown = checkTestCooldown(settings.test_sent_at);
    if (!cooldown.ok) {
      return NextResponse.json(
        {
          error: `Wait ${cooldown.retryAfterSeconds}s before sending another test.`,
        },
        {
          status: 429,
          headers: { "Retry-After": String(cooldown.retryAfterSeconds) },
        },
      );
    }

    let messageId: string;
    try {
      // Deliberately writes no sent_emails row: a test must stay invisible to
      // warmup cap counting, campaign stats and the reply-tracking cron.
      const sent = await sendGmailMessage(creds, {
        fromName: settings.from_name,
        to: valid.to,
        subject: TEST_SUBJECT,
        html: "<p>This is a test send from Signal. Reply to this email and Signal should detect your reply within a minute.</p>",
        text: "This is a test send from Signal. Reply to this email and Signal should detect your reply within a minute.",
        replyTo: settings.reply_to_email ?? undefined,
      });
      messageId = sent.messageId;
    } catch (err) {
      const message = err instanceof Error ? err.message : "SMTP send failed";
      return NextResponse.json({ error: message }, { status: 502 });
    }

    const sentAt = new Date().toISOString();
    await supabase
      .from("user_settings")
      .update({
        test_message_id: messageId,
        test_to_email: valid.to,
        test_sent_at: sentAt,
        test_replied_at: null,
        updated_at: sentAt,
      })
      .eq("user_id", user.id);

    return NextResponse.json({
      sent: true,
      test: { to_email: valid.to, sent_at: sentAt, replied_at: null },
    });
  }

  if (body.action === "check") {
    if (!settings.test_message_id || !settings.test_sent_at) {
      return NextResponse.json(
        { error: "No test send to check." },
        { status: 400 },
      );
    }
    // Already settled — never re-scan IMAP for a finished test.
    if (settings.test_replied_at) {
      return NextResponse.json({
        status: "replied",
        test: testState(settings),
      });
    }

    let inbound;
    try {
      inbound = await fetchInboundSince(creds, new Date(settings.test_sent_at));
    } catch {
      // Soft failure: the UI keeps waiting and polling rather than showing
      // the test as broken because one IMAP connect blipped.
      return NextResponse.json({
        status: "waiting",
        warning: "Could not reach Gmail over IMAP — will retry.",
        test: testState(settings),
      });
    }

    const hit = matchTestReply(
      inbound,
      settings.test_message_id,
      settings.gmail_address,
    );
    if (!hit) {
      return NextResponse.json({
        status: "waiting",
        test: testState(settings),
      });
    }

    const repliedAt = (hit.date ?? new Date()).toISOString();
    await supabase
      .from("user_settings")
      .update({
        test_replied_at: repliedAt,
        updated_at: new Date().toISOString(),
      })
      .eq("user_id", user.id);

    return NextResponse.json({
      status: hit.status,
      reply: {
        from: hit.fromAddress,
        subject: hit.subject,
        at: repliedAt,
      },
      test: { ...testState(settings), replied_at: repliedAt },
    });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
```

**Step 2: Typecheck**

```bash
pnpm typecheck
```

Expected: no errors.

**Step 3: Commit**

```bash
git add src/app/api/settings/email/test/route.ts
git commit -m "feat(email): add test send and reply check endpoints"
```

---

## Task 6: UI — test card with bounded polling

**Files:**

- Modify: `src/components/settings/email-settings.tsx`

**Step 1: Add state and polling**

Add near the other `useState` declarations:

```tsx
const [testTo, setTestTo] = useState("");
const [testSending, setTestSending] = useState(false);
const [testStatus, setTestStatus] = useState<
  "idle" | "waiting" | "replied" | "bounced"
>("idle");
const [testReply, setTestReply] = useState<{
  from: string;
  subject: string;
  at: string;
} | null>(null);
const [polling, setPolling] = useState(false);

const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
const attemptsRef = useRef(0);
```

Polling constants and helpers — 20s × 15 attempts is five minutes:

```tsx
const POLL_MS = 20_000;
const MAX_POLLS = 15;

const stopPolling = () => {
  if (pollRef.current) clearInterval(pollRef.current);
  pollRef.current = null;
  attemptsRef.current = 0;
  setPolling(false);
};

const checkTest = async () => {
  try {
    const res = await apiFetch("/api/settings/email/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "check" }),
    });
    const data = await res.json();
    if (!res.ok || !mountedRef.current) return;

    if (data.status === "replied" || data.status === "bounced") {
      setTestStatus(data.status);
      setTestReply(data.reply ?? null);
      stopPolling();
    }
  } catch {
    // Soft — keep polling.
  }
};

const startPolling = () => {
  stopPolling();
  setPolling(true);
  attemptsRef.current = 0;
  pollRef.current = setInterval(() => {
    attemptsRef.current += 1;
    if (attemptsRef.current > MAX_POLLS) {
      stopPolling();
      return;
    }
    void checkTest();
  }, POLL_MS);
};
```

Clear the interval on unmount — extend the existing cleanup in the mount
`useEffect` (line 67-69):

```tsx
return () => {
  mountedRef.current = false;
  if (pollRef.current) clearInterval(pollRef.current);
};
```

**Step 2: Add the send handler**

```tsx
const handleSendTest = async () => {
  setTestSending(true);
  try {
    const res = await apiFetch("/api/settings/email/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "send", to: testTo.trim() }),
    });
    const data = await res.json();
    if (!res.ok) {
      toast.error(data.error ?? "Failed to send test");
      return;
    }
    toast.success(`Test sent to ${data.test.to_email}`);
    setTestStatus("waiting");
    setTestReply(null);
    startPolling();
  } catch {
    toast.error("Failed to send test");
  } finally {
    setTestSending(false);
  }
};
```

**Step 3: Prefill the recipient**

In `load()`, after the existing `setDailyLimit(...)` call:

```tsx
const testRes = await apiFetch("/api/settings/email/test");
if (testRes.ok && mountedRef.current) {
  const testData = await testRes.json();
  setTestTo(testData.suggested_to ?? "");
  if (testData.test?.replied_at) setTestStatus("replied");
}
```

**Step 4: Render the card**

Insert inside the `gmailAddress ? (...)` connected branch, after the Disconnect
button (around line 197):

```tsx
<div className="border-border mt-4 space-y-2 rounded-md border p-3">
  <p className="text-sm font-medium">Send a test</p>
  <p className="text-muted-foreground text-xs">
    Sends one email and watches for your reply. Use a different mailbox you own
    — Signal ignores replies from {gmailAddress}, so a test to yourself will
    never show a reply. Test sends don&apos;t count against your daily limit.
  </p>
  <div className="flex gap-2">
    <Input
      type="email"
      placeholder="you@somewhere-else.com"
      value={testTo}
      onChange={(e) => setTestTo(e.target.value)}
      disabled={testSending}
    />
    <Button onClick={handleSendTest} disabled={testSending || !testTo.trim()}>
      {testSending ? "Sending..." : "Send test"}
    </Button>
  </div>

  {testStatus === "waiting" && (
    <div className="text-muted-foreground flex items-center gap-2 text-xs">
      <span>
        {polling
          ? "Sent — reply to it and this will update within ~20s."
          : "Still no reply detected."}
      </span>
      {!polling && (
        <Button variant="outline" size="sm" onClick={() => void checkTest()}>
          Check now
        </Button>
      )}
    </div>
  )}

  {testStatus === "replied" && testReply && (
    <p className="text-success text-xs">
      Reply received from {testReply.from} — &quot;{testReply.subject}&quot; at{" "}
      {new Date(testReply.at).toLocaleTimeString()}. Reply tracking is working.
    </p>
  )}

  {testStatus === "bounced" && (
    <p className="text-destructive text-xs">
      That address bounced. Sending works — the recipient rejected it.
    </p>
  )}
</div>
```

**Step 5: Lint and typecheck**

```bash
pnpm lint && pnpm typecheck
```

Expected: no new errors (12 pre-existing warnings are unrelated).

**Step 6: Commit**

```bash
git add src/components/settings/email-settings.tsx
git commit -m "feat(email): add test send card with bounded reply polling"
```

---

## Task 7: Manual end-to-end verification

Unit tests cover the pure logic; this proves the wiring. Requires a real
connected mailbox.

**Step 1: Run the app**

```bash
pnpm dev
```

**Step 2: Walk the happy path**

1. Settings → Email, confirm the test card renders under the connected mailbox.
2. Enter a second address you own, click **Send test**.
3. Confirm the email arrives, and that the From name matches your From Name.
4. Reply from that mailbox.
5. Within ~20s the card should read "Reply received from … Reply tracking is
   working."

**Step 3: Walk the failure paths**

- Enter the connected address → immediate 400 explaining the self-reply filter.
- Click **Send test** twice inside a minute → 429 with seconds remaining.
- Send to `nonexistent@gmail.com` → resolves as **bounced**.

**Step 4: Confirm the test did not touch quota**

```bash
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
  -c "select count(*) from sent_emails where sent_at > now() - interval '1 hour';"
```

Expected: unchanged by the test sends.

---

## Task 8: Open the PR

```bash
git push -u origin feat/email-test-send
gh pr create --title "feat(email): test send with reply verification" --body "..."
```

Note in the PR body that `supabase/migrations/20260730000002_email_test_send.sql`
will be applied to production automatically **once `ci/migrate-on-deploy` is
merged and the three Supabase secrets are set**. Until then it needs a manual
`npx supabase db push`.

---

## Out of scope

- Test history / deliverability trends
- Reply body text (would mean downloading non-daemon bodies on the shared path)
- Testing multiple mailboxes at once
