import { beforeEach, describe, expect, it, vi } from "vitest";

const { sendApprovedDraftMock, getAdminClientMock } = vi.hoisted(() => ({
  sendApprovedDraftMock: vi.fn(),
  getAdminClientMock: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({
  getAdminClient: getAdminClientMock,
}));
vi.mock("@/lib/services/outreach-sender", () => ({
  sendApprovedDraft: sendApprovedDraftMock,
}));
vi.mock("@/lib/posthog-server", () => ({
  getPostHogClient: () => ({ capture: vi.fn() }),
}));
vi.mock("@/lib/services/contact-selector", () => ({
  selectContactsForSignal: vi.fn(),
}));
vi.mock("@/lib/email-composition/compose", () => ({
  composeEmail: vi.fn(),
}));
vi.mock("@/lib/email-composition/load-voice", () => ({
  loadVoiceProfile: vi.fn(),
}));
vi.mock("@/lib/email-composition/save", () => ({
  saveDraft: vi.fn(),
}));

import { processOutreach } from "@/lib/jobs/executors/outreach-process";

/** Same thenable query-builder fake as outreach-sender.test.ts. */
function fakeSupabase(responses: Array<{ data?: unknown; error?: unknown }>) {
  let i = 0;
  const calls: Array<{
    table: string;
    ops: Array<{ name: string; args: unknown[] }>;
  }> = [];
  const from = (table: string) => {
    const call = { table, ops: [] as Array<{ name: string; args: unknown[] }> };
    calls.push(call);
    const builder: Record<string, unknown> = {};
    for (const name of [
      "select",
      "eq",
      "in",
      "lte",
      "update",
      "insert",
      "single",
      "maybeSingle",
      "limit",
      "order",
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

const waitingEnrollment = {
  id: "enr_w1",
  sequence_id: "seq_1",
  person_id: "per_1",
  campaign_people_id: "cp_1",
  current_step: 1,
};

beforeEach(() => {
  sendApprovedDraftMock.mockReset();
  getAdminClientMock.mockReset();
});

describe("followups handler — approved waiting enrollments", () => {
  it("sends a waiting enrollment whose current-step draft is approved", async () => {
    const { client } = fakeSupabase([
      { data: [] }, // active enrollments due
      { data: [waitingEnrollment] }, // waiting enrollments
      { data: [{ enrollment_id: "enr_w1" }] }, // approved-draft check
      { data: { id: "step_1", condition: "always" } }, // step
      { data: { outreach_status: "not_contacted" } }, // campaign_people
    ]);
    getAdminClientMock.mockReturnValue(client);
    sendApprovedDraftMock.mockResolvedValue({
      ok: true,
      messageId: "m1",
      draftId: "d1",
    });

    const body = await processOutreach({ type: "followups" });

    expect(sendApprovedDraftMock).toHaveBeenCalledTimes(1);
    expect(sendApprovedDraftMock).toHaveBeenCalledWith(
      client,
      expect.objectContaining({ id: "enr_w1" }),
    );
    expect(body.sent).toBe(1);
  });

  it("does not send a waiting enrollment whose draft is still pending review", async () => {
    const { client } = fakeSupabase([
      { data: [] }, // active due
      { data: [waitingEnrollment] }, // waiting
      { data: [] }, // no approved drafts
    ]);
    getAdminClientMock.mockReturnValue(client);

    const body = await processOutreach({ type: "followups" });

    expect(sendApprovedDraftMock).not.toHaveBeenCalled();
    expect(body.sent).toBe(0);
  });

  it("surfaces send-failure reasons instead of discarding them", async () => {
    const { client } = fakeSupabase([
      { data: [] },
      { data: [waitingEnrollment] },
      { data: [{ enrollment_id: "enr_w1" }] },
      { data: { id: "step_1", condition: "always" } },
      { data: { outreach_status: "not_contacted" } },
    ]);
    getAdminClientMock.mockReturnValue(client);
    sendApprovedDraftMock.mockResolvedValue({
      ok: false,
      reason: "Daily send limit reached (5/day, warmup ramp)",
    });

    const body = (await processOutreach({ type: "followups" })) as {
      sent: number;
      failures: Record<string, number>;
    };

    expect(body.sent).toBe(0);
    expect(body.failures).toEqual({
      "Daily send limit reached (5/day, warmup ramp)": 1,
    });
  });
});
