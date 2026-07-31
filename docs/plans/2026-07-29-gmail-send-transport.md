# Gmail Send Transport (App-Password SMTP/IMAP) + AgentMail Removal — Plan v3

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make a user's own Gmail / Google Workspace mailbox (connected via app password) Signal's one and only email transport — hosted users and self-hosters alike — with reply/bounce tracking over IMAP, a warmup-aware send ramp, and AgentMail removed from the codebase.

**Architecture:** Users paste a Google **app password** (2FA-gated), which Signal verifies live (SMTP + IMAP logins), encrypts with AES-256-GCM under a server key, and stores per-user in `user_settings`. Works for arbitrary hosted signups with no Google OAuth app, no CASA verification, no GCP setup. Sending goes over Gmail SMTP via nodemailer; reply/bounce tracking polls Gmail IMAP inside the existing QStash tracking route (push webhooks are gone with AgentMail — reply latency equals the poll cadence). `claimAndSendDraft` stays the single choke point, now enforcing a daily cap and a mailbox-age ramp (5→10→20→cap over 14 days). A small `resolveSenderConfig` seam keeps future transports (OAuth, Instantly) pluggable without a union today (YAGNI). AgentMail is deleted **last** so every commit on the branch has a working transport — code AND columns go (per product decision: no AgentMail history worth preserving; `agentmail_message_id` is renamed to the provider-neutral `message_id`).

**Tech Stack:** Next.js 16 App Router, Supabase (Postgres + RLS), Clerk, nodemailer (SMTP), imapflow (IMAP), node:crypto (AES-256-GCM), Vitest, QStash.

**Branch:** create `feat/gmail-send-transport` off **`origin/main`** — NOT local `main` (one merge behind origin) and NOT the current working tree. ⚠️ The entire voice-profiles feature sits **staged and uncommitted** on `feat/email-voice-profiles` (32 files, +2,433/−1,376; no upstream, no PR). Commit and push that first, or the dirty tree follows the checkout. The `20260730000000` migration below has no dependency on `20260729000000_email_voice_profiles.sql`, so the branches can merge in either order.

---

## User journey (hosted, end-to-end)

1. Settings → Email: enable 2-Step Verification → Google Account → Security → App passwords → generate → paste address + 16-char password into Signal (~3 minutes, any Google account).
2. Signal verifies the credentials live (distinct SMTP vs IMAP error messages) before saving; stores the password encrypted.
3. Mailbox enters its ramp: sends capped by mailbox age; UI shows "Day N — limit X/day".
4. Campaign sends go out through the user's own Gmail; replies land in their real inbox; the tracking cron reads them via IMAP and updates statuses; a reply or bounce halts the sequence.
5. External warmup pool (MailReach et al.) runs alongside, outside Signal — vendor-API integration is future work.

## Env prerequisites (deployment-wide, one-time)

- `EMAIL_CREDENTIALS_KEY` — 32-byte base64 key for encrypting stored app passwords: `openssl rand -base64 32`.
- No Google Cloud configuration of any kind. After this plan, `AGENTMAIL_API_KEY` / `AGENTMAIL_WEBHOOK_SECRET` are gone.

---

## Phase 1 — prerequisite fixes (campaign-blocking bugs found in the 2026-07-29 code review)

Pre-existing defects that break the campaign regardless of transport. Fix these first, each as its own commit.

### Task P1: QStash signature verification — empty bodies and URL binding

**File:** `src/lib/services/qstash.ts:42-52`

- `JSON.parse(body)` throws on the empty body that a console-created QStash _schedule_ sends — so `/api/email/track`, `/api/email/cleanup`, and `/api/tracking/dispatch` 401 on every scheduled run (tracking and cleanup are likely dead in production right now). Return `null` for an empty/whitespace body instead of parsing.
- `receiver.verify({ signature, body })` omits `url`, so a signed request captured for one public route replays against any other — including `/api/outreach/process`, which sends real email. Pass the destination URL (check `@upstash/qstash` Receiver docs for the param name; reconstruct from `getBaseUrl()` + pathname if the proxy rewrites hosts).
- Test: new `src/__tests__/qstash-verify.test.ts` mocking `@upstash/qstash`'s `Receiver`: (a) empty body → verifies, returns null, no throw; (b) valid JSON body → parsed object; (c) verify receives the url.

Commit: `fix(qstash): accept empty schedule bodies, bind signatures to URLs`

### Task P2: approved sequence drafts are never sent automatically

**File:** `src/app/api/outreach/process/route.ts` (followups handler ~:426-503, `SKIP_STATUSES` :197, `sendStepEmail` :522-534)

Bulk-approving drafts leads nowhere: `pickAndDraft` leaves enrollments at `status='waiting'`, the same-request send loop finds the draft still pending, and the followups query only selects `status='active'` — only the per-draft "Send now" button actually sends. Fixes:

1. Extend the followups handler to also select enrollments `status='waiting'` whose current-step draft is `review_status='approved' AND status='draft'`, and send via the existing `sendApprovedDraft`.
2. Stop discarding failure reasons in `sendStepEmail` — log `result.reason` and return per-reason counts in the response body so capped/failed sends are visible in QStash logs.
3. Widen `SKIP_STATUSES` to `['sent','queued','delivered','opened','clicked','replied','bounced','complained']` so a second signal fire can't re-draft to already-contacted people.

Test: new `src/__tests__/outreach-process-followups.test.ts` using the repo's fakeSupabase pattern: waiting enrollment + approved draft → sent; waiting + pending draft → skipped; contact with status `sent` → not re-picked.

Commit: `fix(outreach): send bulk-approved drafts, surface send failures, widen re-contact skip`

### Task P3: send-now can send a different draft than the one clicked

**File:** `src/app/api/outreach/send-now/route.ts:83-115`

