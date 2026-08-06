import { describe, expect, it } from "vitest";

import {
  buildAnalysisPrompt,
  computeAggregates,
  dayPart,
  planLearningWrites,
  planWindowAdjustment,
  timingStatsRows,
  WINDOW_MIN_ATTRIBUTED_SENDS,
  type ExistingLearning,
  type SendOutcome,
} from "@/lib/services/outreach-learning";

function send(overrides: Partial<SendOutcome> = {}): SendOutcome {
  return {
    id: crypto.randomUUID(),
    sentLocalHour: 9,
    sentWeekday: 2,
    stepNumber: 1,
    campaignId: "camp_1",
    signalName: null,
    subjectLen: 30,
    bodyWords: 90,
    intent: null,
    bounced: false,
    ...overrides,
  };
}

describe("dayPart", () => {
  it("buckets the day coarsely", () => {
    expect(dayPart(5)).toBe("early");
    expect(dayPart(9)).toBe("morning");
    expect(dayPart(12)).toBe("midday");
    expect(dayPart(14)).toBe("afternoon");
    expect(dayPart(17)).toBe("evening");
    expect(dayPart(21)).toBe("night");
    expect(dayPart(2)).toBe("night");
  });
});

describe("computeAggregates", () => {
  it("counts real replies and positives, excluding ooo", () => {
    const a = computeAggregates([
      send({ intent: "interested" }),
      send({ intent: "not_interested" }),
      send({ intent: "ooo" }),
      send({ intent: null }),
      send({ intent: null, bounced: true }),
    ]);
    expect(a.totals.sends).toBe(5);
    // interested + not_interested are real replies; ooo is not.
    expect(a.totals.replies).toBe(2);
    expect(a.totals.positive).toBe(1);
    expect(a.totals.bounces).toBe(1);
  });

  it("groups timing by weekday and day part", () => {
    const a = computeAggregates([
      send({ sentWeekday: 1, sentLocalHour: 9, intent: "interested" }),
      send({ sentWeekday: 1, sentLocalHour: 10 }),
      send({ sentWeekday: 2, sentLocalHour: 18 }),
      send({ sentWeekday: null, sentLocalHour: null }), // unattributed: skipped
    ]);
    expect(a.timing).toHaveLength(2);
    const monMorning = a.timing.find(
      (t) => t.weekday === 1 && t.dayPart === "morning",
    );
    expect(monMorning).toMatchObject({ sends: 2, replies: 1, positive: 1 });
  });

  it("splits subject length at 45 chars", () => {
    const a = computeAggregates([
      send({ subjectLen: 30, intent: "interested" }),
      send({ subjectLen: 60 }),
    ]);
    expect(a.bySubjectLen).toEqual([
      { bucket: "long", sends: 1, replies: 0, positive: 0 },
      { bucket: "short", sends: 1, replies: 1, positive: 1 },
    ]);
  });
});

describe("timingStatsRows", () => {
  it("maps buckets to table rows", () => {
    const a = computeAggregates([
      send({ sentWeekday: 3, sentLocalHour: 10, intent: "question" }),
    ]);
    expect(timingStatsRows("user_1", a)).toEqual([
      {
        user_id: "user_1",
        weekday: 3,
        day_part: "morning",
        sends: 1,
        replies: 1,
        positive: 1,
      },
    ]);
  });
});

const existing: ExistingLearning[] = [
  {
    id: "l_active",
    category: "copy",
    statement: "Lead with the trigger event.",
    confidence: "medium",
    status: "active",
  },
  {
    id: "l_retired",
    category: "copy",
    statement: "Ask two questions per email.",
    confidence: "low",
    status: "retired",
  },
  {
    id: "l_dismissed",
    category: "timing",
    statement: "Send on Saturdays.",
    confidence: "low",
    status: "user_dismissed",
  },
];

