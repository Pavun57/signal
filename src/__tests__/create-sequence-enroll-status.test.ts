import { describe, expect, it, vi } from "vitest";

const { getSupabaseAndUserMock } = vi.hoisted(() => ({
  getSupabaseAndUserMock: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  getSupabaseAndUser: getSupabaseAndUserMock,
  createClient: vi.fn(),
}));

import { createSequence } from "@/lib/tools/sequence-tools";

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
      "in",
      "update",
      "insert",
      "single",
      "maybeSingle",
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
  return { calls, client: { from } as never };
}

function harness(responses: Array<{ data?: unknown; error?: unknown }>) {
  const { calls, client } = fakeSupabase(responses);
  getSupabaseAndUserMock.mockResolvedValue({
    supabase: client,
    user: { id: "user_1" },
  });
  return { calls };
}

const baseResponses = [
  { data: { user_id: "user_1" } }, // campaign owner
  { data: { id: "seq_1" } }, // sequence insert
  {}, // steps insert
  { data: [{ id: "cp_1", person_id: "per_1" }] }, // contacts
  {}, // enrollments insert
];

function enrollmentInsert(calls: RecordedCall[]) {
  const call = calls.find(
    (c) =>
      c.table === "sequence_enrollments" &&
      c.ops.some((op) => op.name === "insert"),
  );
  const op = call?.ops.find((o) => o.name === "insert");
  return (op?.args[0] ?? []) as Array<{ status: string }>;
}

// Who consumes each status decides who gets it, and this was inverted:
// "queued" is consumed only by handleSignalTrigger, "waiting" is what the
// followups sweep rescues once a draft is approved. Plain sequences were
// enrolled "queued" (dead: nothing ever read it) and signal sequences
// "waiting" (sent on mere approval, before the signal ever fired).
describe("createSequence enrollment status", () => {
  it("enrolls plain sequences as waiting, so approval sends them", async () => {
    const { calls } = harness(baseResponses);

    await createSequence.execute!(
      {
        name: "Plain",
        campaignId: "3e0b9db1-0000-4000-8000-000000000001",
        steps: [{ condition: "always" }],
      } as never,
      {} as never,
    );

    const rows = enrollmentInsert(calls);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("waiting");
  });

  it("enrolls signal-triggered sequences as queued, so only the signal fire sends them", async () => {
    const { calls } = harness(baseResponses);

    await createSequence.execute!(
      {
        name: "Signal",
        campaignId: "3e0b9db1-0000-4000-8000-000000000001",
        triggerSignalId: "3e0b9db1-0000-4000-8000-000000000002",
        steps: [{ condition: "always" }],
      } as never,
      {} as never,
    );

    const rows = enrollmentInsert(calls);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("queued");
  });
});
