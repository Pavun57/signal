import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/admin", () => ({
  getAdminClient: vi.fn(),
}));

import { trackEmailReplies } from "@/lib/jobs/executors/email-track";
import { backfillReplyBodies } from "@/lib/jobs/executors/reply-backfill";
import { getAdminClient } from "@/lib/supabase/admin";

const adminMock = vi.mocked(getAdminClient);

function failingSupabase(message: string) {
  const from = () => {
    const builder: Record<string, unknown> = {};
    for (const name of [
      "select",
      "eq",
      "in",
      "is",
      "not",
      "gte",
      "order",
      "limit",
    ]) {
      builder[name] = () => builder;
    }
    builder.then = (
      resolve: (v: unknown) => unknown,
      reject: (e: unknown) => unknown,
    ) =>
      Promise.resolve({ data: null, error: { message } }).then(resolve, reject);
    return builder;
  };
  return { from } as never;
}

// A failed scan must fail the job run (execute.ts catches the throw and
// calls failJob), never read as "nothing to check" and complete clean:
// that is how replies went unseen while the job history stayed green.
describe("job executors fail on scan errors", () => {
  it("email.track throws when the sent_emails scan fails", async () => {
    adminMock.mockReturnValue(failingSupabase("connection reset"));
    await expect(trackEmailReplies()).rejects.toThrow(
      /sent_emails load: connection reset/,
    );
  });

  it("reply backfill throws when the sent_emails scan fails", async () => {
    adminMock.mockReturnValue(failingSupabase("connection reset"));
    await expect(backfillReplyBodies()).rejects.toThrow(
      /sent_emails load: connection reset/,
    );
  });
});
