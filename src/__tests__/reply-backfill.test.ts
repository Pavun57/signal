import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The reply backfill, and specifically the two ways it could misbehave.
 *
 * It re-enqueues itself while work remains. One-shot jobs are NOT covered by
 * idx_jobs_one_recurring_per_type, so the database will happily accept an
 * unbounded chain of them: MAX_PASSES in the executor is the only thing that
 * stops it. That cap is the highest-risk line in the file.
 *
 * The other risk is cost. Every recovered body is its own IMAP connection, so
 * a send whose reply already has a body must never be picked up again.
 */

vi.mock("@/lib/posthog-server", () => ({
  getPostHogClient: () => ({ capture: vi.fn() }),
}));
vi.mock("@/lib/crypto", () => ({
  decryptSecret: () => "app-password",
  encryptSecret: (s: string) => s,
}));
vi.mock("@/lib/services/gmail-service", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/services/gmail-service")>();
  return {
    ...actual,
    fetchInboundSince: vi.fn(),
    fetchMessageText: vi.fn(),
  };
});
vi.mock("@/lib/services/jobs", () => ({ enqueueJob: vi.fn() }));

const adminClient = { current: null as unknown };
vi.mock("@/lib/supabase/admin", () => ({
  getAdminClient: () => adminClient.current,
}));

import {
  fetchInboundSince,
  fetchMessageText,
  type InboundSummary,
} from "@/lib/services/gmail-service";
import { enqueueJob } from "@/lib/services/jobs";
import { backfillReplyBodies } from "@/lib/jobs/executors/reply-backfill";

const fetchInboundMock = vi.mocked(fetchInboundSince);
const fetchBodyMock = vi.mocked(fetchMessageText);
const enqueueMock = vi.mocked(enqueueJob);

const OUR_MSG_ID = "<sent-1@signal>";

function sentRow(replies: Array<{ id: string; body_text: string | null }>) {
  return {
    id: "se_1",
    message_id: OUR_MSG_ID,
    campaign_people_id: "cp_1",
    user_id: "user_1",
    status: "replied",
    sent_at: new Date().toISOString(),
    person_id: "per_1",
    to_email: "dana@acme.test",
    campaign_id: "camp_1",
    email_replies: replies,
  };
}

function inbound(): InboundSummary {
  return {
    fromAddress: "dana@acme.test",
    inReplyTo: OUR_MSG_ID,
    references: [],
    bodyText: "",
    subject: "Re: metering",
    date: new Date("2026-08-03T10:00:00Z"),
    uid: 11,
    messageId: "<reply-1@acme.test>",
  };
}

/** Minimal stand-in: enough query surface for the executor's three tables. */
function makeDb(sentRows: unknown[], existingReply: { id: string } | null) {
  const updates: Array<Record<string, unknown>> = [];
  const db = {
    updates,
    from(table: string) {
      const self: Record<string, unknown> = {};
      const rows =
        table === "sent_emails"
          ? sentRows
          : table === "user_settings"
            ? [
                {
                  user_id: "user_1",
                  gmail_address: "jay@sahnan.co",
                  gmail_app_password_enc: "enc",
                },
              ]
            : [];
      const thenable = {
        then: (res: (v: unknown) => unknown) =>
          res({ data: rows, error: null }),
      };
      for (const m of ["select", "in", "gte", "order", "limit", "eq"]) {
        self[m] = () => Object.assign(self, thenable);
      }
      self.maybeSingle = async () => ({ data: existingReply, error: null });
      self.update = (payload: Record<string, unknown>) => {
        updates.push(payload);
        return Object.assign(self, thenable);
      };
      self.upsert = () => ({
        select: async () => ({ data: [{ id: "r_new" }], error: null }),
      });
      return Object.assign(self, thenable);
    },
  };
  return db;
}

beforeEach(() => {
  fetchInboundMock.mockReset().mockResolvedValue([inbound()]);
  fetchBodyMock
    .mockReset()
    .mockResolvedValue("Sounds good.\n\nOn Sun wrote:\n> pitch");
  enqueueMock.mockReset().mockResolvedValue("job_1");
});

describe("reply backfill", () => {
  it("fills in a reply that was matched but never captured", async () => {
    const db = makeDb([sentRow([{ id: "r_1", body_text: null }])], {
      id: "r_1",
    });
    adminClient.current = db;

    const result = await backfillReplyBodies({ pass: 1 });

    expect(result.filled).toBe(1);
    expect(db.updates[0].body_text).toBe("Sounds good.");
  });

  it("skips a send whose reply already has a body", async () => {
    // Every recovered body is its own IMAP connection. Re-downloading one we
    // already hold is the expensive mistake this guard exists to prevent.
    const db = makeDb([sentRow([{ id: "r_1", body_text: "already here" }])], {
      id: "r_1",
    });
    adminClient.current = db;

    const result = await backfillReplyBodies({ pass: 1 });

    expect(result.filled).toBe(0);
    expect(fetchInboundMock).not.toHaveBeenCalled();
    expect(fetchBodyMock).not.toHaveBeenCalled();
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("re-enqueues itself while work remains", async () => {
    // Two candidates, only one recoverable from the inbox, so a pass leaves
    // work behind and has to come back for it.
    const rows = [
      sentRow([{ id: "r_1", body_text: null }]),
      {
        ...sentRow([{ id: "r_2", body_text: null }]),
        id: "se_2",
        message_id: "<sent-2@signal>",
      },
    ];
    adminClient.current = makeDb(rows, { id: "r_1" });

    const result = await backfillReplyBodies({ pass: 3 });

    expect(result.requeued).toBe(true);
    expect(enqueueMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "email.backfill-replies",
        payload: { pass: 4 },
      }),
    );
  });

  it("stops at the pass cap rather than looping forever", async () => {
    // The database does not bound this: one-shot jobs are outside the partial
    // unique index, so without the cap a stuck mailbox would enqueue passes
    // every two minutes indefinitely.
    const rows = [
      sentRow([{ id: "r_1", body_text: null }]),
      {
        ...sentRow([{ id: "r_2", body_text: null }]),
        id: "se_2",
        message_id: "<sent-2@signal>",
      },
    ];
    adminClient.current = makeDb(rows, { id: "r_1" });

    const result = await backfillReplyBodies({ pass: 20 });

    expect(result.requeued).toBe(false);
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("does nothing when there is nothing to backfill", async () => {
    adminClient.current = makeDb([], null);

    const result = await backfillReplyBodies({});

    expect(result).toMatchObject({ filled: 0, remaining: 0, requeued: false });
    expect(fetchInboundMock).not.toHaveBeenCalled();
  });
});