The route validates `body.draftId` but hands only the enrollment to `sendApprovedDraft`, which re-resolves the draft from `enrollment.current_step` — clicking Send on a step-2 draft while the enrollment sits at step 1 silently sends the step-1 draft and reports success. After loading the enrollment, resolve the step for `enrollment.current_step` and require the requested draft's `sequence_step_id` to match; return 409 otherwise.

Test: fakeSupabase sequence asserting the mismatch path returns 409 and no send occurs.

Commit: `fix(outreach): send-now refuses drafts that don't match the enrollment step`

---

## Phase 2 — Gmail transport

### Task 1: Dependencies

**Step 1:** `pnpm add nodemailer imapflow && pnpm add -D @types/nodemailer`
(Do NOT remove the `agentmail` dep yet — removal is Task 11 so the branch always builds with a working transport.)

**Step 2:** `pnpm typecheck` → passes.

**Step 3:**

```bash
git add package.json pnpm-lock.yaml
git commit -m "chore: add nodemailer + imapflow for gmail transport"
```

---

### Task 2: Schema migration

**Files:**

- Create: `supabase/migrations/20260730000000_gmail_transport.sql`

**Step 1: Write the migration**

```sql
-- Gmail (app-password SMTP/IMAP) becomes the sole email transport and
-- AgentMail is removed entirely, columns included. agentmail_message_id is
-- renamed to the provider-neutral message_id (now the RFC 5322 Message-ID of
-- the sent mail — replies reference it via In-Reply-To/References, which is
-- how IMAP tracking matches them). Old rows keep their ids in that column;
-- nothing reads them anymore.

alter table user_settings
  drop column if exists agentmail_inbox_id,
  add column if not exists gmail_address text,
  add column if not exists gmail_app_password_enc text,
  add column if not exists gmail_connected_at timestamptz,
  add column if not exists daily_send_limit integer not null default 30
    check (daily_send_limit between 1 and 500);

alter table sent_emails rename column agentmail_message_id to message_id;
alter table sent_emails alter column message_id drop not null;
drop index if exists idx_sent_emails_thread;
alter table sent_emails drop column if exists agentmail_thread_id;

-- Daily-cap check counts a user's sends since midnight UTC.
create index if not exists idx_sent_emails_user_sent_at
  on sent_emails(user_id, sent_at);
```

Notes: no `email_provider` or `provider` column — Gmail is the only transport, so "configured" = `gmail_address` present. The rename keeps the inline `unique` constraint from the original column (nulls permitted after dropping not-null). Dropping `agentmail_inbox_id` and `agentmail_thread_id` is deliberate per product decision 2026-07-29: this deployment has no AgentMail send history worth preserving. `gmail_app_password_enc` is readable only by its owner (existing owner-only RLS) and the service role.

**Step 2:** Apply with `supabase migration up` (NOT `db reset` — it wipes the seeded signals). Verify with `\d user_settings`.

**Step 3:**

```bash
git add supabase/migrations/20260730000000_gmail_transport.sql
git commit -m "feat(db): gmail transport columns; agentmail ids become historical"
```

---

### Task 3: Secret encryption helper (TDD)

Hosted mode stores _other people's_ Gmail credentials — plaintext at rest is not acceptable. This is the codebase's first encrypted-at-rest column (verified: no cipher code exists today).

**Files:**

- Create: `src/lib/crypto.ts`
- Test: `src/__tests__/crypto.test.ts`

**Step 1: Write the failing tests**

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { decryptSecret, encryptSecret } from "@/lib/crypto";

describe("secret encryption", () => {
  beforeEach(() => {
    process.env.EMAIL_CREDENTIALS_KEY = Buffer.alloc(32, 7).toString("base64");
  });
  afterEach(() => {
    delete process.env.EMAIL_CREDENTIALS_KEY;
  });

  it("round-trips", () => {
    const enc = encryptSecret("abcd efgh ijkl mnop");
    expect(enc).not.toContain("abcd");
    expect(decryptSecret(enc)).toBe("abcd efgh ijkl mnop");
  });

  it("produces a different ciphertext each call (random IV)", () => {
    expect(encryptSecret("x")).not.toBe(encryptSecret("x"));
  });

  it("rejects tampered ciphertext", () => {
    const enc = encryptSecret("secret");
    const parts = enc.split(".");
    parts[2] = parts[2].slice(0, -2) + "AA";
    expect(() => decryptSecret(parts.join("."))).toThrow();
  });

  it("throws a clear error when the key is missing", () => {
    delete process.env.EMAIL_CREDENTIALS_KEY;
    expect(() => encryptSecret("x")).toThrow(/EMAIL_CREDENTIALS_KEY/);
  });
});
```

**Step 2:** `pnpm test src/__tests__/crypto.test.ts` → FAIL (module not found).

**Step 3: Implement `src/lib/crypto.ts`**

```ts
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

function getKey(): Buffer {
  const raw = process.env.EMAIL_CREDENTIALS_KEY;
  if (!raw) {
    throw new Error(
      "EMAIL_CREDENTIALS_KEY is not set. Generate one with `openssl rand -base64 32` and add it to .env.local.",
    );
  }
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error("EMAIL_CREDENTIALS_KEY must be 32 bytes, base64-encoded.");
  }
  return key;
}

/** AES-256-GCM. Format: base64(iv).base64(ciphertext).base64(authTag) */
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getKey(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [
    iv.toString("base64"),
    enc.toString("base64"),
    cipher.getAuthTag().toString("base64"),
  ].join(".");
}

