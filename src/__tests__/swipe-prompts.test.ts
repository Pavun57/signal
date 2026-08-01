import { describe, expect, it } from "vitest";

import {
  MAX_ENRICHMENT_CHARS,
  buildBatchSystem,
  buildSkillSystem,
  normaliseInstructions,
  recipientLabel,
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
      sender: { name: "Jay", roleTitle: "Founder", companyName: "Arbor" },
      recipient: {
        name: "Dana Whitfield",
        title: "VP Engineering",
        company: "Fernpath",
      },
    });
    // The bug this guards: names lived on the campaign object, so a missing
    // campaign row silently dropped them and the model invented its own.
    expect(sys).toContain("Jay");
    expect(sys).toContain("Dana Whitfield");
    expect(sys).toContain("No campaign context is available");
  });

  it("passes the whole sender profile through, not just the name", () => {
    const sys = buildBatchSystem(null, {
      sender: {
        name: "Jay",
        roleTitle: "Founder",
        companyName: "Arbor",
        offeringSummary: "usage metering to invoice for API companies",
      },
    });
    expect(sys).toContain("Founder");
    expect(sys).toContain("Arbor");
    expect(sys).toContain("usage metering to invoice");
  });

  it("fences untrusted campaign content", () => {
    const sys = buildBatchSystem(
      { name: "Arbor", icp: {}, offering: {}, positioning: {} },
      {},
    );
    expect(sys).toContain("<untrusted>");
    expect(sys).toContain("Arbor");
  });

  it("says nothing is known when neither side was resolved", () => {
    const sys = buildBatchSystem(null, {});
    expect(sys).toContain("WHO THESE ARE FROM: not known");
    expect(sys).toContain("WHO THESE ARE TO: nobody specific");
    // Degrading to a generic run is the point; it must not start demanding
    // facts it was never given.
    expect(sys).not.toContain("NEVER INVENT DATA");
  });

  it("adds the no-fabrication rule as soon as a real person is named", () => {
    // Not gated on enrichment: a real name and a real company are enough for
    // an invented funding round to be a lie about someone who exists.
    const sys = buildBatchSystem(null, {
      recipient: { name: "Dana Whitfield", company: "Fernpath" },
    });
    expect(sys).toContain("NEVER INVENT DATA");
    expect(sys).toContain("This outranks the variation rule");
  });

  it("renders enrichment inside the untrusted fence and truncates it", () => {
    const enrichmentData = { bio: "x".repeat(MAX_ENRICHMENT_CHARS * 2) };
    const sys = buildBatchSystem(null, {
      recipient: { name: "Dana Whitfield", enrichmentData },
    });
    expect(sys).toContain("Enrichment (LinkedIn, Twitter, news, background)");
    expect(sys).not.toContain("x".repeat(MAX_ENRICHMENT_CHARS + 1));
    // The blob comes from scraped pages and third-party APIs, so it is the
    // most likely place in this prompt for injected instructions to arrive.
    expect(sys.indexOf("<untrusted>")).toBeLessThan(
      sys.indexOf("Enrichment ("),
    );
  });

  it("omits the enrichment block when the contact has none", () => {
    const sys = buildBatchSystem(null, {
      recipient: { name: "Dana Whitfield", enrichmentData: null },
    });
    expect(sys).toContain("Dana Whitfield");
    expect(sys).not.toContain("Enrichment (");
  });
});

describe("buildSkillSystem", () => {
  it("gets the same persona context as the batch prompt", () => {
    const sys = buildSkillSystem(null, {
      sender: { name: "Jay" },
      recipient: { name: "Dana Whitfield" },
    });
    expect(sys).toContain("Jay");
    expect(sys).toContain("Dana Whitfield");
  });
});

describe("recipientLabel", () => {
  it("reads as a To line", () => {
    expect(
      recipientLabel({
        name: "Dana Whitfield",
        title: "VP Engineering",
        company: "Fernpath",
      }),
    ).toBe("Dana Whitfield · VP Engineering, Fernpath");
  });

  it("drops the parts that are missing", () => {
    expect(
      recipientLabel({ name: "Dana Whitfield", company: "Fernpath" }),
    ).toBe("Dana Whitfield · Fernpath");
    expect(recipientLabel({ name: "Dana Whitfield" })).toBe("Dana Whitfield");
  });

  it("is null without a name, so the card never says 'To ,'", () => {
    expect(recipientLabel(null)).toBeNull();
    expect(recipientLabel({ title: "VP Engineering" })).toBeNull();
    expect(recipientLabel({ name: "   " })).toBeNull();
  });
});
