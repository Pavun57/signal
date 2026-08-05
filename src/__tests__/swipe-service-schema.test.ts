import { describe, expect, it } from "vitest";

import { TranscriptSchema } from "@/lib/email-skills/swipe-service";
import { buildBatchPrompt } from "@/lib/email-skills/swipe-prompts";
import type { SwipeTranscript } from "@/lib/email-skills/swipe-prompts";

/**
 * The wire schema is where a judged draft's fields live or die: Zod's default
 * strip mode silently drops anything not declared. The persona label rode the
 * client run but never the schema, so the "never reuse a persona" rule had
 * nothing to check against in production while the prompt-level test passed.
 * These tests go through the schema first, like the chat route does.
 */

const judged = {
  subject: "s",
  body: "b",
  axes: {
    opener: "signal",
    tone: "blunt",
    close: "question",
    greeting: "hi",
    signoff: "name",
  },
  kept: true,
  personaLabel: "Riya Shah · VP Sales, Northbeam Labs",
};

describe("TranscriptSchema personaLabel round-trip", () => {
  it("keeps the persona label through the wire schema into the prompt", () => {
    const parsed = TranscriptSchema.parse({
      judged: [judged],
      instructions: [],
    });
    const prompt = buildBatchPrompt(parsed as unknown as SwipeTranscript, 4);
    expect(prompt).toContain("Riya Shah");
  });

  it("still accepts pre-persona judged drafts without the field", () => {
    const legacy = { ...judged, personaLabel: undefined };
    const parsed = TranscriptSchema.parse({
      judged: [legacy],
      instructions: [],
    });
    expect(parsed.judged[0].personaLabel).toBeUndefined();
  });

  it("bounds the label like every other client-controlled string", () => {
    const result = TranscriptSchema.safeParse({
      judged: [{ ...judged, personaLabel: "x".repeat(201) }],
      instructions: [],
    });
    expect(result.success).toBe(false);
  });
});
