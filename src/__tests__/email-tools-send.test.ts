import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { encryptSecret } from "@/lib/crypto";
import { sendGmailMessage } from "@/lib/services/gmail-service";

const h = vi.hoisted(() => ({
  createClient: vi.fn(),
  getSupabaseAndUser: vi.fn(),
  // getAdminClient is synchronous, unlike createClient, so it needs its own
  // handle rather than reusing the resolved one.
  adminClient: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: h.createClient,
  getSupabaseAndUser: h.getSupabaseAndUser,
}));
// The send tools resolve the sender through the admin client, because
// gmail_app_password_enc is not readable by the `authenticated` role. Same
// fake, so the ordered responses below still describe the whole conversation.
vi.mock("@/lib/supabase/admin", () => ({
  getAdminClient: () => h.adminClient(),
}));
vi.mock("@/lib/services/gmail-service", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/services/gmail-service")>();
  return { ...actual, sendGmailMessage: vi.fn() };
});
vi.mock("@/lib/services/cost-tracker", () => ({
  trackUsage: vi.fn(),
  PRICING: {},
}));

import { sendEmail, sendBulkEmails } from "@/lib/tools/email-tools";

const sendGmailMock = vi.mocked(sendGmailMessage);

interface RecordedCall {
  table: string;
  ops: Array<{ name: string; args: unknown[] }>;
}

/** Thenable query-builder fake — same pattern as outreach-sender.test.ts. */
function fakeSupabase(
  responses: Array<{ data?: unknown; error?: unknown; count?: number }>,
) {
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
      "gte",
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

function settingsResponse() {
  return {
    data: {
      gmail_address: "jay@sahnan.co",
      gmail_app_password_enc: encryptSecret("abcd efgh ijkl mnop"),
      gmail_connected_at: new Date(Date.now() - 20 * 86400_000).toISOString(),
      from_name: "Jay Sahnan",
      reply_to_email: null,
      daily_send_limit: 30,
    },
  };
}

let savedKey: string | undefined;

beforeEach(() => {
  savedKey = process.env.EMAIL_CREDENTIALS_KEY;
  process.env.EMAIL_CREDENTIALS_KEY = Buffer.alloc(32, 7).toString("base64");
  sendGmailMock.mockReset();
  h.createClient.mockReset();
  h.adminClient.mockReset();
});

afterEach(() => {
  process.env.EMAIL_CREDENTIALS_KEY = savedKey;
});

/** A contact the data-quality gate lets through. */
function gatePasses() {
  return {
    data: {
      work_email: baseDraft.to_email,
      work_email_source: "user_entered",
      work_email_verification: "deliverable",
      affiliation_confidence: 0.9,
      affiliation_source: "team_page",
      organization_id: "org_1",
    },
  };
}

describe("sendEmail review gating", () => {
  function wire(
    responses: Array<{ data?: unknown; error?: unknown; count?: number }>,
  ) {
    const fake = fakeSupabase(responses);
    h.createClient.mockResolvedValue(fake.client);
    h.adminClient.mockReturnValue(fake.client);
    return fake;
  }

  it("refuses to send a rejected draft", async () => {
    wire([{ data: { ...baseDraft, review_status: "rejected" } }]);

    const result = (await sendEmail.execute!(
      { draftId: baseDraft.id },
      {} as never,
    )) as { error?: string };

    expect(result.error).toMatch(/rejected/i);
    expect(sendGmailMock).not.toHaveBeenCalled();
  });

  it("refuses to send a draft still awaiting review", async () => {
    wire([{ data: { ...baseDraft, review_status: "pending" } }]);

    const result = (await sendEmail.execute!(
      { draftId: baseDraft.id },
      {} as never,
    )) as { error?: string };

    expect(result.error).toMatch(/awaiting review|review queue/i);
    expect(sendGmailMock).not.toHaveBeenCalled();
  });

  it("refuses when gmail is not connected", async () => {
    wire([
      { data: { ...baseDraft, review_status: "approved" } },
      { data: { gmail_address: null, gmail_app_password_enc: null } },
    ]);

    const result = (await sendEmail.execute!(
      { draftId: baseDraft.id },
      {} as never,
    )) as { error?: string };

    expect(result.error).toMatch(/connect/i);
    expect(sendGmailMock).not.toHaveBeenCalled();
  });

  it("claims atomically and sends an approved draft", async () => {
    const { calls } = wire([
      { data: { ...baseDraft, review_status: "approved" } }, // draft select
      settingsResponse(), // resolveSenderConfig
      { data: null }, // suppression check: not suppressed
      gatePasses(), // send-gate person read
      { data: { id: baseDraft.id } }, // claim won
      { count: 0 }, // daily-cap count
      {}, // sent_emails insert
      {}, // draft → sent
      {}, // campaign_people → sent
    ]);
    sendGmailMock.mockResolvedValue({ messageId: "<m1@sahnan.co>" });

    const result = (await sendEmail.execute!(
      { draftId: baseDraft.id },
      {} as never,
    )) as { emailId?: string; error?: string };

    expect(result).toMatchObject({
      emailId: "<m1@sahnan.co>",
      status: "sent",
    });
    expect(sendGmailMock).toHaveBeenCalledTimes(1);

    const claim = calls[4]; // 2 suppression check, 3 send-gate person read
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
      settingsResponse(),
      { data: null }, // suppression check: not suppressed
      gatePasses(), // send-gate person read
      { data: null }, // claim lost
    ]);

    const result = (await sendEmail.execute!(
      { draftId: baseDraft.id },
      {} as never,
    )) as { error?: string };

    expect(result.error).toMatch(/already claimed/i);
    expect(sendGmailMock).not.toHaveBeenCalled();
  });
});

describe("sendBulkEmails review gating", () => {
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
      settingsResponse(),
      { data: null }, // suppression check: not suppressed
      gatePasses(), // send-gate person read
      { data: { id: "d_ok" } }, // claim won
      { count: 0 }, // daily-cap count
      {}, // sent_emails insert
      {}, // draft → sent
      {}, // campaign_people → sent
    ]);
    h.createClient.mockResolvedValue(fake.client);
    h.adminClient.mockReturnValue(fake.client);
    sendGmailMock.mockResolvedValue({ messageId: "<m1@sahnan.co>" });

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
    expect(sendGmailMock).toHaveBeenCalledTimes(1);

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
    h.adminClient.mockReturnValue(fake.client);

    const result = (await sendBulkEmails.execute!(
      { campaignId: "camp_1" },
      {} as never,
    )) as { error?: string };

    expect(result.error).toMatch(/1 awaiting review, 1 rejected/);
    expect(sendGmailMock).not.toHaveBeenCalled();
  });
});
