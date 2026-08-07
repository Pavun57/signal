import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { encryptSecret } from "@/lib/crypto";
import { sendApprovedDraft } from "@/lib/services/outreach-sender";
import { sendGmailMessage } from "@/lib/services/gmail-service";

vi.mock("@/lib/services/gmail-service", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/services/gmail-service")>();
  // getEffectiveDailyLimit stays real — it's pure and separately tested.
  return { ...actual, sendGmailMessage: vi.fn() };
});
vi.mock("@/lib/services/cost-tracker", () => ({
  trackUsage: vi.fn(),
}));

const sendGmailMock = vi.mocked(sendGmailMessage);

interface RecordedCall {
  table: string;
  ops: Array<{ name: string; args: unknown[] }>;
}

/**
 * Minimal thenable query-builder fake: every chained method records itself
 * and awaiting the chain pops the next queued response. Lets us assert the
 * exact sequence of reads/claims/updates the sender performs.
 */
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
      "not",
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

function settingsRow(overrides: Record<string, unknown> = {}) {
  return {
    gmail_address: "jay@sahnan.co",
    gmail_app_password_enc: encryptSecret("abcd efgh ijkl mnop"),
    // 20 days back — fully ramped, so claim-semantics tests hit the full cap.
    gmail_connected_at: new Date(Date.now() - 20 * 86400_000).toISOString(),
    from_name: "Jay Sahnan",
    reply_to_email: null,
    daily_send_limit: 30,
    ...overrides,
  };
}

// Await order inside sendApprovedDraft:
// 0 step select · 1 draft select · 2 settings select (resolveSenderConfig) ·
// 3 suppression select · 4 recipient-status select (campaign_people) ·
// 5 send-gate person select · 6 claim update · 7 daily-cap count
// then send, then bookkeeping (insert, updates, next-step select, enrollment)
/** A contact the data-quality gate lets through: verified email, known employer. */
function gatePasses() {
  return {
    data: {
      work_email: "prospect@example.com",
      work_email_source: "user_entered",
      work_email_verification: "deliverable",
      affiliation_confidence: 0.9,
      affiliation_source: "team_page",
      organization_id: "org_1",
    },
  };
}

function preSendResponses(settings: Record<string, unknown> = settingsRow()) {
  return [
    { data: { id: "step_1" } },
    { data: draft },
    { data: settings },
    { data: null }, // suppression check: not suppressed
    { data: { outreach_status: "sent" } }, // recipient status: no reply yet
    // The send gate reads the contact before claiming the draft.
    gatePasses(),
  ];
}

let savedKey: string | undefined;

