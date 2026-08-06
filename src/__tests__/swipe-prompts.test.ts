import { describe, expect, it } from "vitest";

import {
  BatchSchema,
  MAX_SAMPLE_CHARS,
  buildBatchPrompt,
  buildBatchSystem,
  buildRefinementTranscript,
  buildSkillPrompt,
  buildSkillSystem,
  normaliseInstructions,
  personaLabel,
  type JudgedDraft,
} from "@/lib/email-skills/swipe-prompts";

const judged = (subject: string, kept: boolean): JudgedDraft => ({
  subject,
  body: "Saw the release notes. Worth 15 minutes?",
  axes: {
    opener: "signal",
    tone: "blunt",
    close: "question",
    greeting: "firstname",
    signoff: "name",
  },
  kept,
});

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
  it("carries the sender even with no campaign", () => {
    const sys = buildBatchSystem(null, {
      sender: { name: "Jay", roleTitle: "Founder", companyName: "Arbor" },
    });
    // The bug this guards: the sender lived on the campaign object, so a
    // missing campaign row silently dropped it and the model invented its own.
    expect(sys).toContain("Jay");
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

  it("says the sender is unknown rather than letting the model invent one", () => {
    const sys = buildBatchSystem(null, {});
    expect(sys).toContain("WHO THESE ARE FROM: not known");
  });

  it("appends the sender fact bank after the profile rows, without re-fencing it", () => {
    const sys = buildBatchSystem(null, {
      sender: {
        name: "Jay",
        factBank:
          "SENDER FACT BANK: true facts about the sender.\n<untrusted>\nproof_point:\n- Grew Signal to 200 customers\n</untrusted>",
      },
    });
    expect(sys).toContain("SENDER FACT BANK");
    expect(sys).toContain("Grew Signal to 200 customers");
    expect(sys.indexOf("Jay")).toBeLessThan(sys.indexOf("SENDER FACT BANK"));
    // renderFactBank already fenced it; wrapping it again would escape the
    // inner fence and expose the facts as trusted prompt.
    expect(sys).not.toContain("&lt;untrusted");
  });
});

describe("buildRefinementTranscript", () => {
  const saved = {
    instructions: "Open on the signal.\nSign off with just the first name.",
    summary: "Blunt and signal-first.",
  };

  it("carries the saved rules through and appends the change request", () => {
    const t = buildRefinementTranscript(saved, "Stop being so formal");
    expect(t.prior?.instructions).toContain("Open on the signal.");
    expect(t.prior?.summary).toBe("Blunt and signal-first.");
    // Last, so the ranking's "they are correcting themselves" reads in order.
    expect(t.instructions.at(-1)).toBe("Stop being so formal");
  });

  it("replays the run behind the rules rather than starting from one sentence", () => {
    const t = buildRefinementTranscript(
      {
        ...saved,
        source_transcript: {
          judged: [judged("Release notes", true)],
          instructions: ["shorter"],
          samples: ["Hi Dana, quick one."],
        },
      },
      "Make it blunter",
    );
    expect(t.judged).toHaveLength(1);
    expect(t.instructions).toEqual(["shorter", "Make it blunter"]);
    expect(t.samples).toEqual(["Hi Dana, quick one."]);
  });

  it("ignores an interview transcript instead of mistaking it for a run", () => {
    // The interview stores an array of turns in the same column. Replaying it
    // here would claim drafts were judged that never were.
    const t = buildRefinementTranscript(
      {
        ...saved,
        source_transcript: [
          {
            move: { kind: "question", prompt: "How do you open?" },
            answer: "Blunt",
          },
        ],
      },
      "Warmer",
    );
    expect(t.judged).toEqual([]);
    expect(t.instructions).toEqual(["Warmer"]);
    expect(t.prior?.instructions).toContain("Open on the signal.");
  });

  it("survives a profile with no transcript at all", () => {
    const t = buildRefinementTranscript(
      { instructions: "Be blunt.", summary: null, source_transcript: null },
      "Less blunt",
    );
    expect(t.judged).toEqual([]);
    expect(t.samples).toBeUndefined();
    expect(t.prior?.summary).toBeNull();
  });
});

describe("buildSkillPrompt", () => {
  it("shows the rules being changed and asks for the complete set back", () => {
    const prompt = buildSkillPrompt(
      buildRefinementTranscript(
        { instructions: "Open on the signal.", summary: null },
        "Stop asking for a call",
      ),
    );
    expect(prompt).toContain("THE RULES THEY ARE ALREADY WRITING WITH");
    expect(prompt).toContain("Open on the signal.");
    expect(prompt).toContain("return the complete set");
    // A refinement of an interview-built voice has nothing judged, and saying
    // so invites the model to write the thin-evidence apology instead of rules.
    expect(prompt).not.toContain("judged 0 drafts");
  });

  it("counts the run for a fresh voice", () => {
    const prompt = buildSkillPrompt({
      judged: [judged("A", true), judged("B", false)],
      instructions: ["shorter"],
    });
    expect(prompt).toContain("judged 2 drafts, keeping 1");
    expect(prompt).toContain("Write their voice rules.");
    expect(prompt).not.toContain("THE RULES THEY ARE ALREADY WRITING WITH");
  });

  it("carries pasted emails through to the rules", () => {
    const prompt = buildSkillPrompt({
      judged: [judged("A", true)],
      instructions: [],
      samples: ["Dana, saw the release. Worth 15 minutes?"],
    });
    expect(prompt).toContain("EMAILS THEY HAVE ACTUALLY SENT");
    expect(prompt).toContain("Worth 15 minutes?");
    expect(prompt).toContain("pasted 1 email(s) they had sent");
  });

  it("says nothing about samples when the step was skipped", () => {
    const prompt = buildSkillPrompt({
      judged: [judged("A", true)],
      instructions: [],
      samples: ["", "   "],
    });
    expect(prompt).not.toContain("EMAILS THEY HAVE ACTUALLY SENT");
    expect(prompt).not.toContain("pasted");
  });
});