export function decryptSecret(encoded: string): string {
  const [ivB64, dataB64, tagB64] = encoded.split(".");
  if (!ivB64 || !dataB64 || !tagB64) throw new Error("Malformed secret");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    getKey(),
    Buffer.from(ivB64, "base64"),
  );
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, "base64")),
    decipher.final(),
  ]).toString("utf8");
}
```

**Step 4:** `pnpm test src/__tests__/crypto.test.ts` → PASS.

**Step 5:**

```bash
git add src/lib/crypto.ts src/__tests__/crypto.test.ts
git commit -m "feat: AES-256-GCM helper for stored email credentials"
```

---

### Task 4: `gmail-service.ts` — SMTP send, IMAP read, classification, ramp (TDD on pure parts)

**Files:**

- Create: `src/lib/services/gmail-service.ts`
- Test: `src/__tests__/gmail-service.test.ts`

**Step 1: Write the failing tests** — exactly the `classifyInboundMessage` and `getEffectiveDailyLimit` suites below. (Vitest runs jsdom globally; Node builtins work, but if importing the service misbehaves under jsdom, put `// @vitest-environment node` on line 1 of the test file.)

```ts
import { describe, expect, it } from "vitest";

import {
  classifyInboundMessage,
  getEffectiveDailyLimit,
} from "@/lib/services/gmail-service";

describe("classifyInboundMessage", () => {
  const pending = new Map([
    ["<sent-1@sahnan.co>", "email_row_1"],
    ["<sent-2@sahnan.co>", "email_row_2"],
  ]);

  it("matches a reply by In-Reply-To", () => {
    expect(
      classifyInboundMessage(
        {
          fromAddress: "prospect@example.com",
          inReplyTo: "<sent-1@sahnan.co>",
          references: [],
          bodyText: "",
        },
        pending,
        "jay@sahnan.co",
      ),
    ).toEqual({ status: "replied", sentEmailId: "email_row_1" });
  });

  it("matches a reply by References when In-Reply-To is absent", () => {
    expect(
      classifyInboundMessage(
        {
          fromAddress: "prospect@example.com",
          inReplyTo: null,
          references: ["<other@x>", "<sent-2@sahnan.co>"],
          bodyText: "",
        },
        pending,
        "jay@sahnan.co",
      ),
    ).toEqual({ status: "replied", sentEmailId: "email_row_2" });
  });

  it("classifies a mailer-daemon message referencing a sent id as a bounce", () => {
    expect(
      classifyInboundMessage(
        {
          fromAddress: "mailer-daemon@googlemail.com",
          inReplyTo: "<sent-1@sahnan.co>",
          references: [],
          bodyText: "Address not found",
        },
        pending,
        "jay@sahnan.co",
      ),
    ).toEqual({ status: "bounced", sentEmailId: "email_row_1" });
  });

  it("matches a daemon bounce by Message-ID appearing in the body", () => {
    expect(
      classifyInboundMessage(
        {
          fromAddress: "Mail Delivery Subsystem <mailer-daemon@googlemail.com>",
          inReplyTo: null,
          references: [],
          bodyText: "The response was: 550 ... Message-ID: <sent-2@sahnan.co>",
        },
        pending,
        "jay@sahnan.co",
      ),
    ).toEqual({ status: "bounced", sentEmailId: "email_row_2" });
  });

  it("ignores our own messages and unrelated mail", () => {
    expect(
      classifyInboundMessage(
        {
          fromAddress: "jay@sahnan.co",
          inReplyTo: "<sent-1@sahnan.co>",
          references: [],
          bodyText: "",
        },
        pending,
        "jay@sahnan.co",
      ),
    ).toBeNull();
    expect(
      classifyInboundMessage(
        {
          fromAddress: "newsletter@stuff.com",
          inReplyTo: null,
          references: [],
          bodyText: "hello",
        },
        pending,
        "jay@sahnan.co",
      ),
    ).toBeNull();
  });
});

describe("getEffectiveDailyLimit", () => {
  const cap = 30;
  const daysAgo = (n: number) =>
    new Date(Date.now() - n * 86400_000).toISOString();

  it("ramps by mailbox age: 5 → 10 → 20 → cap", () => {
    expect(getEffectiveDailyLimit(daysAgo(0), cap)).toBe(5);
    expect(getEffectiveDailyLimit(daysAgo(2), cap)).toBe(5);
    expect(getEffectiveDailyLimit(daysAgo(3), cap)).toBe(10);
    expect(getEffectiveDailyLimit(daysAgo(7), cap)).toBe(20);
    expect(getEffectiveDailyLimit(daysAgo(14), cap)).toBe(cap);
  });

  it("never exceeds the user's configured cap", () => {
    expect(getEffectiveDailyLimit(daysAgo(5), 8)).toBe(8);
  });

  it("treats an unknown connect date as fully ramped", () => {
    expect(getEffectiveDailyLimit(null, cap)).toBe(cap);
  });
});
```

**Step 2:** Run → FAIL (module not found).

**Step 3: Implement `src/lib/services/gmail-service.ts`**