describe("sendApprovedDraft claim semantics", () => {
  beforeEach(() => {
    savedKey = process.env.EMAIL_CREDENTIALS_KEY;
    process.env.EMAIL_CREDENTIALS_KEY = Buffer.alloc(32, 7).toString("base64");
    sendGmailMock.mockReset();
  });
  afterEach(() => {
    process.env.EMAIL_CREDENTIALS_KEY = savedKey;
  });

  it("refuses when sending is paused, before the gate read and the claim", async () => {
    const { client, calls } = fakeSupabase([
      { data: { id: "step_1" } }, // step select
      { data: draft }, // draft select
      { data: settingsRow({ sending_paused: true }) }, // sender config
      {}, // refuse() bookkeeping: last_error update on the draft
    ]);

    const result = await sendApprovedDraft(client, enrollment);

    expect(result).toMatchObject({
      ok: false,
      reason: expect.stringContaining("paused"),
    });
    expect(sendGmailMock).not.toHaveBeenCalled();
    // The kill switch fires before JIT verification and the claim: no gate
    // read, no credits, no claim. The only write is refuse()'s bookkeeping,
    // which records the reason on the draft as a deferred (retryable) refusal.
    expect(calls.map((c) => c.table)).toEqual([
      "sequence_steps",
      "email_drafts",
      "user_settings",
      "email_drafts",
    ]);
    expect(calls[3].ops).toContainEqual({
      name: "update",
      args: [expect.objectContaining({ last_error_kind: "deferred" })],
    });
  });

  it("refuses a suppressed address as blocked, before the gate and the claim", async () => {
    const { client, calls } = fakeSupabase([
      { data: { id: "step_1" } }, // step select
      { data: draft }, // draft select
      { data: settingsRow() }, // sender config
      { data: { reason: "unsubscribe" } }, // suppression hit
      {}, // refuse() bookkeeping
    ]);

    const result = await sendApprovedDraft(client, enrollment);

    expect(result).toMatchObject({
      ok: false,
      reason: expect.stringContaining("stop being contacted"),
    });
    expect(sendGmailMock).not.toHaveBeenCalled();
    // No gate read, no verification credits, no claim: the suppression check
    // must sit before all of them, and the only write is the refusal record.
    expect(calls.map((c) => c.table)).toEqual([
      "sequence_steps",
      "email_drafts",
      "user_settings",
      "outreach_suppressions",
      "email_drafts",
    ]);
    expect(calls[4].ops).toContainEqual({
      name: "update",
      args: [expect.objectContaining({ last_error_kind: "blocked" })],
    });
  });

  it("defers when the suppression list cannot be checked", async () => {
    // Fail closed: "could not check the list" must never become "send anyway".
    const { client } = fakeSupabase([
      { data: { id: "step_1" } },
      { data: draft },
      { data: settingsRow() },
      { data: null, error: { message: "connection reset" } }, // lookup failed
      {}, // refuse() bookkeeping
    ]);

    const result = await sendApprovedDraft(client, enrollment);

    expect(result).toMatchObject({
      ok: false,
      reason: expect.stringContaining("suppression"),
    });
    expect(sendGmailMock).not.toHaveBeenCalled();
  });

  it("sends after winning the claim", async () => {
    const { client, calls } = fakeSupabase([
      ...preSendResponses(),
      { data: { id: draft.id } }, // claim won
      { count: 0 }, // daily-cap count
      {}, // sent_emails insert
      {}, // draft → sent
      {}, // campaign_people → sent
      { data: null }, // no next step
      {}, // enrollment → completed
    ]);
    sendGmailMock.mockResolvedValue({ messageId: "<m1@sahnan.co>" });

    const result = await sendApprovedDraft(client, enrollment);

    expect(result).toMatchObject({ ok: true, messageId: "<m1@sahnan.co>" });
    expect(sendGmailMock).toHaveBeenCalledTimes(1);
    expect(sendGmailMock).toHaveBeenCalledWith(
      { address: "jay@sahnan.co", appPassword: "abcd efgh ijkl mnop" },
      expect.objectContaining({
        fromName: "Jay Sahnan",
        to: draft.to_email,
        subject: draft.subject,
        html: draft.body_html,
      }),
    );

    const claim = calls[6]; // 3 suppression, 4 recipient status, 5 gate read
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

    // The sent_emails row records the RFC Message-ID and the real address.
    const insert = calls[8]; // 5 gate read, 7 cap count (also sent_emails)
    expect(insert.table).toBe("sent_emails");
    expect(insert.ops).toContainEqual({
      name: "insert",
      args: [
        expect.objectContaining({
          message_id: "<m1@sahnan.co>",
          from_email: "jay@sahnan.co",
        }),
      ],
    });
  });

  it("refuses to send when the recipient already replied", async () => {
    // The followups cron checks replied status before calling in, but
    // send-now, the hero's Send all, and the agent tools did not: a reply
    // landing between approval and click kept the follow-up going out.
    const { client, calls } = fakeSupabase([
      { data: { id: "step_1" } },
      { data: draft },
      { data: settingsRow() },
      { data: null }, // not suppressed
      { data: { outreach_status: "replied" } }, // recipient status
      {}, // refuse() bookkeeping
    ]);

    const result = await sendApprovedDraft(client, enrollment);

    expect(result).toMatchObject({
      ok: false,
      reason: expect.stringContaining("replied"),
    });
    expect(sendGmailMock).not.toHaveBeenCalled();
    // Refused before the gate read and the claim: no verification credits
    // spent, and the only write is the refusal record on the draft.
    expect(calls.map((c) => c.table)).toEqual([
      "sequence_steps",
      "email_drafts",
      "user_settings",
      "outreach_suppressions",
      "campaign_people",
      "email_drafts",
    ]);
    expect(calls[5].ops).toContainEqual({
      name: "update",
      args: [expect.objectContaining({ last_error_kind: "blocked" })],
    });
  });

  it("defers when the recipient status cannot be checked", async () => {
    // Fail closed, same contract as the suppression list: "could not check
    // whether they replied" must never become "send anyway".
    const { client } = fakeSupabase([
      { data: { id: "step_1" } },
      { data: draft },
      { data: settingsRow() },
      { data: null },
      { data: null, error: { message: "connection reset" } },
      {}, // refuse() bookkeeping
    ]);

    const result = await sendApprovedDraft(client, enrollment);

    expect(result).toMatchObject({
      ok: false,
      reason: expect.stringContaining("recipient"),
    });
    expect(sendGmailMock).not.toHaveBeenCalled();
  });

  it("never downgrades a terminal outreach_status when stamping the send", async () => {
    // A reply or bounce recorded between draft and send must survive the
    // send bookkeeping. The unconditional update used to write "sent" over
    // "replied", and applyInboundStatus's ladder compares against the
    // sent_emails row (already "replied"), so nothing ever restored it:
    // follow-ups kept going to a live conversation.
    const { client, calls } = fakeSupabase([
      ...preSendResponses(),
      { data: { id: draft.id } }, // claim won
      { count: 0 },
      {}, // sent_emails insert
      {}, // draft → sent
      {}, // campaign_people → sent (guarded)
      { data: null }, // no next step
      {}, // enrollment → completed
    ]);
    sendGmailMock.mockResolvedValue({ messageId: "<m3@sahnan.co>" });

    await sendApprovedDraft(client, enrollment);

    // The pre-send recipient-status read also hits campaign_people; assert
    // on the call that carries the update.
    const cpUpdate = calls.find(
      (c) =>
        c.table === "campaign_people" &&
        c.ops.some((op) => op.name === "update"),
    );
    expect(cpUpdate).toBeDefined();
    expect(cpUpdate!.ops).toContainEqual({
      name: "update",
      args: [expect.objectContaining({ outreach_status: "sent" })],
    });
    expect(cpUpdate!.ops).toContainEqual({
      name: "not",
      args: [
        "outreach_status",
        "in",
        '("replied","bounced","complained","unsubscribed")',
      ],
    });
  });

  it("passes reply-to through to the gmail send", async () => {
    const { client } = fakeSupabase([
      ...preSendResponses(settingsRow({ reply_to_email: "jay@jaysahnan.com" })),
      { data: { id: draft.id } },
      { count: 0 },
      {},
      {},
      {},
      { data: null },
      {},
    ]);
    sendGmailMock.mockResolvedValue({ messageId: "<m2@sahnan.co>" });

    await sendApprovedDraft(client, enrollment);

    expect(sendGmailMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ replyTo: "jay@jaysahnan.com" }),
    );
  });

  it("refuses to send past the ramp limit and releases the claim", async () => {
    const { client, calls } = fakeSupabase([
      { data: { id: "step_1" } },
      { data: draft },
      {
        data: settingsRow({
          gmail_connected_at: new Date().toISOString(), // day 0 → ramp cap 5
        }),
      },
      { data: null }, // suppression check: not suppressed
      { data: { outreach_status: "sent" } }, // recipient status
      gatePasses(), // send-gate person read
      { data: { id: draft.id } }, // claim won
      { count: 5 }, // already sent 5 today
      {}, // claim release
    ]);

    const result = await sendApprovedDraft(client, enrollment);

    expect(result).toMatchObject({
      ok: false,
      reason: expect.stringContaining("warmup ramp"),
    });
    expect(sendGmailMock).not.toHaveBeenCalled();
    // The capped draft must go back to "draft" so tomorrow's cron sends it.
    const release = calls[8];
    expect(release.table).toBe("email_drafts");
    expect(release.ops).toContainEqual({
      name: "update",
      args: [expect.objectContaining({ status: "draft" })],
    });
  });

  it("refuses to send past the configured daily cap", async () => {
    const { client } = fakeSupabase([
      ...preSendResponses(settingsRow({ daily_send_limit: 10 })),
      { data: { id: draft.id } }, // claim won
      { count: 10 },
      {}, // claim release
    ]);

    const result = await sendApprovedDraft(client, enrollment);

    expect(result).toMatchObject({
      ok: false,
      reason: expect.stringContaining("Daily send limit"),
    });
    expect(sendGmailMock).not.toHaveBeenCalled();
  });

  it("fails cleanly when gmail is not connected", async () => {
    const { client } = fakeSupabase([
      { data: { id: "step_1" } },
      { data: draft },
      { data: { gmail_address: null, gmail_app_password_enc: null } },
    ]);

    const result = await sendApprovedDraft(client, enrollment);

    expect(result).toMatchObject({
      ok: false,
      reason: expect.stringContaining("connect"),
    });
    expect(sendGmailMock).not.toHaveBeenCalled();
  });

  it("does not send when another caller already claimed the draft", async () => {
    const { client } = fakeSupabase([
      ...preSendResponses(),
      { data: null }, // claim lost — someone else got there first
    ]);

    const result = await sendApprovedDraft(client, enrollment);

    expect(result).toMatchObject({ ok: false });
    expect((result as { reason: string }).reason).toMatch(/already claimed/i);
    expect(sendGmailMock).not.toHaveBeenCalled();
  });

  it("releases the claim when the send itself fails", async () => {
    const { client, calls } = fakeSupabase([
      ...preSendResponses(),
      { data: { id: draft.id } }, // claim won
      { count: 0 }, // daily-cap count
      {}, // release update
    ]);
    sendGmailMock.mockRejectedValue(new Error("SMTP 421 try again later"));

    const result = await sendApprovedDraft(client, enrollment);

    expect(result).toMatchObject({
      ok: false,
      reason: "SMTP 421 try again later",
    });
    const release = calls[8];
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
    sendGmailMock.mockResolvedValue({ messageId: "<m1@sahnan.co>" });

    const base = fakeSupabase([
      ...preSendResponses(),
      { data: { id: draft.id } }, // claim won
      { count: 0 }, // daily-cap count
    ]);
    const origFrom = (base.client as { from: (t: string) => unknown }).from;
    // The sent_emails insert (first call after the send) blows up. Note the
    // cap-count select also hits sent_emails, so only reject inserts.
    const client = {
      from: (table: string) => {
        if (table !== "sent_emails") return origFrom(table);
        const real = origFrom(table) as Record<string, unknown>;
        return {
          ...real,
          insert: () => Promise.reject(new Error("insert failed")),
        };
      },
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
