import { describe, expect, it } from "vitest";

import {
  POSITIVE_INTENTS,
  REAL_REPLY_INTENTS,
  REPLY_INTENTS,
  ReplyIntentSchema,
  shouldSuppress,
  suppressionReason,
} from "@/lib/services/reply-intent";

/**
 * The suppression decision is the one place a classifier verdict turns into
 * "never email this person again", so its thresholds are pinned here: a
 * change to them should be a deliberate edit to this file, not a drive-by.
 */

describe("shouldSuppress", () => {
  it("suppresses unsubscribe at any confidence", () => {
    expect(shouldSuppress("unsubscribe", 0)).toBe(true);
    expect(shouldSuppress("unsubscribe", 0.3)).toBe(true);
    expect(shouldSuppress("unsubscribe", 1)).toBe(true);
  });

  it("suppresses not_interested only at high confidence", () => {
    expect(shouldSuppress("not_interested", 0.79)).toBe(false);
    expect(shouldSuppress("not_interested", 0.8)).toBe(true);
    expect(shouldSuppress("not_interested", 1)).toBe(true);
  });

  it("never suppresses engaged or automatic intents", () => {
    for (const intent of [
      "interested",
      "question",
      "ooo",
      "referral",
      "other",
    ] as const) {
      expect(shouldSuppress(intent, 1)).toBe(false);
    }
  });
});

describe("suppressionReason", () => {
  it("maps suppress-worthy intents to their reason and everything else to null", () => {
    expect(suppressionReason("unsubscribe")).toBe("unsubscribe");
    expect(suppressionReason("not_interested")).toBe("not_interested");
    expect(suppressionReason("interested")).toBeNull();
    expect(suppressionReason("ooo")).toBeNull();
  });
});

describe("intent sets", () => {
  it("classifies every intent as real-or-not; ooo is the only non-reply", () => {
    const real = REPLY_INTENTS.filter((i) => REAL_REPLY_INTENTS.has(i));
    expect(real).toEqual(REPLY_INTENTS.filter((i) => i !== "ooo"));
  });

  it("positive intents are a subset of real replies", () => {
    for (const intent of POSITIVE_INTENTS) {
      expect(REAL_REPLY_INTENTS.has(intent)).toBe(true);
    }
  });
});

describe("ReplyIntentSchema", () => {
  it("accepts a well-formed verdict", () => {
    const parsed = ReplyIntentSchema.safeParse({
      intent: "interested",
      confidence: 0.9,
      reasoning: "Asks for a demo next week.",
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects unknown intents and out-of-range confidence", () => {
    expect(
      ReplyIntentSchema.safeParse({
        intent: "spam",
        confidence: 0.9,
        reasoning: "x",
      }).success,
    ).toBe(false);
    expect(
      ReplyIntentSchema.safeParse({
        intent: "interested",
        confidence: 1.2,
        reasoning: "x",
      }).success,
    ).toBe(false);
  });
});
