import { describe, expect, it, vi } from "vitest";

import {
  loadRecipientCandidates,
  pickRecipient,
  recipientLabel,
  type RealRecipient,
} from "@/lib/email-skills/swipe-recipient";
import { buildSkillSystem } from "@/lib/email-skills/swipe-prompts";

function candidate(name: string, enriched = true): RealRecipient {
  return {
    personId: name,
    name,
    title: "VP Marketing",
    company: "Acme",
    headline: null,
    signals: [],
    enriched,
  };
}

describe("pickRecipient wrap-around", () => {
  it("rotates on the second pass instead of pinning the first candidate", () => {
    // Regression: once every label had been judged, `?? ordered[0]` returned
    // the same first candidate for every subsequent batch forever.
    const candidates = [candidate("Ana"), candidate("Ben"), candidate("Cyd")];
    const labels = candidates.map(recipientLabel);

    // Everyone judged once, Ana judged twice: Ben is least-drafted-to next.
    const judged = [labels[0], labels[1], labels[2], labels[0]];
    expect(pickRecipient(candidates, judged)?.name).toBe("Ben");

    // Full second pass done: back to Ana, not stuck anywhere.
    const twoFull = [...labels, ...labels];
    expect(pickRecipient(candidates, twoFull)?.name).toBe("Ana");
  });
});

describe("loadRecipientCandidates query", () => {
  it("filters on outreach_status, never the dropped status column", async () => {
    // Regression: .neq("status","rejected") referenced a column dropped by
    // migration 20260420; the query errored on EVERY call, the error was
    // swallowed, and the real-recipient path never activated once.
    const filters: Array<[string, ...unknown[]]> = [];
    const builder: Record<string, unknown> = {};
    for (const name of ["select", "eq", "neq", "not", "limit"]) {
      builder[name] = (...args: unknown[]) => {
        filters.push([name, ...args]);
        return builder;
      };
    }
    builder.then = (resolve: (v: unknown) => unknown) =>
      Promise.resolve({ data: [], error: null }).then(resolve);
    const supabase = { from: () => builder } as never;

    await loadRecipientCandidates(supabase, "camp_1");

    const columns = filters
      .filter(([op]) => op === "eq" || op === "neq" || op === "not")
      .map(([, col]) => col);
    expect(columns).not.toContain("status");
    expect(columns).toContain("outreach_status");
  });

  it("logs a failed load instead of silently returning []", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const builder: Record<string, unknown> = {};
    for (const name of ["select", "eq", "neq", "not", "limit"]) {
      builder[name] = () => builder;
    }
    builder.then = (resolve: (v: unknown) => unknown) =>
      Promise.resolve({
        data: null,
        error: { message: "column does not exist" },
      }).then(resolve);
    const supabase = { from: () => builder } as never;

    const out = await loadRecipientCandidates(supabase, "camp_1");

    expect(out).toEqual([]);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});

describe("buildSkillSystem recipients note", () => {
  it("does not claim real contacts were fictional", () => {
    const withReal = buildSkillSystem(null, {}, true);
    expect(withReal).toContain("REAL campaign contacts");
    expect(withReal).not.toContain(
      "The recipients in the judged drafts were fictional personas",
    );

    const invented = buildSkillSystem(null, {}, false);
    expect(invented).toContain("fictional personas invented for practice");
  });
});