describe("planLearningWrites", () => {
  it("adds a new learning", () => {
    const writes = planLearningWrites(
      [
        {
          op: "add",
          category: "copy",
          statement: "Keep subjects under five words.",
          confidence: "low",
          evidenceNote: "short subjects: 8% vs 2%",
        },
      ],
      existing,
    );
    expect(writes).toEqual([
      {
        kind: "insert",
        category: "copy",
        statement: "Keep subjects under five words.",
        confidence: "low",
        evidenceNote: "short subjects: 8% vs 2%",
      },
    ]);
  });

  it("never re-adds a dismissed statement, even as an add", () => {
    const writes = planLearningWrites(
      [
        {
          op: "add",
          category: "timing",
          statement: "Send on Saturdays.",
          confidence: "high",
          evidenceNote: "n",
        },
      ],
      existing,
    );
    expect(writes).toEqual([]);
  });

  it("never touches a dismissed learning by id", () => {
    const writes = planLearningWrites(
      [
        {
          op: "confirm",
          id: "l_dismissed",
          category: "timing",
          statement: "Send on Saturdays.",
          confidence: "high",
          evidenceNote: "n",
        },
      ],
      existing,
    );
    expect(writes).toEqual([]);
  });

  it("drops operations aimed at unknown ids", () => {
    const writes = planLearningWrites(
      [
        {
          op: "retire",
          id: "nope",
          category: "copy",
          statement: "x",
          confidence: "low",
          evidenceNote: "n",
        },
      ],
      existing,
    );
    expect(writes).toEqual([]);
  });

  it("confirm resurrects a retired learning; retire retires an active one", () => {
    const writes = planLearningWrites(
      [
        {
          op: "confirm",
          id: "l_retired",
          category: "copy",
          statement: "Ask two questions per email.",
          confidence: "medium",
          evidenceNote: "n",
        },
        {
          op: "retire",
          id: "l_active",
          category: "copy",
          statement: "Lead with the trigger event.",
          confidence: "low",
          evidenceNote: "contradicted this window",
        },
      ],
      existing,
    );
    expect(writes).toMatchObject([
      { kind: "update", id: "l_retired", status: "active" },
      { kind: "update", id: "l_active", status: "retired" },
    ]);
  });

  it("caps adds per run and dedupes against active statements", () => {
    const add = (statement: string) => ({
      op: "add" as const,
      category: "copy" as const,
      statement,
      confidence: "low" as const,
      evidenceNote: "n",
    });
    const writes = planLearningWrites(
      [
        add("Lead with the trigger event."), // duplicate of active
        add("a"),
        add("b"),
        add("c"),
        add("d"),
        add("e"),
        add("f"), // over the cap of 5
      ],
      existing,
    );
    expect(writes).toHaveLength(5);
    expect(writes.map((w) => (w.kind === "insert" ? w.statement : ""))).toEqual(
      ["a", "b", "c", "d", "e"],
    );
  });
});

describe("planWindowAdjustment", () => {
  /** n sends at an hour, r of them replied. */
  const at = (hour: number, n: number, r: number): SendOutcome[] =>
    Array.from({ length: n }, (_, i) =>
      send({
        sentLocalHour: hour,
        intent: i < r ? "interested" : null,
      }),
    );

  it("returns null below the volume guardrails", () => {
    // 60 sends with plenty of replies: still below the 100-send floor.
    const outcomes = [...at(9, 30, 5), ...at(15, 30, 10)];
    expect(outcomes.length).toBeLessThan(WINDOW_MIN_ATTRIBUTED_SENDS);
    expect(planWindowAdjustment(outcomes, { start: 9, end: 17 })).toBeNull();
  });

  it("proposes the clearly better window", () => {
    // Current window 9-17 performs at ~2%; 7-9am performs at ~20%.
    const outcomes = [
      ...at(7, 30, 6),
      ...at(8, 30, 6),
      ...at(10, 40, 1),
      ...at(14, 40, 1),
    ];
    const plan = planWindowAdjustment(outcomes, { start: 9, end: 17 });
    expect(plan).not.toBeNull();
    // The winning candidate covers the 7-8am replies.
    expect([5, 6, 7].includes(plan!.start)).toBe(true);
    expect(plan!.candidateRate).toBeGreaterThan(plan!.currentRate * 1.5);
  });

  it("returns null when the improvement is under the 1.5x margin", () => {
    // 10-11am is only marginally better than the window as a whole.
    const outcomes = [...at(9, 60, 5), ...at(10, 60, 7)];
    expect(planWindowAdjustment(outcomes, { start: 9, end: 17 })).toBeNull();
  });

  it("ignores thin candidates however good their rate looks", () => {
    // 2/2 at 6am is a 100% rate on nothing; must not move the window.
    const outcomes = [...at(6, 2, 2), ...at(9, 120, 10)];
    const plan = planWindowAdjustment(outcomes, { start: 9, end: 17 });
    // The only candidates with >= 25 sends all contain 9am, whose rate
    // cannot beat itself by 1.5x.
    expect(plan).toBeNull();
  });
});

describe("buildAnalysisPrompt", () => {
  it("includes precomputed rates, existing learnings, and the dismissed fence", () => {
    const prompt = buildAnalysisPrompt({
      aggregates: computeAggregates([send({ intent: "interested" }), send({})]),
      winners: [{ subject: "Hi", bodyText: "won", outcome: "positive" }],
      losers: [],
      existing: existing.filter((l) => l.status === "active"),
      dismissed: ["Send on Saturdays."],
    });
    expect(prompt).toContain("2 sends, 1 replies (50%)");
    expect(prompt).toContain("id l_active");
    expect(prompt).toContain("never re-propose");
    expect(prompt).toContain("Send on Saturdays.");
    // Winner bodies are fenced as untrusted text.
    expect(prompt).toContain("<untrusted>");
  });
});
