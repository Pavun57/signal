import type {
  DraftAxes,
  JudgedDraft,
  SwipeTranscript,
} from "@/lib/email-skills/swipe-prompts";

/**
 * The voice-swipe run, shared between the deck and the agent panel.
 *
 * It lives in sessionStorage, not the database. An unfinished run is worth
 * nothing to the composer, but losing a dozen swipes to a reload is what makes
 * people give up; the interview stored its transcript the same way and for the
 * same reason. A migration was written for this and deliberately reverted, so
 * do not reintroduce one.
 *
 * Keyed by user *and* scope. The user part stops a second account signing into
 * the same tab inheriting it; the scope part stops a campaign run resuming
 * into the user-level default (or another campaign), which would save one
 * campaign's judgements against a different one. A separate pointer records
 * which scope is active, so the agent panel can find the run without knowing
 * what page the deck is on.
 */

/** A draft waiting to be judged. The id is client-assigned at ingest. */
export interface RunDraft {
  id: string;
  subject: string;
  body: string;
  axes: DraftAxes;
  /** The fictional persona this draft addresses, stamped from its batch at
   * ingest. Per draft, not per run: a queue holding two batches labels each
   * card with the persona it was actually written to. */
  personaLabel: string | null;
}

export interface VoiceRun {
  campaignId: string | null;
  /** Emails they pasted before the first batch. Empty is a real answer. */
  samples: string[];
  queue: RunDraft[];
  judged: JudgedDraft[];
  /** Typed instructions, in order. Appended before generating, so a failed
   * generation still records what was asked. */
  instructions: string[];
  finished: boolean;
  /** The rules the model wrote, once saving succeeded. */
  skill: { instructions: string; summary: string } | null;
}

export function newRun(campaignId: string | null, samples: string[]): VoiceRun {
  return {
    campaignId,
    samples,
    queue: [],
    judged: [],
    instructions: [],
    finished: false,
    skill: null,
  };
}

/** What the agent needs to continue the run: exactly the transcript shape the
 * batch and skill prompts consume. Queue and UI state stay client-side. */
export function toTranscript(run: VoiceRun): SwipeTranscript {
  return {
    judged: run.judged,
    instructions: run.instructions,
    samples: run.samples,
  };
}

const STORAGE_PREFIX = "signal:voice-run:";

function storageKey(userId: string, campaignId?: string | null) {
  return `${STORAGE_PREFIX}${userId}:${campaignId ?? "user"}`;
}

function activeKey(userId: string) {
  return `${STORAGE_PREFIX}active:${userId}`;
}

export function readRun(
  userId: string,
  campaignId?: string | null,
): VoiceRun | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(storageKey(userId, campaignId));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    const run = parsed as Partial<VoiceRun>;
    if (!Array.isArray(run.judged) || !Array.isArray(run.queue)) return null;
    // Shape-checked loosely on purpose: a run stored by an older build may
    // carry the since-removed pinned-contact fields and lack personaLabel.
    // Extra fields are harmless and missing ones read as null, so a mid-run
    // deploy costs nothing judged.
    return run as VoiceRun;
  } catch {
    // A corrupt entry should cost the user a restart, not the whole page.
    return null;
  }
}

/** The run for whichever scope last saved, or null. This is how the agent
 * panel finds the run without knowing which page the deck is on. */
export function readActiveRun(userId: string): VoiceRun | null {
  if (typeof window === "undefined") return null;
  try {
    const scope = window.sessionStorage.getItem(activeKey(userId));
    if (scope === null) return null;
    return readRun(userId, scope === "user" ? null : scope);
  } catch {
    return null;
  }
}

export function saveRun(userId: string, run: VoiceRun) {
  try {
    window.sessionStorage.setItem(
      storageKey(userId, run.campaignId),
      JSON.stringify(run),
    );
    window.sessionStorage.setItem(activeKey(userId), run.campaignId ?? "user");
  } catch {
    // Private-mode quota failures make the run non-resumable, not broken.
  }
}

export function clearRun(userId: string, campaignId?: string | null) {
  try {
    window.sessionStorage.removeItem(storageKey(userId, campaignId));
    const active = window.sessionStorage.getItem(activeKey(userId));
    if (active === (campaignId ?? "user")) {
      window.sessionStorage.removeItem(activeKey(userId));
    }
  } catch {
    // Nothing to do: the key is either gone or unreachable.
  }
}
