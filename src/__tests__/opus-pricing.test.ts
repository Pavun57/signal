import { describe, expect, it } from "vitest";

import {
  estimateClaudeCost,
  estimateClaudeCostFromUsage,
} from "@/lib/services/cost-tracker";

describe("opus pricing tier", () => {
  it("prices claude-opus-5 usage at $5/$25 per MTok", () => {
    // K18: the email composer runs on Opus and its spend was never
    // trackable because the tier did not exist in PRICING.
    const cost = estimateClaudeCost({
      model: "opus",
      inputTokens: 100_000,
      outputTokens: 10_000,
    });
    // 0.1 MTok * $5 + 0.01 MTok * $25
    expect(cost).toBeCloseTo(0.75, 6);
  });

  it("prices cache reads and writes at the opus multipliers", () => {
    const cost = estimateClaudeCostFromUsage("opus", {
      inputTokens: 100_000,
      outputTokens: 0,
      inputTokenDetails: { cacheReadTokens: 80_000, cacheWriteTokens: 20_000 },
    });
    // 0 uncached + 0.08 MTok * $0.50 + 0.02 MTok * $6.25
    expect(cost).toBeCloseTo(0.04 + 0.125, 6);
  });
});
