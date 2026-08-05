import { describe, expect, it } from "vitest";

import { autoApproveDraft } from "@/lib/email-composition/save";

interface RecordedCall {
  table: string;
  ops: Array<{ name: string; args: unknown[] }>;
}

/**
 * Minimal thenable query-builder fake (same style as outreach-sender.test.ts):
 * every chained method records itself and awaiting the chain pops the next
 * queued response, so we can assert the exact shape of the guarded update.
 */
function fakeSupabase(responses: Array<{ data?: unknown; error?: unknown }>) {
  let i = 0;
  const calls: RecordedCall[] = [];

  const from = (table: string) => {
    const call: RecordedCall = { table, ops: [] };
    calls.push(call);
    const builder: Record<string, unknown> = {};
    for (const name of ["select", "eq", "update", "single", "maybeSingle"]) {
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

describe("autoApproveDraft", () => {
  it("guards the approval on review_status = 'pending' so it can never resurrect a rejected draft", async () => {
    const { client, calls } = fakeSupabase([{ data: { id: "draft_1" } }]);

    const result = await autoApproveDraft(client, "draft_1");

    expect(result).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].table).toBe("email_drafts");
    expect(calls[0].ops).toContainEqual({
      name: "update",
      args: [{ review_status: "approved" }],
    });
    expect(calls[0].ops).toContainEqual({
      name: "eq",
      args: ["id", "draft_1"],
    });
    // The load-bearing assertion: the update must be conditional on the
    // draft still being pending, not just on its id.
    expect(calls[0].ops).toContainEqual({
      name: "eq",
      args: ["review_status", "pending"],
    });
  });

  it("returns false when no pending row matched (already approved or rejected)", async () => {
    const { client } = fakeSupabase([{ data: null }]);

    expect(await autoApproveDraft(client, "draft_1")).toBe(false);
  });

  it("returns false on a database error", async () => {
    const { client } = fakeSupabase([
      { data: null, error: { message: "boom" } },
    ]);

    expect(await autoApproveDraft(client, "draft_1")).toBe(false);
  });
});
