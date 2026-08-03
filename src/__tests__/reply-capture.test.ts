import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Reply capture, and specifically its idempotency.
 *
 * `email.track` re-polls the same 14-day window every 10 minutes, so every
 * reply is re-matched dozens of times. Two things therefore have to hold, and
 * they pull in opposite directions:
 *
 *   - re-seeing the SAME message must not insert a second row, and must not
 *     re-download a body over a fresh IMAP connection;
 *   - a SECOND, genuinely different reply in the same thread must still be
 *     stored, even though `applyInboundStatus` refuses it (replied -> replied
 *     fails the monotonic ladder).
 *
 * The obvious implementation, gating the insert on applyInboundStatus's return
 * value, satisfies the first and silently breaks the second. That is the bug
 * this file exists to catch.
 */

vi.mock("@/lib/posthog-server", () => ({
  getPostHogClient: () => ({ capture: vi.fn() }),
}));
vi.mock("@/lib/services/email-pattern", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/services/email-pattern")>();
  return { ...actual, recordBounce: vi.fn().mockResolvedValue(undefined) };
});
vi.mock("@/lib/crypto", () => ({
  decryptSecret: () => "app-password",
  encryptSecret: (s: string) => s,
}));
vi.mock("@/lib/services/gmail-service", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/services/gmail-service")>();
  // classifyInboundMessage stays REAL: the matching logic is the thing that
  // decides which send a reply belongs to, and faking it would hollow out
  // every assertion below.
  return {
    ...actual,
    fetchInboundSince: vi.fn(),
    fetchMessageText: vi.fn(),
  };
});

const adminClient = { current: null as unknown };
vi.mock("@/lib/supabase/admin", () => ({
  getAdminClient: () => adminClient.current,
}));

import {
  fetchInboundSince,
  fetchMessageText,
  type InboundSummary,
} from "@/lib/services/gmail-service";
import { replyDedupeKey } from "@/lib/services/email-tracking";
import { trackEmailReplies } from "@/lib/jobs/executors/email-track";

const fetchInboundMock = vi.mocked(fetchInboundSince);
const fetchBodyMock = vi.mocked(fetchMessageText);

const SENT_ID = "se_1";
const OUR_MSG_ID = "<sent-1@signal>";

/**
 * Rebuilt per test. A single shared mutable row meant a test that failed
 * before restoring `status` poisoned every test after it, turning one real
 * failure into three and hiding which was which.
 */
function makeSentEmail(status = "sent") {
  return {
    id: SENT_ID,
    message_id: OUR_MSG_ID,
    campaign_people_id: "cp_1",
    user_id: "user_1",
    status,
    sent_at: new Date().toISOString(),
    person_id: "per_1",
    to_email: "dana@acme.test",
    campaign_id: "camp_1",
  };
}

const settingsRow = {
  user_id: "user_1",
  gmail_address: "jay@sahnan.co",
  gmail_app_password_enc: "enc",
};

function inbound(over: Partial<InboundSummary> = {}): InboundSummary {
  return {
    fromAddress: "dana@acme.test",
    inReplyTo: OUR_MSG_ID,
    references: [],
    bodyText: "",
    subject: "Re: metering",
    date: new Date("2026-08-03T10:00:00Z"),
    uid: 11,
    messageId: "<reply-1@acme.test>",
    ...over,
  };
}

/**
 * A Supabase stand-in that models the one thing under test: an upsert with
 * `ignoreDuplicates` against a real unique constraint. The shared fake in
 * helpers/ models select and update only, and the conflict semantics are
 * exactly what these assertions turn on, so this is deliberately its own.
 */