```ts
import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";

export interface GmailCreds {
  address: string;
  appPassword: string;
}

function smtpTransport(creds: GmailCreds) {
  return nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: { user: creds.address, pass: creds.appPassword },
  });
}

/**
 * Live credential check used before saving settings: SMTP AUTH + IMAP login.
 * Returns an error string instead of throwing so the settings route can 400.
 */
export async function verifyGmailCredentials(
  creds: GmailCreds,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await smtpTransport(creds).verify();
  } catch {
    return {
      ok: false,
      error:
        "SMTP login failed. Check the address and app password (requires 2-Step Verification; spaces in the app password are fine).",
    };
  }
  try {
    const imap = imapClient(creds);
    await imap.connect();
    await imap.logout();
  } catch {
    return {
      ok: false,
      error: "IMAP login failed. Enable IMAP in Gmail settings.",
    };
  }
  return { ok: true };
}

export async function sendGmailMessage(
  creds: GmailCreds,
  params: {
    fromName?: string | null;
    to: string;
    subject: string;
    html: string;
    text?: string;
    replyTo?: string;
    inReplyTo?: string;
  },
): Promise<{ messageId: string }> {
  const info = await smtpTransport(creds).sendMail({
    from: params.fromName
      ? { name: params.fromName, address: creds.address }
      : creds.address,
    to: params.to,
    subject: params.subject,
    html: params.html,
    text: params.text,
    replyTo: params.replyTo,
    inReplyTo: params.inReplyTo,
    references: params.inReplyTo,
  });
  return { messageId: info.messageId };
}

// ── IMAP reply/bounce polling ───────────────────────────────────────────────

function imapClient(creds: GmailCreds) {
  return new ImapFlow({
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    auth: { user: creds.address, pass: creds.appPassword },
    logger: false,
  });
}

export interface InboundSummary {
  fromAddress: string;
  inReplyTo: string | null;
  references: string[];
  bodyText: string;
}

/**
 * Fetches inbound mail since `since` as InboundSummary rows. Only daemon
 * messages get their body downloaded (needed to match bounces to sends);
 * everything else is envelope-only.
 */
export async function fetchInboundSince(
  creds: GmailCreds,
  since: Date,
): Promise<InboundSummary[]> {
  const imap = imapClient(creds);
  await imap.connect();
  const results: InboundSummary[] = [];
  try {
    const lock = await imap.getMailboxLock("INBOX");
    try {
      for await (const msg of imap.fetch(
        { since },
        { envelope: true, headers: ["references"] },
      )) {
        const fromAddress = msg.envelope?.from?.[0]?.address ?? "";
        const isDaemon = /mailer-daemon|postmaster/i.test(fromAddress);
        let bodyText = "";
        if (isDaemon) {
          const dl = await imap.download(String(msg.uid), undefined, {
            uid: true,
          });
          bodyText = dl
            ? (await streamToString(dl.content)).slice(0, 20_000)
            : "";
        }
        results.push({
          fromAddress,
          inReplyTo: msg.envelope?.inReplyTo?.trim() || null,
          references: msg.headers?.toString().match(/<[^<>\s]+>/g) ?? [],
          bodyText,
        });
      }
    } finally {
      lock.release();
    }
  } finally {
    await imap.logout().catch(() => {});
  }
  return results;
}

async function streamToString(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

// ── Pure classification ─────────────────────────────────────────────────────

/**
 * Maps one inbound message to a status for one of our pending sends.
 * `pending` maps RFC Message-ID → sent_emails.id. A daemon message is a
 * bounce; anything else from a third party referencing our id is a reply.
 */
export function classifyInboundMessage(
  message: InboundSummary,
  pending: Map<string, string>,
  ourAddress: string,
): { status: "replied" | "bounced"; sentEmailId: string } | null {
  const from = message.fromAddress.toLowerCase();
  if (!from || from.includes(ourAddress.toLowerCase())) return null;

  const isDaemon = /mailer-daemon|postmaster|mail delivery subsystem/.test(
    from,
  );

  const referenced = [message.inReplyTo, ...message.references].filter(
    (id): id is string => !!id,
  );
  let sentEmailId =
    referenced.map((id) => pending.get(id)).find(Boolean) ?? null;

  if (!sentEmailId && isDaemon) {
    for (const [msgId, rowId] of pending) {
      if (message.bodyText.includes(msgId)) {
        sentEmailId = rowId;
        break;
      }
    }
  }
  if (!sentEmailId) return null;

  return { status: isDaemon ? "bounced" : "replied", sentEmailId };
}

// ── Warmup ramp (pure) ──────────────────────────────────────────────────────

/**
 * Warmup-aware daily limit: fresh mailboxes ramp 5 → 10 → 20 → cap over two
 * weeks. Null connect date (legacy rows) means fully ramped.
 */
export function getEffectiveDailyLimit(
  connectedAt: string | null,
  configuredLimit: number,
): number {
  if (!connectedAt) return configuredLimit;
  const days = (Date.now() - new Date(connectedAt).getTime()) / 86400_000;
  let rampCap: number;
  if (days < 3) rampCap = 5;
  else if (days < 7) rampCap = 10;
  else if (days < 14) rampCap = 20;
  else rampCap = configuredLimit;
  return Math.min(rampCap, configuredLimit);
}
```

Executor note: verify imapflow's fetch/headers API against its docs when wiring `fetchInboundSince` — the pure classifier is the tested contract; the IMAP plumbing is validated in the manual E2E (Task 12). If `envelope.inReplyTo` proves unreliable, fetch the `In-Reply-To` header explicitly.

**Step 4:** Run → PASS.

**Step 5:**

```bash
git add src/lib/services/gmail-service.ts src/__tests__/gmail-service.test.ts
git commit -m "feat(email): gmail SMTP/IMAP service — send, verify, classify, ramp"
```

---

### Task 5: `email-transport.ts` — sender resolution (TDD)

Single place a user's send identity is resolved. No provider union — Gmail is the only transport; the seam is the function, which future transports can widen.

**Files:**

- Create: `src/lib/services/email-transport.ts`
- Test: `src/__tests__/email-transport.test.ts`

**Step 1: Write the failing tests**

```ts
import { beforeEach, describe, expect, it } from "vitest";

import { encryptSecret } from "@/lib/crypto";
import { resolveSenderConfig } from "@/lib/services/email-transport";

function fakeSupabase(row: unknown) {
  const builder: Record<string, unknown> = {};
  for (const name of ["select", "eq", "maybeSingle"]) {
    builder[name] = () => builder;
  }
  builder.then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve({ data: row, error: null }).then(resolve);
  return { from: () => builder } as never;
}

beforeEach(() => {
  process.env.EMAIL_CREDENTIALS_KEY = Buffer.alloc(32, 7).toString("base64");
});

describe("resolveSenderConfig", () => {
  it("resolves a connected gmail sender with a decrypted app password", async () => {
    const result = await resolveSenderConfig(
      fakeSupabase({
        gmail_address: "jay@sahnan.co",
        gmail_app_password_enc: encryptSecret("abcd efgh ijkl mnop"),
        gmail_connected_at: "2026-07-29T00:00:00Z",
        from_name: "Jay Sahnan",
        reply_to_email: null,
        daily_send_limit: 25,
      }),
      "user_1",
    );
    expect(result).toEqual({
      address: "jay@sahnan.co",
      appPassword: "abcd efgh ijkl mnop",
      fromName: "Jay Sahnan",
      replyTo: null,
      dailyLimit: 25,
      connectedAt: "2026-07-29T00:00:00Z",
    });
  });

  it("errors when gmail is not connected", async () => {
    const result = await resolveSenderConfig(
      fakeSupabase({
        gmail_address: null,
        gmail_app_password_enc: null,
        gmail_connected_at: null,
        from_name: null,
        reply_to_email: null,
        daily_send_limit: 30,
      }),
      "user_1",
    );
    expect(result).toEqual({ error: expect.stringContaining("connect") });
  });

  it("errors when no settings row exists", async () => {
    const result = await resolveSenderConfig(fakeSupabase(null), "user_1");
    expect(result).toEqual({ error: expect.stringContaining("connect") });
  });
});
```

