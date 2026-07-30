import { beforeEach, describe, expect, it, vi } from "vitest";

const { getUserMock, getAdminClientMock, sendApprovedDraftMock } = vi.hoisted(
  () => ({
    getUserMock: vi.fn(),
    getAdminClientMock: vi.fn(),
    sendApprovedDraftMock: vi.fn(),
  }),
);

vi.mock("@/lib/supabase/server", () => ({
  getSupabaseAndUser: getUserMock,
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

import { POST } from "@/app/api/outreach/send-now/route";

function fakeSupabase(responses: Array<{ data?: unknown; error?: unknown }>) {
  let i = 0;
  const from = () => {
    const builder: Record<string, unknown> = {};
    for (const name of ["select", "eq", "single", "maybeSingle"]) {
      builder[name] = () => builder;
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
  return { from } as never;
}

function sendNowRequest(draftId: string): Request {
  return new Request("http://localhost:3000/api/outreach/send-now", {
    method: "POST",
    body: JSON.stringify({ draftId }),
  });
}

const approvedDraft = {
  id: "draft_2",
  user_id: "user_1",
  review_status: "approved",
  status: "draft",
  enrollment_id: "enr_1",
  sequence_step_id: "step_2",
};

const enrollment = {
  id: "enr_1",
  sequence_id: "seq_1",
  person_id: "per_1",
  campaign_people_id: "cp_1",
  current_step: 1,
};

beforeEach(() => {
  getUserMock.mockReset();
  getUserMock.mockResolvedValue({ user: { id: "user_1" }, supabase: {} });
  getAdminClientMock.mockReset();
  sendApprovedDraftMock.mockReset();
});

describe("send-now step matching", () => {
  it("refuses to send when the clicked draft is not the enrollment's current step", async () => {
    getAdminClientMock.mockReturnValue(
      fakeSupabase([
        { data: approvedDraft }, // draft: belongs to step_2
        { data: enrollment }, // enrollment: sitting at step 1
        { data: { id: "step_1" } }, // current step resolves to step_1
      ]),
    );

    const res = await POST(sendNowRequest("draft_2"));
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.blocker).toBe("step_mismatch");
    expect(sendApprovedDraftMock).not.toHaveBeenCalled();
  });

  it("sends when the draft matches the enrollment's current step", async () => {
    getAdminClientMock.mockReturnValue(
      fakeSupabase([
        { data: { ...approvedDraft, sequence_step_id: "step_1" } },
        { data: enrollment },
        { data: { id: "step_1" } },
      ]),
    );
    sendApprovedDraftMock.mockResolvedValue({
      ok: true,
      messageId: "m1",
      draftId: "draft_2",
    });

    const res = await POST(sendNowRequest("draft_2"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(sendApprovedDraftMock).toHaveBeenCalledTimes(1);
  });
});
