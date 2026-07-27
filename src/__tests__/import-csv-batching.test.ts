import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  findOrCreateOrganization,
  linkOrganizationToCampaign,
} from "@/lib/services/knowledge-base";
import { MAX_ROWS_PER_REQUEST } from "@/lib/import-limits";

const h = vi.hoisted(() => ({
  getSupabaseAndUser: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  getSupabaseAndUser: h.getSupabaseAndUser,
}));
vi.mock("@/lib/services/knowledge-base", () => ({
  findOrCreateOrganization: vi.fn(),
  linkOrganizationToCampaign: vi.fn(),
  normalizeDomain: (d: string) => d.toLowerCase().replace(/^www\./, ""),
}));
vi.mock("@/lib/posthog-server", () => ({
  getPostHogClient: () => ({ capture: vi.fn() }),
}));

import { POST } from "@/app/api/import-csv/route";

const findOrCreateMock = vi.mocked(findOrCreateOrganization);
const linkMock = vi.mocked(linkOrganizationToCampaign);

/** Minimal supabase fake for the two reads the route makes. */
function fakeSupabase() {
  const builder: Record<string, unknown> = {};
  for (const name of ["select", "eq", "single"]) {
    builder[name] = () => builder;
  }
  let call = 0;
  builder.then = (resolve: (v: unknown) => unknown) => {
    call++;
    // 1st awaited chain: campaign ownership; 2nd: existing links
    if (call === 1)
      return Promise.resolve({
        data: { id: "camp_1", user_id: "user_1" },
        error: null,
      }).then(resolve);
    return Promise.resolve({ data: [], error: null }).then(resolve);
  };
  return { from: () => builder };
}

function request(body: unknown): Request {
  return new Request("http://localhost/api/import-csv", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

const row = (n: number) => ({ name: `Co ${n}`, domain: `co${n}.com` });

describe("import-csv batching", () => {
  beforeEach(() => {
    findOrCreateMock.mockReset();
    linkMock.mockReset();
    h.getSupabaseAndUser.mockReset();
    h.getSupabaseAndUser.mockResolvedValue({
      supabase: fakeSupabase(),
      user: { id: "user_1", email: "" },
    });
    findOrCreateMock.mockImplementation(
      async (d) =>
        ({
          id: `org_${d.name}`,
        }) as never,
    );
    linkMock.mockResolvedValue({ id: "link_1" });
  });

  it("rejects payloads over the row cap with 413", async () => {
    const companies = Array.from({ length: MAX_ROWS_PER_REQUEST + 1 }, (_, i) =>
      row(i),
    );
    const res = await POST(request({ campaignId: "camp_1", companies }));
    expect(res.status).toBe(413);
    expect(findOrCreateMock).not.toHaveBeenCalled();
  });

  it("imports every unique row and reports failures without aborting", async () => {
    const companies = Array.from({ length: 25 }, (_, i) => row(i));
    // One row in the middle blows up — the rest must still import.
    findOrCreateMock.mockImplementation(async (d) => {
      if (d.name === "Co 7") throw new Error("boom");
      return { id: `org_${d.name}` } as never;
    });

    const res = await POST(request({ campaignId: "camp_1", companies }));
    const body = (await res.json()) as {
      imported: number;
      skipped: number;
      failed: number;
    };

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ imported: 24, failed: 1, skipped: 0 });
    expect(findOrCreateMock).toHaveBeenCalledTimes(25);
    expect(linkMock).toHaveBeenCalledTimes(24);
  });

  it("dedups by domain and by name for domain-less rows", async () => {
    const companies = [
      { name: "Acme", domain: "acme.com" },
      { name: "Acme Inc", domain: "acme.com" }, // dup domain
      { name: "NoDomain Co" },
      { name: "nodomain co" }, // dup name, no domain
    ];

    const res = await POST(request({ campaignId: "camp_1", companies }));
    const body = (await res.json()) as { imported: number; skipped: number };

    expect(body).toMatchObject({ imported: 2, skipped: 2 });
    expect(findOrCreateMock).toHaveBeenCalledTimes(2);
  });
});
