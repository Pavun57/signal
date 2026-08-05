import { describe, expect, it } from "vitest";
import {
  buildComposeUserPrompt,
  buildEmailSystemPrompt,
} from "@/lib/email-composition/skill";
import { renderFactBank } from "@/lib/sender-facts";

const baseInput = {
  contact: { name: "A", title: null, email: "a@b.co", enrichmentData: null },
  company: null,
  step: { stepNumber: 1, totalSteps: 1, condition: "always", isFinal: false },
  campaign: { name: "C", icp: null, offering: null, positioning: null },
  senderProfile: {
    name: "Jay",
    title: "Founder",
    company: "Signal",
    signature: null,
    offeringSummary: "AI sales agent",
    notes: "prefers plain speech",
  },
};

describe("buildEmailSystemPrompt with a fact bank", () => {
  const bank = renderFactBank([
    { id: "1", category: "proof_point", fact: "200 customers", source: "user" },
  ])!;

  it("appends the fact bank after the voice profile", () => {
    const sys = buildEmailSystemPrompt(null, bank);
    expect(sys).toContain("SENDER FACT BANK");
    expect(sys).toContain("200 customers");
  });

  it("is byte-identical to today when there is no bank", () => {
    expect(buildEmailSystemPrompt(null, null)).toBe(
      buildEmailSystemPrompt(null),
    );
  });
});

describe("buildComposeUserPrompt sender fields", () => {
  it("carries offering summary and notes that were previously dropped", () => {
    const prompt = buildComposeUserPrompt(baseInput);
    expect(prompt).toContain("AI sales agent");
    expect(prompt).toContain("prefers plain speech");
  });

  it("omits the lines when unset instead of printing placeholders", () => {
    const prompt = buildComposeUserPrompt({
      ...baseInput,
      senderProfile: {
        ...baseInput.senderProfile,
        offeringSummary: null,
        notes: null,
      },
    });
    expect(prompt).not.toContain("Offering summary");
    expect(prompt).not.toContain("Sender notes");
  });
});
