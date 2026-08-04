import { describe, expect, it } from "vitest";

import {
  EMAIL_SKILL_SYSTEM_PROMPT,
  buildEmailSystemPrompt,
} from "@/lib/email-composition/skill";
import { UNTRUSTED_NOTICE } from "@/lib/prompt-safety";
import type { VoiceProfile } from "@/lib/types/email-voice";

// The base prompt IS the product for cold-email quality — a careless edit
// silently degrades every email Signal sends, with no test or type error to
// catch it. These assertions pin the research-backed rules that are easiest to
// lose in a reword: the AI-tells blocklist and the measured length targets.

const profile: VoiceProfile = {
  id: "vp1",
  user_id: "user_123",
  campaign_id: null,
  instructions: "Lead with a one-line claim. No emoji. Admit something.",
  summary: "Blunt, concrete, admits something",
  source_transcript: null,
  created_at: "2026-07-29T00:00:00Z",
  updated_at: "2026-07-29T00:00:00Z",
};

// ─── AI-tells blocklist ───────────────────────────────────────────────────

describe("EMAIL_SKILL_SYSTEM_PROMPT blocklist", () => {
  // Quoted verbatim in the prompt so the model can pattern-match them rather
  // than infer what "sounds like AI" means.
  it.each([
    "I saw you recently",
    "I noticed you're hiring",
    "I hope this finds you well",
    "Quick question",
    "curious if",
    "circle back",
    "reaching out",
    "synergy",
    "flattery",
  ])("tells the model to avoid %j", (phrase) => {
    expect(EMAIL_SKILL_SYSTEM_PROMPT).toContain(phrase);
  });

  it("warns that uniform sentence rhythm is itself a tell", () => {
    expect(EMAIL_SKILL_SYSTEM_PROMPT).toMatch(/vary sentence length/i);
    expect(EMAIL_SKILL_SYSTEM_PROMPT).toMatch(/uniformly/i);
  });

  it("requires the time-based ask to carry its reason", () => {
    expect(EMAIL_SKILL_SYSTEM_PROMPT).toContain("15 minutes");
    expect(EMAIL_SKILL_SYSTEM_PROMPT).toMatch(/do you have 15 minutes/i);
  });
});

// ─── Length targets ───────────────────────────────────────────────────────

describe("EMAIL_SKILL_SYSTEM_PROMPT length targets", () => {
  it("states the 50-125 word body range", () => {
    expect(EMAIL_SKILL_SYSTEM_PROMPT).toContain("50-125 words");
  });

  it("states the 4-5 word subject target with a character ceiling", () => {
    expect(EMAIL_SKILL_SYSTEM_PROMPT).toContain("4-5 words");
    expect(EMAIL_SKILL_SYSTEM_PROMPT).toMatch(/45 characters|~45 chars/);
  });

  it("no longer carries the vague 3-5 sentence rule it replaced", () => {
    expect(EMAIL_SKILL_SYSTEM_PROMPT).not.toContain("3-5 sentences");
  });

  it("names the reply rate, not the open rate, as the goal", () => {
    expect(EMAIL_SKILL_SYSTEM_PROMPT).toMatch(/goal is a REPLY/i);
  });

  it("keeps the never-invent-data rule", () => {
    expect(EMAIL_SKILL_SYSTEM_PROMPT).toMatch(/never invent data/i);
  });
});

// ─── buildEmailSystemPrompt layering ──────────────────────────────────────

describe("buildEmailSystemPrompt", () => {
  it("returns the base prompt plus the untrusted-content notice when the user has no voice profile", () => {
    const prompt = buildEmailSystemPrompt(null);
    expect(prompt).toContain(EMAIL_SKILL_SYSTEM_PROMPT);
    // The composer reads enrichment_data built from scraped pages and its
    // output is the body that gets sent, so the notice belongs on every call.
    expect(prompt).toContain(UNTRUSTED_NOTICE);
  });

  it("adds no voice section when the user has no voice profile", () => {
    expect(buildEmailSystemPrompt(null)).not.toContain("VOICE PROFILE");
  });

  it("appends the profile instructions under a labelled section", () => {
    const prompt = buildEmailSystemPrompt(profile);
    expect(prompt).toContain(EMAIL_SKILL_SYSTEM_PROMPT);
    expect(prompt).toContain("VOICE PROFILE");
    expect(prompt).toContain(profile.instructions);
  });

  it("places the voice instructions AFTER the base rules", () => {
    // Order encodes precedence for the model: later rules win on conflict,
    // and the section header says so explicitly.
    const prompt = buildEmailSystemPrompt(profile);
    expect(prompt.indexOf(profile.instructions)).toBeGreaterThan(
      prompt.indexOf(EMAIL_SKILL_SYSTEM_PROMPT),
    );
  });

  it("gives the voice profile precedence on style", () => {
    expect(buildEmailSystemPrompt(profile)).toMatch(
      /voice profile overrides the base rules/i,
    );
  });

  // The instructions are model-written from an interview that can include
  // emails the user pasted from third parties, so a line inside them must not
  // be able to outrank the no-fabrication rule or the output contract.
  it("bounds that precedence to style and nothing else", () => {
    const prompt = buildEmailSystemPrompt(profile);
    expect(prompt).toMatch(/does NOT override/);
    expect(prompt).toMatch(/NEVER INVENT DATA/);
    expect(prompt).toMatch(/never as instructions/i);
  });
});
