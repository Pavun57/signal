import { describe, expect, it } from "vitest";

import {
  BatchSchema,
  buildBatchSystem,
} from "@/lib/email-skills/swipe-prompts";
import type { RealRecipient } from "@/lib/email-skills/swipe-recipient";

const recipient: RealRecipient = {
  personId: "p1",
  name: "Priya Raman",
  title: "Head of Growth",
  company: "Kindra",
  headline: "Growth at Kindra",
  signals: ["Kindra raises Series B (2026-07-01)"],
  enriched: true,
};

describe("buildBatchSystem with a real recipient", () => {
  it("renders the real-recipient block instead of the invented one", () => {
    const system = buildBatchSystem(null, {}, recipient);
    expect(system).toContain("Priya Raman");
    expect(system).toContain("Kindra raises Series B");
    expect(system).toContain("REAL PERSON");
    expect(system).not.toContain("INVENT THE RECIPIENT");
  });

  it("keeps the invented block when no recipient is given", () => {
    const system = buildBatchSystem(null, {});
    expect(system).toContain("INVENT THE RECIPIENT");
  });

  it("emits the no-enrichment variant for unenriched contacts", () => {
    const system = buildBatchSystem(
      null,
      {},
      {
        ...recipient,
        headline: null,
        signals: [],
        enriched: false,
      },
    );
    expect(system).toContain("No enrichment is available");
  });
});

describe("BatchSchema persona optionality", () => {
  const draft = {
    subject: "s",
    body: "b",
    axes: {
      opener: "signal",
      tone: "warm",
      close: "question",
      greeting: "hi",
      signoff: "name",
    },
  };

  it("accepts a response without a persona (real-recipient mode)", () => {
    expect(BatchSchema.safeParse({ drafts: [draft, draft] }).success).toBe(
      true,
    );
  });

  it("still accepts a response with a persona (invented mode)", () => {
    const persona = {
      name: "A",
      title: "T",
      company: "C",
      situation: "S",
      signals: ["x"],
    };
    expect(
      BatchSchema.safeParse({ persona, drafts: [draft, draft] }).success,
    ).toBe(true);
  });
});
