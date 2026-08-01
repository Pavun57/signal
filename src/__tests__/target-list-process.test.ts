import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  verifySignatureMock,
  getAdminClientMock,
  publishJSONMock,
  enrichMock,
  withActionMock,
} = vi.hoisted(() => ({
  verifySignatureMock: vi.fn(),
  getAdminClientMock: vi.fn(),
  publishJSONMock: vi.fn(),
  enrichMock: vi.fn(),
  withActionMock: vi.fn(
    (_label: string, fn: () => Promise<unknown>): Promise<unknown> => fn(),
  ),
}));

vi.mock("@/lib/services/qstash", () => ({
  verifyQStashSignature: verifySignatureMock,
  getQStashClient: () => ({ publishJSON: publishJSONMock }),
  getBaseUrl: () => "http://localhost:3000",
}));
vi.mock("@/lib/supabase/admin", () => ({
  getAdminClient: getAdminClientMock,
}));
vi.mock("@/lib/services/company-enrichment", () => ({
  enrichAndFindContacts: enrichMock,
}));
vi.mock("@/lib/services/cost-tracker", () => ({
  withAction: withActionMock,
}));

import {
  POST,
  pickEnrichBatch,
  countRemaining,
} from "@/app/api/target-lists/process/route";

/** Same thenable query-builder fake as outreach-sender.test.ts. */
function fakeSupabase(
  responses: Array<{ data?: unknown; error?: unknown; count?: number }>,
) {
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
      "not",
      "update",
      "order",
      "limit",
      "single",
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

function processRequest(body: unknown): Request {
  return new Request("http://localhost:3000/api/target-lists/process", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

const payload = { listId: "list_1", campaignId: "camp_1", userId: "user_1" };

const rowA = {
  organization_id: "org_a",
  organizations: { name: "Acme", enrichment_status: "pending" },
};
const rowB = {
  organization_id: "org_b",
  organizations: { name: "Beta Corp", enrichment_status: "pending" },
};

beforeEach(() => {
  verifySignatureMock.mockReset();
  verifySignatureMock.mockResolvedValue(payload);
  getAdminClientMock.mockReset();
  publishJSONMock.mockReset();
  publishJSONMock.mockResolvedValue({ messageId: "msg_1" });
  enrichMock.mockReset();
  enrichMock.mockResolvedValue({
    enriched: true,
    contactsFound: 1,
    errors: [],
    enrichmentData: {},
  });
  withActionMock.mockClear();
});

describe("pickEnrichBatch", () => {
  it("queries stamped rows with pending orgs, oldest first, limited", async () => {
    const { client, calls } = fakeSupabase([{ data: [rowA, rowB] }]);

    const batch = await pickEnrichBatch(client, "list_1", 2);

    expect(batch).toEqual([
      { organizationId: "org_a", orgName: "Acme" },
      { organizationId: "org_b", orgName: "Beta Corp" },
    ]);

    const call = calls[0];
    expect(call.table).toBe("target_accounts");
    expect(call.ops).toContainEqual({
      name: "eq",
      args: ["list_id", "list_1"],
    });
    expect(call.ops).toContainEqual({
      name: "not",
      args: ["enrich_requested_at", "is", null],
    });
    expect(call.ops).toContainEqual({
      name: "eq",
      args: ["organizations.enrichment_status", "pending"],
    });
    expect(call.ops).toContainEqual({
      name: "order",
      args: ["enrich_requested_at", { ascending: true }],
    });
    expect(call.ops).toContainEqual({ name: "limit", args: [2] });
  });

  it("throws when the query errors", async () => {
    const { client } = fakeSupabase([
      { data: null, error: { message: "boom" } },
    ]);
    await expect(pickEnrichBatch(client, "list_1", 2)).rejects.toThrow("boom");
  });
});

describe("countRemaining", () => {
  it("counts with the same filters as the picker", async () => {
    const { client, calls } = fakeSupabase([{ count: 7 }]);

    const remaining = await countRemaining(client, "list_1");

    expect(remaining).toBe(7);
    const call = calls[0];
    expect(call.table).toBe("target_accounts");
    expect(call.ops).toContainEqual({
      name: "eq",
      args: ["list_id", "list_1"],
    });
    expect(call.ops).toContainEqual({
      name: "not",
      args: ["enrich_requested_at", "is", null],
    });
    expect(call.ops).toContainEqual({
      name: "eq",
      args: ["organizations.enrichment_status", "pending"],
    });
    // Head-only count — no rows shipped back per hop.
    const select = call.ops.find((op) => op.name === "select");
    expect(select?.args[1]).toMatchObject({ count: "exact", head: true });
  });
});

describe("POST /api/target-lists/process", () => {
  it("returns 401 when the QStash signature is invalid", async () => {
    verifySignatureMock.mockRejectedValue(
      new Error("Invalid QStash signature"),
    );

    const res = await POST(processRequest(payload));

    expect(res.status).toBe(401);
    expect(enrichMock).not.toHaveBeenCalled();
    expect(publishJSONMock).not.toHaveBeenCalled();
  });

  it("returns 400 when the payload is empty", async () => {
    verifySignatureMock.mockResolvedValue(null);

    const res = await POST(processRequest(payload));

    expect(res.status).toBe(400);
    expect(enrichMock).not.toHaveBeenCalled();
  });

  it("enriches the batch under withAction and re-publishes when work remains", async () => {
    const { client } = fakeSupabase([
      { data: [rowA, rowB] }, // pickEnrichBatch
      { count: 3 }, // countRemaining
    ]);
    getAdminClientMock.mockReturnValue(client);

    const res = await POST(processRequest(payload));
    const body = await res.json();

    expect(body).toEqual({ processed: 2, remaining: 3 });
    expect(enrichMock).toHaveBeenCalledTimes(2);
    expect(enrichMock).toHaveBeenCalledWith(client, "org_a", "camp_1", {
      skipContactFinding: false,
    });
    expect(withActionMock).toHaveBeenCalledWith(
      "Enrich target account: Acme",
      expect.any(Function),
    );
    expect(withActionMock).toHaveBeenCalledWith(
      "Enrich target account: Beta Corp",
      expect.any(Function),
    );
    // Chain continues: same payload, same route.
    expect(publishJSONMock).toHaveBeenCalledTimes(1);
    expect(publishJSONMock).toHaveBeenCalledWith({
      url: "http://localhost:3000/api/target-lists/process",
      body: payload,
    });
  });

  it("does not re-publish when nothing remains", async () => {
    const { client } = fakeSupabase([
      { data: [rowA] }, // pickEnrichBatch
      { count: 0 }, // countRemaining
    ]);
    getAdminClientMock.mockReturnValue(client);

    const res = await POST(processRequest(payload));
    const body = await res.json();

    expect(body).toEqual({ processed: 1, remaining: 0 });
    expect(publishJSONMock).not.toHaveBeenCalled();
  });

  it("clears enrich_requested_at on a poison row and keeps processing", async () => {
    const { client, calls } = fakeSupabase([
      { data: [rowA, rowB] }, // pickEnrichBatch
      {}, // poison-row stamp clear
      { count: 0 }, // countRemaining
    ]);
    getAdminClientMock.mockReturnValue(client);
    enrichMock
      .mockRejectedValueOnce(new Error("enrichment exploded"))
      .mockResolvedValueOnce({
        enriched: true,
        contactsFound: 0,
        errors: [],
        enrichmentData: {},
      });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await POST(processRequest(payload));
    const body = await res.json();

    // Both accounts attempted despite the first blowing up.
    expect(enrichMock).toHaveBeenCalledTimes(2);
    expect(body).toEqual({ processed: 2, remaining: 0 });

    // The poison row's stamp is cleared so the chain can't loop on it.
    const clear = calls[1];
    expect(clear.table).toBe("target_accounts");
    expect(clear.ops).toContainEqual({
      name: "update",
      args: [{ enrich_requested_at: null }],
    });
    expect(clear.ops).toContainEqual({
      name: "eq",
      args: ["list_id", "list_1"],
    });
    expect(clear.ops).toContainEqual({
      name: "eq",
      args: ["organization_id", "org_a"],
    });
    errorSpy.mockRestore();
  });

  it("threads skipContactFinding through to enrichment", async () => {
    verifySignatureMock.mockResolvedValue({
      ...payload,
      skipContactFinding: true,
    });
    const { client } = fakeSupabase([
      { data: [rowA] }, // pickEnrichBatch
      { count: 0 }, // countRemaining
    ]);
    getAdminClientMock.mockReturnValue(client);

    await POST(processRequest({ ...payload, skipContactFinding: true }));

    expect(enrichMock).toHaveBeenCalledWith(client, "org_a", "camp_1", {
      skipContactFinding: true,
    });
  });
});
