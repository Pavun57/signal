import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/admin", () => ({
  getAdminClient: vi.fn(),
}));
vi.mock("@/lib/services/reply-intent", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/services/reply-intent")>();
  // shouldSuppress/suppressionReason stay real: they are pure and the
  // stamp-vs-suppress ordering under test depends on their verdicts.
  return { ...actual, classifyReplyIntent: vi.fn() };
});

import { classifyReplies } from "@/lib/jobs/executors/email-classify";
import { classifyReplyIntent } from "@/lib/services/reply-intent";
import { getAdminClient } from "@/lib/supabase/admin";

const classifyMock = vi.mocked(classifyReplyIntent);
const adminMock = vi.mocked(getAdminClient);

interface RecordedCall {
  table: string;
  ops: Array<{ name: string; args: unknown[] }>;
}

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
      "is",
      "not",
      "order",
      "limit",
      "update",
      "upsert",
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
  return { calls, client: { from } as never };
}

const replyRow = {
  id: "reply_1",
  user_id: "user_1",
  person_id: "per_1",
  subject: "Re: quick note",
  body_text: "unsubscribe me please",
  sent_email_id: "se_1",
  sent_emails: { subject: "quick note", to_email: "Sam@Acme.com" },
};

describe("classifyReplies suppression ordering", () => {
  it("upserts the suppression before stamping intent", async () => {
    // The intent stamp is what removes the row from the scan window
    // (.is("intent", null)), so it must be the LAST write: stamping before
    // a failed suppression upsert dropped the unsubscribe forever.
    classifyMock.mockResolvedValueOnce({
      intent: "unsubscribe",
      confidence: 0.99,
      reasoning: "explicit unsubscribe request",
    });
    const { client, calls } = fakeSupabase([
      { data: [replyRow] }, // scan
      {}, // suppression upsert
      {}, // intent stamp
    ]);
    adminMock.mockReturnValue(client as never);

    const result = await classifyReplies();

    expect(result).toMatchObject({ classified: 1, suppressed: 1 });
    const writes = calls.filter((c) =>
      c.ops.some((op) => op.name === "update" || op.name === "upsert"),
    );
    expect(writes.map((c) => c.table)).toEqual([
      "outreach_suppressions",
      "email_replies",
    ]);
    // Suppresses the address we sent to, lowercased.
    const upsert = writes[0].ops.find((op) => op.name === "upsert");
    expect(upsert?.args[0]).toMatchObject({ email: "sam@acme.com" });
  });

  it("leaves the row unclassified when the suppression upsert fails", async () => {
    classifyMock.mockResolvedValueOnce({
      intent: "unsubscribe",
      confidence: 0.99,
      reasoning: "explicit unsubscribe request",
    });
    const { client, calls } = fakeSupabase([
      { data: [replyRow] }, // scan
      { error: { message: "connection reset" } }, // suppression upsert fails
    ]);
    adminMock.mockReturnValue(client as never);

    const result = await classifyReplies();

    // No intent stamp: the row stays in the scan window and the next run
    // retries both writes.
    expect(result).toMatchObject({ classified: 0, suppressed: 0 });
    expect(
      calls.some(
        (c) =>
          c.table === "email_replies" &&
          c.ops.some((op) => op.name === "update"),
      ),
    ).toBe(false);
  });

  it("stamps intent directly for non-suppressing verdicts", async () => {
    classifyMock.mockResolvedValueOnce({
      intent: "interested",
      confidence: 0.9,
      reasoning: "asked for a call",
    });
    const { client, calls } = fakeSupabase([
      { data: [replyRow] }, // scan
      {}, // intent stamp
    ]);
    adminMock.mockReturnValue(client as never);

    const result = await classifyReplies();

    expect(result).toMatchObject({ classified: 1, suppressed: 0 });
    expect(calls.some((c) => c.table === "outreach_suppressions")).toBe(false);
  });
});
