import { describe, expect, it } from "vitest";

import { estimateLlmCostFromUsage } from "@/lib/services/cost-tracker";

describe("llm cost estimate", () => {
  it("prices usage at the configured per-MTok rates (defaults $3/$15)", () => {
    // K18: the email composer's spend was never trackable because its tier
    // did not exist in PRICING; the env-rate estimator covers every model.
    const cost = estimateLlmCostFromUsage({
      inputTokens: 100_000,
      outputTokens: 10_000,
    });
    // 0.1 MTok * $3 + 0.01 MTok * $15
    expect(cost).toBeCloseTo(0.45, 6);
  });

  it("tolerates missing token fields", () => {
    expect(estimateLlmCostFromUsage({})).toBe(0);
  });
});
