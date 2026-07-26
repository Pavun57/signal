import { beforeEach, describe, expect, it, vi } from "vitest";

import { sendApprovedDraft } from "@/lib/services/outreach-sender";
import { sendMessage } from "@/lib/services/agentmail-service";

vi.mock("@/lib/services/agentmail-service", () => ({
  sendMessage: vi.fn(),
}));
vi.mock("@/lib/services/cost-tracker", () => ({
  trackUsage: vi.fn(),
}));

const sendMessageMock = vi.mocked(sendMessage);

interface RecordedCall {
  table: string;
  ops: Array<{ name: string; args: unknown[] }>;
}

/**
 * Minimal thenable query-builder fake: every chained method records itself
 * and awaiting the chain pops the next queued response. Lets us assert the
 * exact sequence of reads/claims/updates the sender performs.
 */
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

  return { client: { from } as never, calls };
}

const enrollment = {
  id: "enr_1",
  sequence_id: "seq_1",
  person_id: "per_1",
  campaign_people_id: "cp_1",
  current_step: 1,
};

const draft = {
  id: "draft_1",
  user_id: "user_1",
  campaign_id: "camp_1",
  to_email: "prospect@example.com",
  subject: "Hi",
  body_html: "<p>Hi</p>",
  body_text: "Hi",
};

// Await order inside sendApprovedDraft:
// 0 step select · 1 draft select · 2 settings select · 3 claim update
// then send, then bookkeeping (insert, updates, next-step select, enrollment)
const preSendResponses = [
  { data: { id: "step_1" } },
  { data: draft },
  { data: { agentmail_inbox_id: "inbox_1" } },
];

describe("sendApprovedDraft claim semantics", () => {
  beforeEach(() => {
    sendMessageMock.mockReset();
  });

  it("sends after winning the claim", async () => {
    const { client, calls } = fakeSupabase([
      ...preSendResponses,
      { data: { id: draft.id } }, // claim won
      {}, // sent_emails insert
      {}, // draft → sent
      {}, // campaign_people → sent
      { data: null }, // no next step
      {}, // enrollment → completed
    ]);
    sendMessageMock.mockResolvedValue({ messageId: "m1", threadId: "t1" });

    const result = await sendApprovedDraft(client, enrollment);

    expect(result).toMatchObject({ ok: true, messageId: "m1" });
    expect(sendMessageMock).toHaveBeenCalledTimes(1);

    const claim = calls[3];
    expect(claim.table).toBe("email_drafts");
    expect(claim.ops).toContainEqual({
      name: "update",
      args: [expect.objectContaining({ status: "queued" })],
    });
    // The claim must be conditional on the current status, not just the id.
    expect(claim.ops).toContainEqual({
      name: "eq",
      args: ["status", "draft"],
    });
  });

  it("does not send when another caller already claimed the draft", async () => {
    const { client } = fakeSupabase([
      ...preSendResponses,
      { data: null }, // claim lost — someone else got there first
    ]);

    const result = await sendApprovedDraft(client, enrollment);

    expect(result).toMatchObject({ ok: false });
    expect((result as { reason: string }).reason).toMatch(/already claimed/i);
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it("releases the claim when the send itself fails", async () => {
    const { client, calls } = fakeSupabase([
      ...preSendResponses,
      { data: { id: draft.id } }, // claim won
      {}, // release update
    ]);
    sendMessageMock.mockRejectedValue(new Error("AgentMail 503"));

    const result = await sendApprovedDraft(client, enrollment);

    expect(result).toMatchObject({ ok: false, reason: "AgentMail 503" });
    const release = calls[4];
    expect(release.table).toBe("email_drafts");
    expect(release.ops).toContainEqual({
      name: "update",
      args: [expect.objectContaining({ status: "draft" })],
    });
    // Release is also conditional, so it can't clobber a concurrent "sent".
    expect(release.ops).toContainEqual({
      name: "eq",
      args: ["status", "queued"],
    });
  });

  it("keeps the claim when bookkeeping fails after the email left", async () => {
    sendMessageMock.mockResolvedValue({ messageId: "m1", threadId: "t1" });

    const base = fakeSupabase([
      ...preSendResponses,
      { data: { id: draft.id } },
    ]);
    const origFrom = (base.client as { from: (t: string) => unknown }).from;
    // The sent_emails insert (first call after the send) blows up.
    const client = {
      from: (table: string) =>
        table === "sent_emails"
          ? { insert: () => Promise.reject(new Error("insert failed")) }
          : origFrom(table),
    } as never;

    await expect(sendApprovedDraft(client, enrollment)).rejects.toThrow(
      "insert failed",
    );
    // No release back to "draft" — the email already went out, and a retry
    // would send it twice.
    const draftReleases = base.calls
      .filter((c) => c.table === "email_drafts")
      .flatMap((c) => c.ops)
      .filter(
        (op) =>
          op.name === "update" &&
          (op.args[0] as { status?: string })?.status === "draft",
      );
    expect(draftReleases).toHaveLength(0);
  });
});
