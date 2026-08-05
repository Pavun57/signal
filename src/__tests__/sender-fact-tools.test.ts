import { describe, expect, it } from "vitest";
import type { z } from "zod";

import { FACT_CATEGORIES } from "@/lib/sender-facts";
import {
  addSenderFacts,
  groupFactsByCategory,
  listSenderFacts,
  researchSenderProfile,
} from "@/lib/tools/sender-fact-tools";

const PROFILE_ID = "3b9f4f6e-2f1a-4c8e-9d2b-1a2b3c4d5e6f";

const addSchema = addSenderFacts.inputSchema as z.ZodTypeAny;
const researchSchema = researchSenderProfile.inputSchema as z.ZodTypeAny;
const listSchema = listSenderFacts.inputSchema as z.ZodTypeAny;

const validFact = {
  category: "proof_point",
  fact: "Grew Signal to 200 customers in 6 months",
};

describe("addSenderFacts input schema", () => {
  it("accepts a valid batch, with or without profileId", () => {
    expect(addSchema.safeParse({ facts: [validFact] }).success).toBe(true);
    expect(
      addSchema.safeParse({ profileId: PROFILE_ID, facts: [validFact] })
        .success,
    ).toBe(true);
  });

  it("rejects a category outside FACT_CATEGORIES", () => {
    expect(
      addSchema.safeParse({
        facts: [{ category: "nonsense", fact: "Something" }],
      }).success,
    ).toBe(false);
  });

  it("rejects an empty facts array", () => {
    expect(addSchema.safeParse({ facts: [] }).success).toBe(false);
  });

  it("rejects more than 10 facts", () => {
    const facts = Array.from({ length: 11 }, () => validFact);
    expect(addSchema.safeParse({ facts }).success).toBe(false);
    expect(addSchema.safeParse({ facts: facts.slice(0, 10) }).success).toBe(
      true,
    );
  });

  it("rejects an empty fact and one over 500 chars", () => {
    expect(
      addSchema.safeParse({ facts: [{ category: "story", fact: "" }] }).success,
    ).toBe(false);
    expect(
      addSchema.safeParse({
        facts: [{ category: "story", fact: "x".repeat(501) }],
      }).success,
    ).toBe(false);
    expect(
      addSchema.safeParse({
        facts: [{ category: "story", fact: "x".repeat(500) }],
      }).success,
    ).toBe(true);
  });

  it("rejects a non-uuid profileId", () => {
    expect(
      addSchema.safeParse({ profileId: "not-a-uuid", facts: [validFact] })
        .success,
    ).toBe(false);
  });

  it("accepts every canonical category", () => {
    for (const category of FACT_CATEGORIES) {
      expect(
        addSchema.safeParse({ facts: [{ category, fact: "A fact" }] }).success,
      ).toBe(true);
    }
  });
});

describe("researchSenderProfile / listSenderFacts input schemas", () => {
  it("accept an empty input (profileId optional)", () => {
    expect(researchSchema.safeParse({}).success).toBe(true);
    expect(listSchema.safeParse({}).success).toBe(true);
  });

  it("validate profileId as a uuid", () => {
    expect(researchSchema.safeParse({ profileId: PROFILE_ID }).success).toBe(
      true,
    );
    expect(researchSchema.safeParse({ profileId: "nope" }).success).toBe(false);
    expect(listSchema.safeParse({ profileId: "nope" }).success).toBe(false);
  });
});

describe("groupFactsByCategory", () => {
  it("orders groups by FACT_CATEGORIES, not insertion order", () => {
    const grouped = groupFactsByCategory([
      { category: "personal", fact: "Runs marathons" },
      { category: "background", fact: "Ex-Stripe engineer" },
      { category: "proof_point", fact: "200 customers" },
    ]);
    expect(grouped.map((g) => g.category)).toEqual([
      "background",
      "proof_point",
      "personal",
    ]);
  });

  it("drops empty categories instead of emitting empty groups", () => {
    const grouped = groupFactsByCategory([
      { category: "pov", fact: "Cold email should read like a text" },
    ]);
    expect(grouped).toEqual([
      { category: "pov", facts: ["Cold email should read like a text"] },
    ]);
  });

  it("keeps insertion order within a category and drops unknown categories", () => {
    const grouped = groupFactsByCategory([
      { category: "story", fact: "First" },
      { category: "mystery", fact: "Should vanish" },
      { category: "story", fact: "Second" },
    ]);
    expect(grouped).toEqual([
      { category: "story", facts: ["First", "Second"] },
    ]);
  });

  it("returns an empty array for an empty bank", () => {
    expect(groupFactsByCategory([])).toEqual([]);
  });
});
