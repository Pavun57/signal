import { beforeEach, describe, expect, it, vi } from "vitest";

import { createSupabaseFake } from "./helpers/supabase-fake";

/**
 * The signal -> pick -> draft -> send loop, which had no test at all.
 *
 * `createSequence` is the only writer of `sequences.status` and it only ever
 * wrote "draft". `handleSignalTrigger` matched on `status = 'active'`. Nothing
 * anywhere promoted a sequence, so the query never matched, the function
 * returned "no matching sequences" before it reached pickAndDraft, and the
 * headline feature of the product could not run for anybody.
 *
 * The regression these tests exist to catch is narrow and easy to reintroduce:
 * tightening that status predicate back to a single value. They also pin the
 * two statuses that must keep halting a sequence, because "accept everything"
 * would be an equally wrong fix.
 */

const CAMPAIGN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SIGNAL = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ORG = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const PERSON = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const ENROLLMENT = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

const { sendApprovedDraftMock, getAdminClientMock, pickAndDraftSpy } =
  vi.hoisted(() => ({
    sendApprovedDraftMock: vi.fn(),
    getAdminClientMock: vi.fn(),
    pickAndDraftSpy: vi.fn(),
  }));

vi.mock("@/lib/supabase/admin", () => ({ getAdminClient: getAdminClientMock }));
vi.mock("@/lib/services/outreach-sender", () => ({
  sendApprovedDraft: sendApprovedDraftMock,
}));
vi.mock("@/lib/posthog-server", () => ({
  getPostHogClient: () => ({ capture: vi.fn() }),
}));
vi.mock("@/lib/email-composition/compose", () => ({ composeEmail: vi.fn() }));
vi.mock("@/lib/email-composition/load-voice", () => ({
  loadVoiceProfile: vi.fn(),
}));
vi.mock("@/lib/email-composition/save", () => ({ saveDraft: vi.fn() }));
vi.mock("@/lib/services/contact-selector", () => ({
  // Returning no candidates keeps pickAndDraft cheap; the send loop below
  // still runs, which is the path these tests assert on.
  selectContactsForSignal: (...args: unknown[]) => {
    pickAndDraftSpy(...args);
    return Promise.resolve({ picks: [] });
  },
}));

import { processOutreach } from "@/lib/jobs/executors/outreach-process";

/** One sequence, whose status each test rewrites. */
let sequenceStatus = "draft";

function fake() {
  return createSupabaseFake({
    tables: {
      sequences: () => [
        {
          id: "seq-1",
          user_id: "user-1",
          status: sequenceStatus,
          trigger_signal_id: SIGNAL,
          campaign_id: CAMPAIGN,
        },
      ],
      signals: () => [
        { id: SIGNAL, name: "Hiring Activity", category: "hiring" },
      ],
      // pickAndDraft reads the full send-gate column set off each person.
      people: () => [
        {
          id: PERSON,
          organization_id: ORG,
          name: "Dana Doe",
          title: "VP Eng",
          work_email: "dana@acme.com",
          personal_email: null,
          linkedin_url: null,
          enrichment_data: {},
          work_email_source: "user_entered",
          work_email_confidence: 1,
          work_email_verification: "deliverable",
          affiliation_confidence: 1,
          affiliation_source: "user_entered",
          affiliation_evidence: null,
        },
      ],
      campaign_people: () => [
        {
          id: "cp-1",
          person_id: PERSON,
          campaign_id: CAMPAIGN,
          priority_score: 5,
          outreach_status: "not_contacted",
        },
      ],
      sequence_enrollments: () => [
        {
          id: ENROLLMENT,
          sequence_id: "seq-1",
          person_id: PERSON,
          campaign_people_id: "cp-1",
          current_step: 1,
          status: "waiting",
        },
      ],
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  sequenceStatus = "draft";
  getAdminClientMock.mockImplementation(fake);
  sendApprovedDraftMock.mockResolvedValue({
    ok: true,
    messageId: "m-1",
    draftId: "d-1",
  });
});

const payload = {
  type: "signal" as const,
  signalId: SIGNAL,
  campaignId: CAMPAIGN,
  organizationId: ORG,
};

describe("signal-triggered outreach", () => {
  it("runs for a sequence still in draft -- the status nothing ever promotes", async () => {
    const result = (await processOutreach(payload)) as {
      sent: number;
      reason?: string;
    };

    expect(result.reason).not.toBe("no matching sequences");
    expect(sendApprovedDraftMock).toHaveBeenCalledTimes(1);
    expect(result.sent).toBe(1);
  });

  it("runs for an active sequence", async () => {
    sequenceStatus = "active";

    const result = (await processOutreach(payload)) as { sent: number };

    expect(sendApprovedDraftMock).toHaveBeenCalledTimes(1);
    expect(result.sent).toBe(1);
  });

  for (const halted of ["paused", "completed"]) {
    it(`does not run for a ${halted} sequence`, async () => {
      sequenceStatus = halted;

      const result = (await processOutreach(payload)) as { reason?: string };

      expect(result.reason).toBe("no matching sequences");
      expect(sendApprovedDraftMock).not.toHaveBeenCalled();
    });
  }
});