**Step 2:** Run → FAIL.

**Step 3: Implement `src/lib/services/email-transport.ts`**

```ts
import type { SupabaseClient } from "@supabase/supabase-js";

import { decryptSecret } from "@/lib/crypto";

export interface SenderConfig {
  address: string;
  appPassword: string;
  fromName: string | null;
  replyTo: string | null;
  dailyLimit: number;
  /** When the mailbox was connected — drives the warmup ramp. */
  connectedAt: string | null;
}

const DEFAULT_DAILY_LIMIT = 30;
const NOT_CONNECTED =
  "Email is not configured. Go to Settings > Email and connect your Gmail account.";

/**
 * Single place a user's send identity is resolved from user_settings.
 * Works with the admin client and RLS-scoped clients alike.
 */
export async function resolveSenderConfig(
  supabase: SupabaseClient,
  userId: string,
): Promise<SenderConfig | { error: string }> {
  const { data: settings } = await supabase
    .from("user_settings")
    .select(
      "gmail_address, gmail_app_password_enc, gmail_connected_at, from_name, reply_to_email, daily_send_limit",
    )
    .eq("user_id", userId)
    .maybeSingle();

  if (!settings?.gmail_address || !settings.gmail_app_password_enc) {
    return { error: NOT_CONNECTED };
  }

  return {
    address: settings.gmail_address,
    appPassword: decryptSecret(settings.gmail_app_password_enc),
    fromName: settings.from_name ?? null,
    replyTo: settings.reply_to_email ?? null,
    dailyLimit: settings.daily_send_limit ?? DEFAULT_DAILY_LIMIT,
    connectedAt: settings.gmail_connected_at ?? null,
  };
}
```

**Step 4:** Run → PASS.

**Step 5:**

```bash
git add src/lib/services/email-transport.ts src/__tests__/email-transport.test.ts
git commit -m "feat(email): SenderConfig resolution with encrypted gmail creds"
```

---

### Task 6: `outreach-sender.ts` — Gmail dispatch, daily cap, ramp

**Files:**

- Modify: `src/lib/services/outreach-sender.ts`
- Test: `src/__tests__/outreach-sender.test.ts`