function makeDb(seedReplies: Array<Record<string, unknown>> = []) {
  const replies = [...seedReplies];
  const sentEmail = makeSentEmail();
  const statusUpdates: Array<Record<string, unknown>> = [];

  const db = {
    replies,
    statusUpdates,
    sentEmail,
    from(table: string) {
      if (table === "sent_emails") {
        return chain([sentEmail], (payload) => statusUpdates.push(payload));
      }
      if (table === "user_settings") return chain([settingsRow]);
      if (table === "campaign_people") {
        return chain([], (payload) => statusUpdates.push(payload));
      }
      if (table === "email_replies") {
        return {
          select: () => ({
            in: async () => ({ data: replies, error: null }),
          }),
          upsert: (row: Record<string, unknown>) => ({
            select: async () => {
              const key = `${row.sent_email_id}|${row.dedupe_key}`;
              const exists = replies.some(
                (r) => `${r.sent_email_id}|${r.dedupe_key}` === key,
              );
              if (exists) return { data: [], error: null };
              replies.push(row);
              return { data: [{ id: `r_${replies.length}` }], error: null };
            },
          }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
  return db;
}

function chain(
  rows: unknown[],
  onUpdate?: (p: Record<string, unknown>) => void,
) {
  const self: Record<string, unknown> = {};
  const thenable = {
    then: (res: (v: unknown) => unknown) => res({ data: rows, error: null }),
  };
  for (const m of ["select", "in", "gte", "order", "limit", "eq"]) {
    self[m] = () => Object.assign(self, thenable);
  }
  self.update = (payload: Record<string, unknown>) => {
    onUpdate?.(payload);
    return Object.assign(self, thenable);
  };
  return Object.assign(self, thenable);
}

beforeEach(() => {
  fetchInboundMock.mockReset();
  fetchBodyMock.mockReset();
  fetchBodyMock.mockResolvedValue(
    "Sounds good, next week works.\n\nOn Sun wrote:\n> pitch",
  );
});

describe("reply capture idempotency", () => {
  it("stores a reply once, however many times the poll re-sees it", async () => {
    const db = makeDb();
    adminClient.current = db;
    fetchInboundMock.mockResolvedValue([inbound()]);

    const first = await trackEmailReplies();
    expect(first.captured).toBe(1);
    expect(db.replies).toHaveLength(1);
    expect(db.replies[0].body_text).toBe("Sounds good, next week works.");

    // Second poll, same inbox contents. The send is already 'replied', so the
    // status ladder refuses it; the reply must not be stored twice either.
    db.sentEmail.status = "replied";
    const second = await trackEmailReplies();
    expect(second.captured).toBe(0);
    expect(db.replies).toHaveLength(1);
  });

  it("does not re-download a body it has already captured", async () => {
    const db = makeDb();
    adminClient.current = db;
    fetchInboundMock.mockResolvedValue([inbound()]);

    await trackEmailReplies();
    expect(fetchBodyMock).toHaveBeenCalledTimes(1);

    // A second run must reuse what is stored. Re-downloading here is what
    // turns 20 replies into 20 IMAP connections every 10 minutes.
    await trackEmailReplies();
    expect(fetchBodyMock).toHaveBeenCalledTimes(1);
  });

  it("stores a second, different reply in the same thread", async () => {
    const db = makeDb();
    adminClient.current = db;

    fetchInboundMock.mockResolvedValue([inbound()]);
    await trackEmailReplies();
    expect(db.replies).toHaveLength(1);

    // They followed up. applyInboundStatus returns false for this one
    // (replied -> replied), so anything gating the insert on it loses this.
    db.sentEmail.status = "replied";
    fetchInboundMock.mockResolvedValue([
      inbound(),
      inbound({
        messageId: "<reply-2@acme.test>",
        uid: 12,
        subject: "Re: metering (one more thing)",
      }),
    ]);
    const run = await trackEmailReplies();

    expect(run.captured).toBe(1);
    expect(db.replies).toHaveLength(2);
    expect(db.replies[1].message_id).toBe("<reply-2@acme.test>");
  });

  it("stores null, not empty string, when no body was captured", async () => {
    const db = makeDb();
    adminClient.current = db;
    fetchInboundMock.mockResolvedValue([inbound()]);
    fetchBodyMock.mockResolvedValue("");

    await trackEmailReplies();

    // null means "we never got the words" and is retryable on a later poll.
    // "" would read as a genuinely empty reply and would never be retried.
    expect(db.replies[0].body_text).toBeNull();
  });

  it("captures a bounce without a second download", async () => {
    const db = makeDb();
    adminClient.current = db;
    fetchInboundMock.mockResolvedValue([
      inbound({
        fromAddress: "mailer-daemon@googlemail.com",
        inReplyTo: OUR_MSG_ID,
        bodyText: "550 5.1.1 The email account does not exist.",
        messageId: "<dsn-1@googlemail.com>",
      }),
    ]);

    await trackEmailReplies();

    // fetchInboundSince already downloaded the daemon body to match the quoted
    // Message-ID, so bounce capture is free.
    expect(fetchBodyMock).not.toHaveBeenCalled();
    expect(db.replies[0].kind).toBe("bounce");
    expect(db.replies[0].body_text).toContain("550 5.1.1");
  });
});

describe("replyDedupeKey", () => {
  const identity = {
    messageId: "<a@b>",
    uid: 7,
    fromAddress: "Dana@Acme.test",
    date: new Date("2026-08-03T10:00:00Z"),
    subject: "Re: metering",
  };

  it("prefers the sender's own Message-ID", () => {
    expect(replyDedupeKey(identity)).toBe("<a@b>");
  });

  it("falls back to the IMAP UID when the header is absent", () => {
    expect(replyDedupeKey({ ...identity, messageId: null })).toBe("uid:7");
  });

  it("falls back to sender, time and subject when both are absent", () => {
    expect(replyDedupeKey({ ...identity, messageId: null, uid: null })).toBe(
      `dana@acme.test|${identity.date.getTime()}|Re: metering`,
    );
  });

  it("is stable across polls for the same message", () => {
    expect(replyDedupeKey(identity)).toBe(replyDedupeKey({ ...identity }));
  });
});
