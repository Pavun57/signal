import { beforeEach, describe, expect, it, vi } from "vitest";

import { sendMessage } from "@/lib/services/agentmail-service";

const h = vi.hoisted(() => ({
  createClient: vi.fn(),
  getSupabaseAndUser: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: h.createClient,
  getSupabaseAndUser: h.getSupabaseAndUser,
}));
vi.mock("@/lib/services/agentmail-service", () => ({
  sendMessage: vi.fn(),
}));
vi.mock("@/lib/services/cost-tracker", () => ({
  trackUsage: vi.fn(),
  PRICING: {},
}));

import { sendEmail, sendBulkEmails } from "@/lib/tools/email-tools";

const sendMessageMock = vi.mocked(sendMessage);

interface RecordedCall {
  table: string;
  ops: Array<{ name: string; args: unknown[] }>;
}

/** Thenable query-builder fake — same pattern as outreach-sender.test.ts. */
function fakeSupabase(responses: Array<{ data?: unknown; error?: unknown }>) {
  let i = 0;
  const calls: RecordedCall[] = [];

  const from = (table: string) => {
    const call: RecordedCall = { table, ops: [] };
    calls.push(call);
    const builder: Record<string, unknown> = {};
    for (const name of [
      "select",
      "eq",
      "in",
      "update",
      "insert",
      "single",
      "maybeSingle",
    ]) {
      builder[name] = (...args: unknown[]) => {
        call.ops.push({ name, args });
        return builder;
      };
    }
    builder.then = (
      resolve: (v: unknown) => unknown,
      reject: (e: unknown) => unknown,
    ) =>
      Promise.resolve(responses[i++] ?? { data: null, error: null }).then(
        resolve,
        reject,
      );
    return builder;
  };

  return { client: { from }, calls };
}

const baseDraft = {
  id: "draft_1",
  user_id: "user_1",
  campaign_id: "camp_1",
  person_id: "per_1",
  campaign_people_id: "cp_1",
  to_email: "prospect@example.com",
  subject: "Hi",
  body_html: "<p>Hi</p>",
  body_text: "Hi",
  status: "draft",
};

const settings = { data: { agentmail_inbox_id: "inbox_1" } };

describe("sendEmail review gating", () => {
  beforeEach(() => {
    sendMessageMock.mockReset();
    h.createClient.mockReset();
  });

  function wire(responses: Array<{ data?: unknown; error?: unknown }>) {
    const fake = fakeSupabase(responses);
    h.createClient.mockResolvedValue(fake.client);
    return fake;
  }

  it("refuses to send a rejected draft", async () => {
    wire([{ data: { ...baseDraft, review_status: "rejected" } }]);

    const result = (await sendEmail.execute!(
      { draftId: baseDraft.id },
      {} as never,
    )) as { error?: string };

    expect(result.error).toMatch(/rejected/i);
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it("refuses to send a draft still awaiting review", async () => {
    wire([{ data: { ...baseDraft, review_status: "pending" } }]);

    const result = (await sendEmail.execute!(
      { draftId: baseDraft.id },
      {} as never,
    )) as { error?: string };

    expect(result.error).toMatch(/awaiting review|review queue/i);
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it("claims atomically and sends an approved draft", async () => {
    const { calls } = wire([
      { data: { ...baseDraft, review_status: "approved" } }, // draft select
      settings, // settings select
      { data: { id: baseDraft.id } }, // claim won
      {}, // sent_emails insert
      {}, // draft → sent
      {}, // campaign_people → sent
    ]);
    sendMessageMock.mockResolvedValue({ messageId: "m1", threadId: "t1" });

    const result = (await sendEmail.execute!(
      { draftId: baseDraft.id },
      {} as never,
    )) as { emailId?: string; error?: string };

    expect(result).toMatchObject({ emailId: "m1", status: "sent" });
    expect(sendMessageMock).toHaveBeenCalledTimes(1);

    const claim = calls[2];
    expect(claim.table).toBe("email_drafts");
    expect(claim.ops).toContainEqual({
      name: "update",
      args: [expect.objectContaining({ status: "queued" })],
    });
    expect(claim.ops).toContainEqual({ name: "eq", args: ["status", "draft"] });
  });

  it("surfaces a lost claim instead of double-sending", async () => {
    wire([
      { data: { ...baseDraft, review_status: "approved" } },
      settings,
      { data: null }, // claim lost
    ]);

    const result = (await sendEmail.execute!(
      { draftId: baseDraft.id },
      {} as never,
    )) as { error?: string };

    expect(result.error).toMatch(/already claimed/i);
    expect(sendMessageMock).not.toHaveBeenCalled();
  });
});

describe("sendBulkEmails review gating", () => {
  beforeEach(() => {
    sendMessageMock.mockReset();
    h.createClient.mockReset();
  });

  it("sends only approved drafts and reports the held ones", async () => {
    const fake = fakeSupabase([
      {
        // scope query: 1 approved, 1 pending, 1 rejected
        data: [
          { id: "d_ok", review_status: "approved" },
          { id: "d_pending", review_status: "pending" },
          { id: "d_rejected", review_status: "rejected" },
        ],
      },
      { data: [{ ...baseDraft, id: "d_ok", review_status: "approved" }] },
      settings,
      { data: { id: "d_ok" } }, // claim won
      {}, // sent_emails insert
      {}, // draft → sent
      {}, // campaign_people → sent
    ]);
    h.createClient.mockResolvedValue(fake.client);
    sendMessageMock.mockResolvedValue({ messageId: "m1", threadId: "t1" });

    const result = (await sendBulkEmails.execute!(
      { campaignId: "camp_1" },
      {} as never,
    )) as {
      sent: number;
      awaitingReview: number;
      rejected: number;
      summary: string;
    };

    expect(result.sent).toBe(1);
    expect(result.awaitingReview).toBe(1);
    expect(result.rejected).toBe(1);
    expect(result.summary).toMatch(/1 held for review and 1 rejected/);
    expect(sendMessageMock).toHaveBeenCalledTimes(1);

    // The actual send query is pinned to approved ids + approved status.
    const draftsQuery = fake.calls[1];
    expect(draftsQuery.ops).toContainEqual({
      name: "eq",
      args: ["review_status", "approved"],
    });
  });

  it("refuses outright when nothing in scope is approved", async () => {
    const fake = fakeSupabase([
      {
        data: [
          { id: "d_pending", review_status: "pending" },
          { id: "d_rejected", review_status: "rejected" },
        ],
      },
    ]);
    h.createClient.mockResolvedValue(fake.client);

    const result = (await sendBulkEmails.execute!(
      { campaignId: "camp_1" },
      {} as never,
    )) as { error?: string };

    expect(result.error).toMatch(/1 awaiting review, 1 rejected/);
    expect(sendMessageMock).not.toHaveBeenCalled();
  });
});
