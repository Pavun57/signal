import { describe, expect, it } from "vitest";

import {
  FACT_CATEGORIES,
  renderFactBank,
  type SenderFact,
} from "@/lib/sender-facts";

const fact = (over: Partial<SenderFact>): SenderFact => ({
  id: "f1",
  category: "proof_point",
  fact: "Grew Signal to 200 customers in 6 months",
  source: "research",
  ...over,
});

describe("renderFactBank", () => {
  it("returns null for an empty bank so prompts render exactly as today", () => {
    expect(renderFactBank([])).toBeNull();
  });

  it("groups facts under category headings, in canonical order", () => {
    const block = renderFactBank([
      fact({
        category: "story",
        fact: "Started out cold-calling as employee #1",
      }),
      fact({ category: "proof_point" }),
    ])!;
    const proofIdx = block.indexOf("proof_point");
    const storyIdx = block.indexOf("story");
    expect(proofIdx).toBeGreaterThan(-1);
    expect(proofIdx).toBeLessThan(storyIdx); // canonical order, not insert order
    expect(block).toContain("Grew Signal to 200 customers");
  });

  it("fences the facts as untrusted content", () => {
    const block = renderFactBank([fact({})])!;
    // wrapUntrusted emits literal <untrusted>...</untrusted> tags.
    expect(block).toContain("<untrusted>");
    expect(block).toContain("</untrusted>");
    // The facts themselves must sit inside the fence, not before it.
    expect(block.indexOf("<untrusted>")).toBeLessThan(
      block.indexOf("Grew Signal to 200 customers"),
    );
  });

  it("carries the selection rule: at most two, zero is fine, never invent", () => {
    const block = renderFactBank([fact({})])!;
    expect(block).toMatch(/at most (one or two|two)/i);
    expect(block).toMatch(/zero/i);
    expect(block).toMatch(/never invent/i);
  });

  it("drops unknown categories instead of throwing on bad rows", () => {
    expect(
      renderFactBank([fact({ category: "nonsense" as never })]),
    ).toBeNull();
  });

  it("exports the canonical categories the DB comment promises", () => {
    expect(FACT_CATEGORIES).toEqual([
      "background",
      "proof_point",
      "story",
      "pov",
      "credibility",
      "personal",
    ]);
  });
});
