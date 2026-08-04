import { beforeEach, describe, expect, it } from "vitest";

import {
  clearRun,
  newRun,
  readActiveRun,
  readRun,
  saveRun,
  toTranscript,
  type VoiceRun,
} from "@/lib/email-skills/swipe-run";

const USER = "user_a";
const CAMPAIGN = "3f0b2b6a-9a5e-4a7b-8f6e-1c2d3e4f5a6b";

function runWith(overrides: Partial<VoiceRun> = {}): VoiceRun {
  return { ...newRun(null, []), ...overrides };
}

beforeEach(() => {
  window.sessionStorage.clear();
});

describe("storage round-trip", () => {
  it("saves and reads back the same run", () => {
    const run = runWith({ instructions: ["shorter"] });
    saveRun(USER, run);
    expect(readRun(USER, null)).toEqual(run);
  });

  it("returns null when nothing was saved", () => {
    expect(readRun(USER, null)).toBeNull();
    expect(readActiveRun(USER)).toBeNull();
  });

  it("survives a corrupt entry by returning null", () => {
    window.sessionStorage.setItem(`signal:voice-run:${USER}:user`, "{nope");
    expect(readRun(USER, null)).toBeNull();
  });

  it("rejects a stored value that is not a run", () => {
    window.sessionStorage.setItem(
      `signal:voice-run:${USER}:user`,
      JSON.stringify(["an", "interview", "transcript"]),
    );
    expect(readRun(USER, null)).toBeNull();
  });
});

describe("scope keying", () => {
  it("keeps a campaign run and the default run apart", () => {
    const campaignRun = runWith({
      campaignId: CAMPAIGN,
      instructions: ["campaign"],
    });
    const defaultRun = runWith({ instructions: ["default"] });
    saveRun(USER, campaignRun);
    saveRun(USER, defaultRun);

    expect(readRun(USER, CAMPAIGN)?.instructions).toEqual(["campaign"]);
    expect(readRun(USER, null)?.instructions).toEqual(["default"]);
  });

  it("keeps two users apart in the same tab", () => {
    saveRun(USER, runWith({ instructions: ["mine"] }));
    expect(readRun("user_b", null)).toBeNull();
  });

  it("a campaign run never resumes into the user-level default", () => {
    saveRun(USER, runWith({ campaignId: CAMPAIGN }));
    expect(readRun(USER, null)).toBeNull();
  });
});

describe("active pointer", () => {
  it("readActiveRun returns whichever scope last saved", () => {
    saveRun(USER, runWith({ instructions: ["default"] }));
    saveRun(USER, runWith({ campaignId: CAMPAIGN, instructions: ["camp"] }));
    expect(readActiveRun(USER)?.instructions).toEqual(["camp"]);
  });

  it("clearRun clears the pointer only when it points at that scope", () => {
    saveRun(USER, runWith({ campaignId: CAMPAIGN }));
    saveRun(USER, runWith({}));
    // Active pointer is now the default scope; clearing the campaign run
    // must not blind the panel to the still-active default run.
    clearRun(USER, CAMPAIGN);
    expect(readActiveRun(USER)).not.toBeNull();

    clearRun(USER, null);
    expect(readActiveRun(USER)).toBeNull();
  });
});

describe("toTranscript", () => {
  it("carries exactly what the prompts consume", () => {
    const run = runWith({
      samples: ["an email I sent"],
      instructions: ["blunter"],
      judged: [
        {
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
        },
      ],
      // None of the below belongs in a prompt.
      queue: [
        {
          id: "g1",
          subject: "queued",
          body: "queued",
          axes: {
            opener: "problem",
            tone: "warm",
            close: "cta",
            greeting: "dear",
            signoff: "best",
          },
        },
      ],
      recipientPersonId: "someone",
      recipientLabel: "Someone · CEO",
    });

    expect(toTranscript(run)).toEqual({
      judged: run.judged,
      instructions: ["blunter"],
      samples: ["an email I sent"],
    });
  });
});
