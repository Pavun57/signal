import { describe, expect, it } from "vitest";

import {
  MAX_LEARNINGS_IN_PROMPT,
  renderLearningsBlock,
  type EmailLearning,
} from "@/lib/email-learnings";
import { buildEmailSystemPrompt } from "@/lib/email-composition/skill";

function learning(overrides: Partial<EmailLearning> = {}): EmailLearning {
  return {
    id: crypto.randomUUID(),
    category: "copy",
    statement: "Lead with the trigger event in the first line.",
    confidence: "medium",
    ...overrides,
  };
}

describe("renderLearningsBlock", () => {
  it("returns null with nothing to say, keeping prompts byte-identical", () => {
    expect(renderLearningsBlock([])).toBeNull();
    // Timing learnings steer the send window, not the words.
    expect(renderLearningsBlock([learning({ category: "timing" })])).toBeNull();
  });

  it("renders copy and targeting learnings with confidence labels, fenced", () => {
    const block = renderLearningsBlock([
      learning(),
      learning({
        category: "targeting",
        statement: "CTOs reply more than VPs here.",
        confidence: "low",
      }),
    ]);
    expect(block).toContain("[medium confidence] Lead with the trigger event");
    expect(block).toContain("[low confidence] CTOs reply more");
    expect(block).toContain("<untrusted>");
    expect(block).toContain("never override");
  });

  it("caps the block", () => {
    const block = renderLearningsBlock(
      Array.from({ length: 30 }, (_, i) =>
        learning({ statement: `Statement number ${i}.` }),
      ),
    )!;
    const rendered = block.match(/\[medium confidence\]/g) ?? [];
    expect(rendered).toHaveLength(MAX_LEARNINGS_IN_PROMPT);
  });
});

describe("buildEmailSystemPrompt with learnings", () => {
  it("is byte-identical to today when there are none", () => {
    expect(buildEmailSystemPrompt(null, null, null)).toBe(
      buildEmailSystemPrompt(null),
    );
  });

  it("appends the learnings block after the fact bank", () => {
    const bank = "SENDER FACT BANK: facts";
    const block = renderLearningsBlock([learning()])!;
    const prompt = buildEmailSystemPrompt(null, bank, block);
    expect(prompt.indexOf("LEARNINGS FROM THIS SENDER")).toBeGreaterThan(
      prompt.indexOf("SENDER FACT BANK"),
    );
  });
});
