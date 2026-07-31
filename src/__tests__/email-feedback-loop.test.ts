import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { encryptSecret } from "@/lib/crypto";

/**
 * The two halves of the email feedback loop, both of which existed as dead code
 * before this: a successful send records `send_confirmed`, and a bounce feeds
 * `recordBounce` so a wrong org pattern degrades instead of generating bad
 * addresses forever.
 *
 * Worth testing precisely because "the function is never called" is invisible
 * to every other kind of check — it typechecks, it lints, and its own unit
 * tests pass in isolation.
 */

// ─── send_confirmed on a successful send ──────────────────────────────────

vi.mock("@/lib/services/gmail-service", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/services/gmail-service")>();
  return { ...actual, sendGmailMessage: vi.fn() };
});
vi.mock("@/lib/services/cost-tracker", () => ({ trackUsage: vi.fn() }));
vi.mock("@/lib/services/email-pattern", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/services/email-pattern")>();
  return {
    ...actual,
    recordVerifiedEmail: vi.fn().mockResolvedValue(undefined),
    recordBounce: vi.fn().mockResolvedValue(undefined),
  };
});

import { sendGmailMessage } from "@/lib/services/gmail-service";
import {
  recordVerifiedEmail,
  recordBounce,
} from "@/lib/services/email-pattern";
import {
  claimAndSendDraft,
  sendApprovedDraft,
} from "@/lib/services/outreach-sender";
import {
  applyInboundStatus,
  type TrackedEmail,
} from "@/lib/services/email-tracking";

const sendGmailMock = vi.mocked(sendGmailMessage);
const recordVerifiedMock = vi.mocked(recordVerifiedEmail);
const recordBounceMock = vi.mocked(recordBounce);

function fakeSupabase(
  responses: Array<{ data?: unknown; error?: unknown; count?: number }>,
) {
  let i = 0;
  const from = () => {
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
      "order",
      "limit",
    ]) {
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

const enrollment = {
  id: "enr_1",
  sequence_id: "seq_1",
  person_id: "per_1",
  campaign_people_id: "cp_1",
  current_step: 1,
};

function draftWith(personId: string | null) {
  return {
    id: "draft_1",
    user_id: "user_1",
    campaign_id: "camp_1",
    person_id: personId,
    campaign_people_id: "cp_1",
    to_email: "prospect@example.com",
    subject: "Hi",
    body_html: "<p>Hi</p>",
    body_text: "Hi",
  };
}

// Lazy: encryptSecret reads EMAIL_CREDENTIALS_KEY, which beforeEach sets.
function settings() {
  return {
    gmail_address: "jay@sahnan.co",
    gmail_app_password_enc: encryptSecret("abcd efgh ijkl mnop"),
    gmail_connected_at: new Date(Date.now() - 20 * 86400_000).toISOString(),
    from_name: "Jay Sahnan",
    reply_to_email: null,
    daily_send_limit: 30,
  };
}

function sendResponses(personId: string | null) {
  return [
    { data: { id: "step_1" } }, // step select
    { data: draftWith(personId) }, // draft select
    { data: settings() }, // sender config
    { data: { id: "draft_1" } }, // claim won
    { count: 0 }, // daily cap
    {}, // sent_emails insert
    {}, // draft → sent
    {}, // campaign_people → sent
    { data: null }, // no next step
    {}, // enrollment → completed
  ];
}

let savedKey: string | undefined;

describe("send_confirmed", () => {
  beforeEach(() => {
    savedKey = process.env.EMAIL_CREDENTIALS_KEY;
    process.env.EMAIL_CREDENTIALS_KEY = Buffer.alloc(32, 7).toString("base64");
    sendGmailMock
      .mockReset()
      .mockResolvedValue({ messageId: "<m1@sahnan.co>" });
    recordVerifiedMock.mockClear();
  });
  afterEach(() => {
    process.env.EMAIL_CREDENTIALS_KEY = savedKey;
  });

  it("records the address as send-confirmed once the mail has left", async () => {
    await sendApprovedDraft(fakeSupabase(sendResponses("per_1")), enrollment);

    expect(recordVerifiedMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        personId: "per_1",
        email: "prospect@example.com",
        source: "send_confirmed",
      }),
    );
  });

  it("skips the write for a draft with no person", async () => {
    // Goes through claimAndSendDraft directly: sendApprovedDraft always has an
    // enrollment and overrides person_id from it, so the guard only ever bites
    // on the direct callers (the agent's sendEmail tool, send-now).
    await claimAndSendDraft(
      fakeSupabase([
        { data: { id: "draft_1" } }, // claim won
        { count: 0 }, // daily cap
        {}, // sent_emails insert
        {}, // draft → sent
        {}, // campaign_people → sent
      ]),
      { ...draftWith(null), person_id: null },
      {
        address: "jay@sahnan.co",
        appPassword: "abcd efgh ijkl mnop",
        fromName: "Jay Sahnan",
        replyTo: null,
        dailyLimit: 30,
        connectedAt: new Date(Date.now() - 20 * 86400_000).toISOString(),
      },
    );

    expect(recordVerifiedMock).not.toHaveBeenCalled();
  });

  it("does not fail the send when the bookkeeping write throws", async () => {
    recordVerifiedMock.mockRejectedValueOnce(new Error("db down"));

    const result = await sendApprovedDraft(
      fakeSupabase(sendResponses("per_1")),
      enrollment,
    );

    // The email already left; a bookkeeping failure must never look like a
    // send failure, or a retry would email the prospect twice.
    expect(result.ok).toBe(true);
  });
});

// ─── recordBounce from the tracking cron ──────────────────────────────────

describe("bounce feedback", () => {
  beforeEach(() => {
    recordBounceMock.mockClear();
  });

  const tracked = (over: Partial<TrackedEmail> = {}): TrackedEmail => ({
    id: "se_1",
    message_id: "<m1@x>",
    campaign_people_id: "cp_1",
    user_id: "user_1",
    status: "sent",
    sent_at: new Date().toISOString(),
    person_id: "per_1",
    to_email: "dead@acme.com",
    ...over,
  });

  it("calls recordBounce when a send bounces", async () => {
    const changed = await applyInboundStatus(
      fakeSupabase([{}, {}]),
      tracked(),
      "bounced",
    );

    expect(changed).toBe(true);
    expect(recordBounceMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        personId: "per_1",
        email: "dead@acme.com",
      }),
    );
  });

  it("does not call recordBounce for a reply", async () => {
    await applyInboundStatus(fakeSupabase([{}, {}]), tracked(), "replied");

    expect(recordBounceMock).not.toHaveBeenCalled();
  });

  it("skips the bounce feedback when the row predates person_id/to_email", async () => {
    await applyInboundStatus(
      fakeSupabase([{}, {}]),
      tracked({ person_id: null, to_email: null }),
      "bounced",
    );

    expect(recordBounceMock).not.toHaveBeenCalled();
  });

  it("still applies the status when recordBounce throws", async () => {
    recordBounceMock.mockRejectedValueOnce(new Error("db down"));

    const changed = await applyInboundStatus(
      fakeSupabase([{}, {}]),
      tracked(),
      "bounced",
    );

    expect(changed).toBe(true);
  });

  it("never walks a status backwards", async () => {
    const changed = await applyInboundStatus(
      fakeSupabase([{}, {}]),
      tracked({ status: "replied" }),
      "bounced",
    );

    expect(changed).toBe(false);
    expect(recordBounceMock).not.toHaveBeenCalled();
  });
});