**Step 1: Update tests first.** Replace the `agentmail-service` mock with `gmail-service` (mock `sendGmailMessage` only — keep the real pure `getEffectiveDailyLimit` via `importOriginal`); set `EMAIL_CREDENTIALS_KEY` in `beforeEach` per repo env convention. The settings response (`preSendResponses[2]`) becomes the `resolveSenderConfig` row (Task 5 fixture shape, with `gmail_app_password_enc: encryptSecret(...)` and a `gmail_connected_at` 20 days back so existing claim-semantics tests aren't ramp-capped). A **count query now precedes the claim**: insert `{ count: 0 }` after the settings response in every response array and shift `calls[...]` indices by one. Keep every existing claim-semantics assertion — the claim protocol must not change. Add:

```ts
it("refuses to send past the ramp limit for a fresh mailbox", async () => {
  const { client } = fakeSupabase([
    { data: { id: "step_1" } },
    { data: draft },
    {
      data: {
        gmail_address: "jay@sahnan.co",
        gmail_app_password_enc: encryptSecret("pw pw pw pw pw pw"),
        gmail_connected_at: new Date().toISOString(), // day 0 → ramp cap 5
        from_name: null,
        reply_to_email: null,
        daily_send_limit: 30,
      },
    },
    { count: 5 }, // already sent 5 today
  ]);

  const result = await sendApprovedDraft(client, enrollment);

  expect(result).toMatchObject({
    ok: false,
    reason: expect.stringContaining("limit"),
  });
  expect(sendGmailMock).not.toHaveBeenCalled();
});

it("passes from name and reply-to through to the gmail send", async () => {
  // settings row with from_name "Jay Sahnan", reply_to_email "jay@jaysahnan.com",
  // full response array as in the happy-path test
  // assert sendGmailMock called with:
  //   { address: "jay@sahnan.co", appPassword: "..." },
  //   expect.objectContaining({ fromName: "Jay Sahnan", replyTo: "jay@jaysahnan.com" })
});
```

**Step 2:** Run → new tests FAIL.

**Step 3: Implement.**

- `claimAndSendDraft(supabase, draft, sender: SenderConfig, trackMetadata?)` — imports become `sendGmailMessage` + `getEffectiveDailyLimit` from gmail-service and the `SenderConfig` type from email-transport; the `agentmail-service` import goes away.
- Before the claim:

```ts
// Warmup-aware daily cap, checked before the claim so a capped run leaves
// drafts untouched for tomorrow's cron.
const effectiveLimit = getEffectiveDailyLimit(
  sender.connectedAt,
  sender.dailyLimit,
);
const todayStart = new Date();
todayStart.setUTCHours(0, 0, 0, 0);
const { count } = await supabase
  .from("sent_emails")
  .select("id", { count: "exact", head: true })
  .eq("user_id", draft.user_id)
  .gte("sent_at", todayStart.toISOString());

if ((count ?? 0) >= effectiveLimit) {
  return {
    ok: false,
    reason: `Daily send limit reached (${effectiveLimit}/day${
      effectiveLimit < sender.dailyLimit ? ", warmup ramp" : ""
    }) — draft left for tomorrow`,
  };
}
```

- The send block (claim/release semantics unchanged around it):

```ts
let sent: { messageId: string };
try {
  sent = await sendGmailMessage(
    { address: sender.address, appPassword: sender.appPassword },
    {
      fromName: sender.fromName,
      to: draft.to_email,
      subject: draft.subject,
      html: draft.body_html,
      text: draft.body_text ?? undefined,
      replyTo: sender.replyTo ?? undefined,
    },
  );
} catch (err) {
  // existing claim-release block unchanged
}
```

- The `sent_emails` insert: `message_id: sent.messageId ?? null`, `from_email: sender.address` (a real address at last), rest unchanged. No `randomUUID()` fallback — nodemailer always returns a Message-ID; if it were ever empty, null is correct rather than poisoning the matching key.
- `trackUsage({ service: "gmail", estimated_cost_usd: 0, ... })`.
- In `sendApprovedDraft`, replace the `agentmail_inbox_id` settings lookup (:176-184) with:

```ts
const sender = await resolveSenderConfig(supabase, draft.user_id);
if ("error" in sender) return { ok: false, reason: sender.error };
```

**Step 4:** `pnpm test src/__tests__/outreach-sender.test.ts` → PASS (all, including untouched claim-semantics tests).

**Step 5:**

```bash
git add src/lib/services/outreach-sender.ts src/__tests__/outreach-sender.test.ts
git commit -m "feat(email): send via gmail with warmup-ramped daily cap"
```

---

### Task 7: Agent tool call sites (`email-tools.ts`)

**Files:**

- Modify: `src/lib/tools/email-tools.ts` — `sendEmail` (:426-442), `sendBulkEmails` (:571-592), tool description (:386)
- Test: `src/__tests__/email-tools-send.test.ts`

Same change in both tools: replace the `user_settings` select + `agentmail_inbox_id` guard with

```ts
const sender = await resolveSenderConfig(supabase, draft.user_id);
if ("error" in sender) return { error: sender.error };
```

(bulk: first draft's `user_id`), pass `sender` to `claimAndSendDraft`, update the tool description "via AgentMail" → "via the user's connected Gmail", and reword the bulk loop comment (":polite to AgentMail" → sequential keeps SMTP happy + claims atomic). Update `email-tools-send.test.ts`: swap the `agentmail-service` mock for `gmail-service`, settings fixture → gmail row (encrypted password, `EMAIL_CREDENTIALS_KEY` in beforeEach), insert the `{ count: 0 }` cap response, shift index-coupled assertions. TDD order: fixtures first → red → implement → green.

```bash
git add src/lib/tools/email-tools.ts src/__tests__/email-tools-send.test.ts
git commit -m "refactor(email): agent send tools resolve gmail SenderConfig"
```

---

### Task 8: Settings API — connect/verify/disconnect Gmail

**Files:**

- Modify: `src/app/api/settings/email/route.ts` (full rewrite of both handlers)

**GET** — select `gmail_address, gmail_connected_at, from_name, reply_to_email, daily_send_limit` (NEVER the password column). Drop the `listInboxes()` call entirely. Return `settings`, `is_configured: !!gmail_address`, and `effective_daily_limit: getEffectiveDailyLimit(gmail_connected_at, daily_send_limit ?? 30)`.

**POST** — three actions:

```ts
if (body.action === "connect_gmail") {
  const address =
    typeof body.gmail_address === "string" ? body.gmail_address.trim() : "";
  const appPassword =
    typeof body.app_password === "string"
      ? body.app_password.replace(/\s+/g, "")
      : "";
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address) || appPassword.length < 16) {
    return NextResponse.json(
      { error: "A valid address and 16-character app password are required." },
      { status: 400 },
    );
  }

  const verified = await verifyGmailCredentials({ address, appPassword });
  if (!verified.ok) {
    return NextResponse.json({ error: verified.error }, { status: 400 });
  }

  // Preserve the ramp clock when re-connecting the same address.
  const { data: existing } = await supabase
    .from("user_settings")
    .select("gmail_address, gmail_connected_at")
    .eq("user_id", user.id)
    .maybeSingle();
  const connectedAt =
    existing?.gmail_address === address && existing?.gmail_connected_at
      ? existing.gmail_connected_at
      : new Date().toISOString();

  const { error } = await supabase.from("user_settings").upsert(
    {
      user_id: user.id,
      gmail_address: address,
      gmail_app_password_enc: encryptSecret(appPassword),
      gmail_connected_at: connectedAt,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id" },
  );
  if (error)
    return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ connected: true, gmail_address: address });
}

if (body.action === "disconnect_gmail") {
  const { error } = await supabase
    .from("user_settings")
    .update({
      gmail_address: null,
      gmail_app_password_enc: null,
      gmail_connected_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", user.id);
  if (error)
    return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ disconnected: true });
}
```

Default branch (plain save): `from_name`, `reply_to_email`, `daily_send_limit` (validate `Number.isInteger`, 1–500). The `create_inbox` action is deleted. Add `export const maxDuration = 30` — the live SMTP+IMAP verification takes a few seconds.

Run `pnpm typecheck && pnpm lint`, then:

```bash
git add src/app/api/settings/email/route.ts
git commit -m "feat(email): connect/verify/disconnect gmail in settings API"
```

---

### Task 9: Tracking route — IMAP polling replaces AgentMail polling

**Files:**

- Modify: `src/app/api/email/track/route.ts` (full rewrite of the loop)

- Add `export const maxDuration = 120;` (IMAP connect + TLS per user is slower than REST).
- Emails select: `"id, message_id, campaign_people_id, user_id, status, sent_at"`, still `.in("status", ["sent", "delivered", "opened"])` (legacy AgentMail-era rows in those states will simply never match and eventually age out; acceptable).
- Settings select: `"user_id, gmail_address, gmail_app_password_enc"`.
- Group pending emails per user; **one IMAP connection per user per run**:

```ts
for (const [userId, userEmails] of emailsByUser) {
  const row = settingsByUser.get(userId);
  if (!row?.gmail_address || !row.gmail_app_password_enc) continue;

  const pending = new Map<string, string>();
  for (const e of userEmails) {
    if (e.message_id) pending.set(e.message_id, e.id);
  }
  if (pending.size === 0) continue;

  const oldest = userEmails.reduce(
    (min, e) => (e.sent_at < min ? e.sent_at : min),
    userEmails[0].sent_at,
  );

  try {
    const inbound = await fetchInboundSince(
      {
        address: row.gmail_address,
        appPassword: decryptSecret(row.gmail_app_password_enc),
      },
      new Date(oldest),
    );
    for (const message of inbound) {
      const hit = classifyInboundMessage(message, pending, row.gmail_address);
      if (!hit) continue;
      const email = userEmails.find((e) => e.id === hit.sentEmailId);
      if (!email) continue;
      await applyStatus(email, hit.status); // ratchet + sent_emails + campaign_people + PostHog
    }
  } catch {
    // one user's IMAP failure must not break the whole run
  }
}
```

- `applyStatus` is the existing ratchet/update/PostHog block extracted into a local helper; keep `STATUS_PRIORITY` and `STATUS_EVENT` as-is.
- Update the doc-comment: statuses only move `sent → replied | bounced` — there is no delivered/opened/clicked signal (no tracking pixel, deliberately good for cold-email deliverability). A bounce halting follow-ups continues to work via `campaign_people.outreach_status`, which the followups processor already checks.

`pnpm typecheck && pnpm test` → clean (classifier is unit-tested; IMAP plumbing is manual-E2E'd).

```bash
git add src/app/api/email/track/route.ts
git commit -m "feat(email): reply/bounce tracking via gmail IMAP polling"
```

---

### Task 10: Settings UI

**Files:**

- Modify: `src/components/settings/email-settings.tsx` (rewrite)

Follow the component's existing patterns (`SettingsSection`, `apiFetch`, `Input`, `toast`). The inbox picker and "Create new inbox" flow are deleted. New shape:

- **Not connected:** address input + app-password input (`type="password"`) + a short ordered instruction list linking to `https://myaccount.google.com/apppasswords` ("Requires 2-Step Verification") + **Connect Gmail** button → `POST { action: "connect_gmail", ... }`; surface the API's error string on 400 (it distinguishes SMTP vs IMAP failures).
- **Connected:** "Connected as `jay@sahnan.co` · Day N — limit X/day today" (from `gmail_connected_at` + `effective_daily_limit`) + **Disconnect** button → `POST { action: "disconnect_gmail" }`.
- Shared: From Name, Reply-To (both actually honored at send time now), **Daily send limit** number input (1–500, default 30) with helper "Cold-email hygiene: keep at 30 or below per mailbox. New mailboxes ramp up automatically."
- Section description: "Connect your Gmail or Google Workspace mailbox for sending outreach." Status badge from `is_configured`.

Manual check via `pnpm dev`, then:

```bash
git add src/components/settings/email-settings.tsx
git commit -m "feat(settings): gmail connect via app password, ramp status, daily limit"
```

---

### Task 11: Remove AgentMail

Sequenced last so every prior commit had a working transport. Complete inventory (from the 2026-07-29 review — nothing else references the provider):

**Delete:**

- `src/lib/services/agentmail-service.ts`
- `src/app/api/agentmail/webhook/route.ts`
- `src/lib/types/email.ts:41-44` — `AgentMailInbox` interface

**Modify:**

- `package.json` — `pnpm remove agentmail`
- `src/proxy.ts:6` — drop the `/api/agentmail/webhook(.*)` public matcher
- `src/lib/integrations.ts:141-162` — delete the `agentmail` and `agentmail_webhook` entries; add a `gmail` email-category entry (feature: "Outbound email via user Gmail", envVars: `["EMAIL_CREDENTIALS_KEY"]`, fixHint pointing at Settings → Email)
- `src/lib/types/email.ts` — `EmailSettings` → gmail fields; `SentEmail.agentmail_message_id` → `message_id: string | null`
- `src/lib/services/cost-tracker.ts:34-35,70` — remove `"agentmail"` and its price constant from the union; add `"gmail"` (old DB usage rows with the raw string are unaffected)
- `src/components/settings/cost-center.tsx:95` — replace the `agentmail` label with `gmail: "Gmail"` (unknown keys fall back to the raw string for old rows)
- `src/app/outreach/page.tsx:92-102` — gate on `gmail_address` presence (via the settings GET) instead of `agentmail_inbox_id`
- `src/components/agent-panel.tsx:82` — "Set up my AgentMail inbox" → "Connect my Gmail for outreach"
- `.env.example:82-85` — remove the AgentMail block; add the `EMAIL_CREDENTIALS_KEY` block (see Task 12)
- `scripts/setup.mjs:352-358` — replace the AgentMail prompt group with `EMAIL_CREDENTIALS_KEY` auto-generation (`crypto.randomBytes(32).toString("base64")` if unset)
- `e2e/auth.flow.test.ts:46-50` — drop the webhook-accepts-unauthenticated-POST assertion
- `docs/architecture.md`, `docs/setup.md`, `README.md`, `.github/SECURITY.md` — prose sweep: AgentMail → Gmail app-password transport

DB columns are handled in Task 2's migration (drop `agentmail_inbox_id` + `agentmail_thread_id`, rename `agentmail_message_id` → `message_id`) — per product decision 2026-07-29 there is no AgentMail history worth preserving.

Verify: `grep -ri agentmail src/ scripts/ --include='*.ts' --include='*.tsx' --include='*.mjs'` returns **zero** hits.

`pnpm typecheck && pnpm lint && pnpm test` → clean.

```bash
git add -A
git commit -m "feat(email)!: remove AgentMail — gmail app-password is the sole transport"
```

---

### Task 12: Env, docs, setup + manual E2E

**`.env.example`** (replacing the AgentMail block, matching the file's comment style):

```bash
# ── Email sending (Gmail app-password transport) ────────────────────────────
# Key for encrypting users' Gmail app passwords at rest (AES-256-GCM).
# Required before anyone connects Gmail in Settings > Email.
# Generate: openssl rand -base64 32
# Without it: email sending and the settings Email pane are disabled.
EMAIL_CREDENTIALS_KEY=
```

**Manual E2E (the real verification):**

1. `pnpm dev` with `EMAIL_CREDENTIALS_KEY` set.
2. On `jay@sahnan.co`: enable 2SV → generate app password → Settings → Email → connect. Success toast; a wrong password shows the SMTP-specific error.
3. Approve a draft to a personal test address → send-now → arrives **from** `Jay Sahnan <jay@sahnan.co>`; visible in the sahnan.co Sent folder; Reply-To honored if set.
4. `sent_emails` row: `message_id` populated with the RFC Message-ID (angle-bracketed, `@sahnan.co` suffix).
5. Reply from the test address → trigger `/api/email/track` via QStash → row `replied`, `campaign_people.outreach_status='replied'`, follow-up halted.
6. Send to a nonexistent address at a real domain → bounce → track run → `bounced`.
7. Ramp: with `gmail_connected_at` = today, send 5 → 6th refused with "warmup ramp" in the reason and the draft still `status='draft'`. Backdate `gmail_connected_at` 15 days → cap becomes 30.
8. Disconnect → outreach page shows the not-configured gate; sends error with the connect message.
9. `grep -ri agentmail src/` → only the historical remnants listed in Task 11.

```bash
git add .env.example src/lib/integrations.ts scripts/setup.mjs README.md docs/
git commit -m "docs: gmail transport env, setup, and docs sweep"
```

---

### Task 13 (OPTIONAL — defer freely): Thread follow-ups into the same conversation

`sendGmailMessage` already accepts `inReplyTo`; `sent_emails.message_id` already stores the RFC id. In `sendApprovedDraft`, when `current_step > 1`, look up the latest `sent_emails` row for the same `campaign_people_id` with a `message_id`; pass it as `inReplyTo` and send the subject as `Re: <original subject>`. Skip silently when no prior send exists. TDD like Task 6.

---

## Test-environment note for all new tests

Vitest runs `environment: "jsdom"` globally (`vitest.config.ts`) with a single jest-dom setup file. Node builtins work under jsdom's Node process, but if importing `gmail-service.ts` (nodemailer/imapflow) misbehaves, add `// @vitest-environment node` as line 1 of the test file. Follow repo conventions: `vi.hoisted()` mocks, the thenable `fakeSupabase(responses[])` pattern from `outreach-sender.test.ts`, raw `process.env.X = …` with save/restore (no `vi.stubEnv`).

## Review-backlog (defects found 2026-07-29, NOT fixed by this plan — file as issues)

Items about the AgentMail webhook and AgentMail polling are moot after Task 11. Still live:

- Cleanup route: recovery-to-`sent` leaves `sent_at` null and never advances `campaign_people`/enrollments; a recovered draft can be deleted in the same request; stale-draft deletion orphans pending-review enrollments; unbounded `stuck` query; all errors ignored.
- Process route: enrollment insert race (select-then-insert vs unique constraint — use upsert); duplicate drafts can wedge an enrollment (needs a unique index on `(enrollment_id, sequence_step_id)`); voice profile loaded from `sequences[0].user_id` (cross-user leak if sequences share a trigger); composer sees `unknown@example.com` for personal-email-only contacts; `sequences.status` not re-checked in followups; serial Opus composition can blow `maxDuration=120` and QStash retries are not idempotent.
- Review UI: approve-then-send with no rollback (failed sends vanish from the queue as approved-but-unsent); client-side Supabase writes with no server validation.
- Platform: `getBaseUrl()` uses deployment-specific `VERCEL_URL` (prefer `VERCEL_PROJECT_PRODUCTION_URL`); `/api/tracking/(.*)` blanket public matcher; no QStash schedule automation or docs (fresh clones silently get no tracking/followups/cleanup); no suppression list or `List-Unsubscribe` header (UK PECR hygiene — worth adding before scale); `user_settings`/`sent_emails` UPDATE policies lack `with check`; no `engines` field pinning Node (CI=20, Vercel default=22).

## Deliberately out of scope (future phases)

- **OAuth "Sign in with Google" connect** — premium UX later; requires Google verification (CASA) for hosted strangers. Slots in behind `resolveSenderConfig` with zero changes to the send path.
- **Warmup-pool vendor API** (Mailivery/MailReach enroll + health polling + placement-score gating) — Phase 2 product feature. For now warmup runs outside Signal (Jay: MailReach on `jay@sahnan.co`, manually).
- **Hard campaign-activation gating on warmup state** — v1 ships the ramp; a "can't activate until day 14" gate needs product UX in the campaign flow.

## Post-merge checklist (ops, not code)

- Set `EMAIL_CREDENTIALS_KEY` in the hosted deployment's env before anyone connects Gmail.
- Confirm the QStash schedules for `/api/email/track`, `/api/email/cleanup`, and followups exist and are active (they're console-created; P1 makes empty-body schedules actually pass verification).
- Remove `AGENTMAIL_API_KEY` / `AGENTMAIL_WEBHOOK_SECRET` from deployment env; delete the AgentMail webhook endpoint config in their dashboard.
- Campaign go-live still gated on MailReach warmup (~2–3 weeks from mailbox connect) and a clean mail-tester score.
