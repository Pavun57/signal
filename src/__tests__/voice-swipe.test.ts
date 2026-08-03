import { describe, expect, it } from "vitest";

import {
  MIN_JUDGED,
  converged,
  deriveRules,
  readSeconds,
  streak,
  type SwipeEmail,
  type Verdict,
} from "@/lib/voice-swipe";
import { SEED_DECK } from "@/lib/voice-swipe-deck";

const byId = (id: string): SwipeEmail => {
  const e = SEED_DECK.find((x) => x.id === id);
  if (!e) throw new Error(`no seed draft ${id}`);
  return e;
};

/** Judge a run and return the piles, mirroring what the component tracks. */
function judge(picks: [string, boolean][]) {
  const verdicts: Verdict[] = picks.map(([id, liked]) => ({ id, liked }));
  const kept = picks.filter(([, l]) => l).map(([id]) => byId(id));
  const passed = picks.filter(([, l]) => !l).map(([id]) => byId(id));
  return { verdicts, kept, passed };
}

describe("convergence", () => {
  it("will not converge before the minimum, however good the run", () => {
    // Five straight keeps is a perfect rolling rate, but too little evidence.
    const { verdicts } = judge([
      ["d02", true],
      ["d06", true],
      ["d11", true],
      ["d12", true],
      ["d15", true],
    ]);
    expect(verdicts.length).toBeLessThan(MIN_JUDGED);
    expect(converged(verdicts)).toBe(false);
  });

  it("converges on the rolling window, not the cumulative rate", () => {
    // A bad opening run then a good one: cumulative is 4/9, rolling is 4/5.
    const { verdicts } = judge([
      ["d01", false],
      ["d09", false],
      ["d10", false],
      ["d14", false],
      ["d08", false],
      ["d02", true],
      ["d06", true],
      ["d11", true],
      ["d12", true],
    ]);
    const cumulative = verdicts.filter((v) => v.liked).length / verdicts.length;
    expect(cumulative).toBeLessThan(0.8);
    expect(converged(verdicts)).toBe(true);
  });

  it("counts only the trailing run of rejections", () => {
    const { verdicts } = judge([
      ["d01", false],
      ["d02", true],
      ["d09", false],
      ["d10", false],
    ]);
    expect(streak(verdicts)).toBe(2);
  });
});

describe("deriveRules", () => {
  it("writes a different voice for opposite users from the same deck", () => {
    const blunt = judge([
      ["d02", true],
      ["d06", true],
      ["d12", true],
      ["d15", true],
      ["d01", false],
      ["d09", false],
    ]);
    const warm = judge([
      ["d05", true],
      ["d09", true],
      ["d18", true],
      ["d16", true],
      ["d06", false],
      ["d12", false],
    ]);

    const bluntRules = deriveRules(blunt.kept, blunt.passed);
    const warmRules = deriveRules(warm.kept, warm.passed);

    expect(bluntRules).toContain(
      "Open on the signal itself: what they just shipped or announced.",
    );
    expect(warmRules).toContain("Keep it warm and conversational.");
    expect(bluntRules).not.toEqual(warmRules);
  });

  it("emits a never-rule for a style rejected twice and never kept", () => {
    const { kept, passed } = judge([
      ["d02", true],
      ["d06", true],
      ["d11", true],
      ["d01", false], // compliment opener
      ["d09", false], // compliment opener
    ]);
    expect(deriveRules(kept, passed)).toContain("Never open on a compliment.");
  });

  it("does not emit a never-rule for a style that was also kept", () => {
    const { kept, passed } = judge([
      ["d05", true], // story opener, kept
      ["d02", true],
      ["d20", false], // story opener, passed
      ["d01", false],
    ]);
    expect(deriveRules(kept, passed)).not.toContain(
      "Don't open with an anecdote.",
    );
  });

  it("returns nothing from a single keep", () => {
    const { kept, passed } = judge([["d02", true]]);
    expect(deriveRules(kept, passed)).toEqual([]);
  });
});

describe("presentation helpers", () => {
  it("floors reading time so nothing reads as instant", () => {
    expect(readSeconds(1)).toBe(5);
    expect(readSeconds(71)).toBe(20);
  });
});
