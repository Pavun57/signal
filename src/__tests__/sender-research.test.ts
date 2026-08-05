import { describe, expect, it } from "vitest";
import { dedupeFacts, factsFromModel } from "@/lib/services/sender-research";

describe("dedupeFacts", () => {
  it("drops a fact already in the bank, ignoring case and punctuation", () => {
    const existing = [{ fact: "Grew Signal to 200 customers." }];
    const fresh = [
      { category: "proof_point", fact: "grew signal to 200 customers" },
      { category: "pov", fact: "Cold email should read like a text" },
    ];
    expect(dedupeFacts(fresh, existing)).toHaveLength(1);
    expect(dedupeFacts(fresh, existing)[0].category).toBe("pov");
  });

  it("normalizes whitespace when comparing", () => {
    const existing = [{ fact: "Started   as employee #1" }];
    const fresh = [{ category: "story", fact: "Started as employee #1." }];
    expect(dedupeFacts(fresh, existing)).toHaveLength(0);
  });

  it("dedupes fresh facts against themselves", () => {
    const fresh = [
      { category: "pov", fact: "Cold email should read like a text." },
      { category: "pov", fact: "cold email should read like a text" },
    ];
    expect(dedupeFacts(fresh, [])).toHaveLength(1);
  });

  it("keeps everything when nothing collides", () => {
    const fresh = [
      { category: "background", fact: "Ex-Stripe engineer" },
      { category: "personal", fact: "Runs marathons" },
    ];
    expect(
      dedupeFacts(fresh, [{ fact: "Grew Signal to 200 customers" }]),
    ).toHaveLength(2);
  });
});

describe("factsFromModel", () => {
  it("drops facts with unknown categories and over-length facts", () => {
    const out = factsFromModel([
      { category: "proof_point", fact: "x".repeat(600) },
      { category: "made_up", fact: "hi" },
      { category: "story", fact: "Started as employee #1" },
    ]);
    expect(out).toEqual([
      { category: "story", fact: "Started as employee #1" },
    ]);
  });

  it("keeps every valid category", () => {
    const out = factsFromModel([
      { category: "background", fact: "a" },
      { category: "proof_point", fact: "b" },
      { category: "story", fact: "c" },
      { category: "pov", fact: "d" },
      { category: "credibility", fact: "e" },
      { category: "personal", fact: "f" },
    ]);
    expect(out).toHaveLength(6);
  });

  it("drops empty and whitespace-only facts", () => {
    const out = factsFromModel([
      { category: "pov", fact: "   " },
      { category: "pov", fact: "" },
      { category: "pov", fact: "Real opinion" },
    ]);
    expect(out).toEqual([{ category: "pov", fact: "Real opinion" }]);
  });
});
