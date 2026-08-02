import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Just-in-time verification — the only place provider credits are spent under
 * lazy verification. The contracts that matter:
 *
 *  - an outage/quota failure refuses the send but writes NOTHING (retryable);
 *  - only a definitive verdict is persisted;
 *  - a deliverable mailbox at the employer's own domain doubles as employment
 *    evidence;
 *  - a cached org catch-all settles the question without a billable call.
 */

const provider = {
  id: "fake",
  canFind: true,
  canVerify: true,
  findEmail: vi.fn(),
  verifyEmail: vi.fn(),
};
let providerEnabled = true;

vi.mock("@/lib/services/email-provider", () => ({
  getEmailProvider: () => (providerEnabled ? provider : null),
}));

const affiliations: Array<Record<string, unknown>> = [];
vi.mock("@/lib/services/affiliation", () => ({
  recordAffiliation: vi.fn(async (_c: unknown, a: Record<string, unknown>) => {
    affiliations.push(a);
    // Matches the real signature: a mock resolving to undefined would let a
    // caller that reads `.written` pass on a value it can never get.
    return { written: true };
  }),
}));

import { verifyAddressForSend } from "@/lib/services/send-verification";

interface Row extends Record<string, unknown> {
  id: string;
}
const state: { people: Row[]; organizations: Row[] } = {
  people: [],
  organizations: [],
};

function client(): SupabaseClient {
  const chain = (table: "people" | "organizations") => {
    let mode: "select" | "update" = "select";
    let updates: Record<string, unknown> = {};
    const preds: Array<(r: Row) => boolean> = [];
    const c: Record<string, unknown> & PromiseLike<unknown> = {
      select: () => c,
      update: (v: Record<string, unknown>) => {
        mode = "update";
        updates = v;
        return c;
      },
      eq: (col: string, val: unknown) => {
        preds.push((r) => r[col] === val);
        return c;
      },
      maybeSingle: () => c,
      then(onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) {
        const rows = state[table];
        if (mode === "update") {
          for (const r of rows)
            if (preds.every((p) => p(r))) Object.assign(r, updates);
          return Promise.resolve({ data: null, error: null }).then(onF, onR);
        }
        const match = rows.find((r) => preds.every((p) => p(r))) ?? null;
        return Promise.resolve({ data: match, error: null }).then(onF, onR);
      },
    } as unknown as Record<string, unknown> & PromiseLike<unknown>;
    return c;
  };
  return {
    from: (t: string) => chain(t as "people" | "organizations"),
  } as unknown as SupabaseClient;
}

const person = () => state.people[0];
const org = () => state.organizations[0];

beforeEach(() => {
  providerEnabled = true;
  affiliations.length = 0;
  provider.verifyEmail.mockReset();
  state.people = [{ id: "p1", work_email_verification: "unchecked" }];
  state.organizations = [
    { id: "org-1", domain: "acme.com", is_catch_all: null },
  ];
});

const run = (email = "jane.doe@acme.com") =>
  verifyAddressForSend(client(), {
    personId: "p1",
    email,
    organizationId: "org-1",
  });

describe("verifyAddressForSend", () => {
  it("verifies, caches the proof, and records employment evidence", async () => {
    provider.verifyEmail.mockResolvedValue({
      status: "deliverable",
      catchAll: false,
    });

    const result = await run();

    expect(result.outcome).toBe("verified");
    expect(person().work_email_verification).toBe("deliverable");
    expect(person().work_email_confidence).toBe(0.95);
    // a working mailbox at the employer's own domain is proof of employment
    expect(affiliations[0]).toMatchObject({
      personId: "p1",
      organizationId: "org-1",
      source: "email_domain",
    });
    // and the org's catch-all status was learned for free next time
    expect(org().is_catch_all).toBe(false);
  });

  it("grants no employment evidence for an off-domain address", async () => {
    provider.verifyEmail.mockResolvedValue({
      status: "deliverable",
      catchAll: false,
    });

    const result = await run("jane@gmail.com");

    expect(result.outcome).toBe("verified");
    expect(affiliations).toHaveLength(0);
    // and it must not touch the org's catch-all cache either
    expect(org().is_catch_all).toBeNull();
  });

  it("marks a dead address undeliverable and refuses", async () => {
    provider.verifyEmail.mockResolvedValue({
      status: "undeliverable",
      catchAll: false,
    });

    const result = await run();

    expect(result.outcome).toBe("blocked");
    expect(person().work_email_verification).toBe("undeliverable");
  });

  it("refuses an outage without writing anything", async () => {
    // The single most important contract: quota exhaustion or downtime must
    // not brand the address — the suggestion survives and the next attempt
    // re-checks once the provider recovers.
    provider.verifyEmail.mockResolvedValue({
      status: "unknown",
      catchAll: false,
      raw: "http_429",
    });

    const result = await run();

    expect(result.outcome).toBe("unavailable");
    expect(person().work_email_verification).toBe("unchecked");
    expect(org().is_catch_all).toBeNull();
  });

  it("refuses cleanly when no provider is configured", async () => {
    providerEnabled = false;

    const result = await run();

    expect(result.outcome).toBe("unavailable");
    expect(person().work_email_verification).toBe("unchecked");
  });

  it("settles a known catch-all org without a billable call", async () => {
    state.organizations = [
      { id: "org-1", domain: "acme.com", is_catch_all: true },
    ];

    const result = await run();

    expect(result.outcome).toBe("blocked");
    expect(person().work_email_verification).toBe("risky");
    expect(provider.verifyEmail).not.toHaveBeenCalled();
  });

  it("treats a catch-all verdict as unprovable, not verified", async () => {
    provider.verifyEmail.mockResolvedValue({
      status: "deliverable",
      catchAll: true,
    });

    const result = await run();

    expect(result.outcome).toBe("blocked");
    expect(person().work_email_verification).toBe("risky");
    expect(affiliations).toHaveLength(0);
    // the definitive catch-all answer is cached for the whole org
    expect(org().is_catch_all).toBe(true);
  });
});
