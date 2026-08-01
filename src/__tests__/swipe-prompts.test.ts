import { describe, expect, it } from "vitest";

import {
  buildBatchSystem,
  normaliseInstructions,
} from "@/lib/email-skills/swipe-prompts";

describe("normaliseInstructions", () => {
  it("drops a verbatim repeat (observed in a real run)", () => {
    const raw = [
      "Open with “Dana,” on its own line.",
      "Never use em dashes. Use a period or a comma instead.",
      "Never use em dashes. Use a period or a comma instead.",
      "Sign off with just “Jay”.",
    ].join("\n");
    expect(normaliseInstructions(raw).split("\n")).toHaveLength(3);
  });

  it("collapses case, spacing and trailing punctuation variants", () => {
    const raw = "Never use em dashes\nnever  use   em dashes.\nKeep it short.";
    expect(normaliseInstructions(raw).split("\n")).toHaveLength(2);
  });

  it("strips list markers and blank lines but preserves order", () => {
    const raw = "\n- First rule\n\n• Second rule\n* Third rule\n";
    expect(normaliseInstructions(raw)).toBe(
      "First rule\nSecond rule\nThird rule",
    );
  });

  it("leaves genuinely distinct rules alone", () => {
    const raw = "No em dashes.\nNo exclamation marks.\nNo emoji.";
    expect(normaliseInstructions(raw).split("\n")).toHaveLength(3);
  });
});

describe("buildBatchSystem", () => {
  it("carries sender and recipient even with no campaign", () => {
    const sys = buildBatchSystem(null, {
      senderName: "Jay",
      recipient: "Dana Whitfield, VP Engineering at Fernpath",
    });
    // The bug this guards: names lived on the campaign object, so a missing
    // campaign row silently dropped them and the model invented its own.
    expect(sys).toContain("Jay");
    expect(sys).toContain("Dana Whitfield");
    expect(sys).toContain("No campaign context is available");
  });

  it("fences untrusted campaign content", () => {
    const sys = buildBatchSystem(
      { name: "Arbor", icp: {}, offering: {}, positioning: {} },
      {},
    );
    expect(sys).toContain("<untrusted>");
    expect(sys).toContain("Arbor");
  });
});