describe("samples in the batch prompt", () => {
  it("fences them and keeps the opening-batch note", () => {
    const prompt = buildBatchPrompt(
      {
        judged: [],
        instructions: [],
        samples: ["Dana, saw the release. Worth 15 minutes?"],
      },
      6,
    );
    // Pasted mail is third-party correspondence the user never wrote, and the
    // step is an open invitation to paste anything at all.
    expect(prompt.indexOf("<untrusted>")).toBeLessThan(
      prompt.indexOf("Worth 15 minutes?"),
    );
    expect(prompt).toContain("Nothing judged yet. This is the opening batch.");
  });

  it("truncates a paste far longer than the voice needs", () => {
    const prompt = buildBatchPrompt(
      {
        judged: [],
        instructions: [],
        samples: ["x".repeat(MAX_SAMPLE_CHARS * 3)],
      },
      6,
    );
    expect(prompt).not.toContain("x".repeat(MAX_SAMPLE_CHARS + 1));
  });

  it("tells the batch to write in that register without cloning it", () => {
    const sys = buildBatchSystem(null, {});
    expect(sys).toContain("If they pasted emails they have actually sent");
    // Otherwise the batch converges on their samples and every swipe after the
    // first stops carrying information.
    expect(sys).toContain("Keep varying across the axes");
  });
});

describe("buildSkillSystem", () => {
  it("tells the model a refinement replaces rather than diffs", () => {
    const sys = buildSkillSystem(null, {});
    expect(sys).toContain("When they already have rules");
    expect(sys).toContain("Return the complete replacement set");
  });

  it("ranks what they pasted above every reaction to somebody else's copy", () => {
    const sys = buildSkillSystem(null, {});
    const rank = (s: string) => sys.indexOf(s);
    expect(rank("**What they pasted**")).toBeGreaterThan(-1);
    expect(rank("**What they pasted**")).toBeLessThan(
      rank("**What they typed**"),
    );
    expect(rank("**What they typed**")).toBeLessThan(
      rank("**What they kept**"),
    );
    expect(rank("**What they kept**")).toBeLessThan(
      rank("**What they passed**"),
    );
    // The ranking is about evidence. A typed instruction is still how they say
    // what should change, and has to keep beating everything on a conflict.
    expect(sys).toContain("follow the instruction");
  });

  it("gets the same sender context as the batch prompt", () => {
    const sys = buildSkillSystem(null, {
      sender: { name: "Jay" },
    });
    expect(sys).toContain("Jay");
  });

  it("tells the rule-writer the judged recipients were fictional practice personas", () => {
    const sys = buildSkillSystem(null, {});
    expect(sys).toContain("fictional personas");
    // Rules must be about the user's voice, never about the invented person a
    // batch happened to address.
    expect(sys).toMatch(/never a rule about any persona/i);
  });
});

describe("fictional personas", () => {
  const validDraft = {
    subject: "Saw the release notes",
    body: "Worth 15 minutes?",
    axes: {
      opener: "signal",
      tone: "blunt",
      close: "question",
      greeting: "firstname",
      signoff: "name",
    },
  };
  const persona = {
    name: "Riya Shah",
    title: "VP Sales",
    company: "Northbeam Labs",
    situation: "Scaling outbound after a Series B",
    signals: ["Hiring 4 SDRs this quarter"],
  };

  it("batch schema carries the persona when the invented path returns one", () => {
    // Persona is optional now: real-recipient batches return drafts only and
    // the server stamps the label. The invented path still round-trips it.
    expect(
      BatchSchema.parse({ persona, drafts: [validDraft, validDraft] }).persona
        ?.name,
    ).toBe("Riya Shah");
  });

  it("the batch system prompt tells the model to invent the recipient and keep the sender true", () => {
    const sys = buildBatchSystem(
      { name: "Arbor", icp: {}, offering: {}, positioning: {} },
      { sender: { name: "Jay", companyName: "Arbor" } },
    );
    expect(sys).toMatch(/invent/i);
    expect(sys).toMatch(/fiction/i);
    expect(sys).toMatch(/never invent .*sender/i);
    expect(sys).not.toContain("NEVER INVENT DATA. This is a real person");
  });

  it("never reuses a persona already judged, and the persona rides with the drafts", () => {
    const sys = buildBatchSystem(null, {});
    expect(sys).toMatch(/never reuse a persona/i);
    expect(sys).toMatch(/return the persona with the drafts/i);
  });

  it("personaLabel reads as a To line and drops missing parts", () => {
    expect(personaLabel(persona)).toBe("Riya Shah · VP Sales, Northbeam Labs");
    expect(
      personaLabel({ ...persona, title: "", company: "Northbeam Labs" }),
    ).toBe("Riya Shah · Northbeam Labs");
    expect(personaLabel({ ...persona, title: "", company: "" })).toBe(
      "Riya Shah",
    );
  });

  it("judged drafts carry which persona they addressed into the transcript", () => {
    const prompt = buildBatchPrompt(
      {
        judged: [
          {
            ...judged("Release notes", true),
            personaLabel: "Riya Shah · VP Sales",
          },
        ],
        instructions: [],
      },
      4,
    );
    expect(prompt).toContain("Riya Shah");
  });
});
