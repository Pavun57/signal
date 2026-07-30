/**
 * A user's email voice profile — exactly one per user, authored only by the
 * agent through the interview on /email-skills. Replaces the previous
 * multi-skill model (email_skills × email_skill_attachments), where users
 * hand-wrote rule packs and attached them at user / profile / campaign scope.
 *
 * Voice and campaign context are deliberately separate concerns: ICP,
 * offering and positioning already reach the composer from the campaigns row
 * via buildComposeUserPrompt, so this only carries *how* the user writes.
 */
export interface VoiceProfile {
  id: string;
  user_id: string;
  /**
   * The campaign this voice was interviewed for, or null for the user's default.
   * The composer prefers a campaign row over the default — see loadVoiceProfile.
   */
  campaign_id: string | null;
  /** Generated rules, appended to the base composer prompt. Voice wins on conflict. */
  instructions: string;
  /** Short human-readable description shown in the UI. */
  summary: string | null;
  /** The interview that produced this, so refinement can replay rather than restart. */
  source_transcript: InterviewTurn[] | null;
  created_at: string;
  updated_at: string;
}

// ── Interview protocol ─────────────────────────────────────────────────────
// The wizard posts the transcript so far; the agent returns its next move.
// A discriminated union so the model cannot return a shape the wizard has no
// way to render.

export interface EmailSample {
  subject: string;
  body: string;
}

export type InterviewMove =
  | {
      kind: "question";
      prompt: string;
      inputType: "text" | "choice";
      choices?: string[];
    }
  | {
      kind: "compare";
      /** The single dimension these two samples differ on, e.g. "story-led vs data-led". */
      dimension: string;
      a: EmailSample;
      b: EmailSample;
    }
  | { kind: "request_samples"; prompt: string }
  | { kind: "complete"; instructions: string; summary: string };

/** One completed exchange. `answer` is absent on the pending final move. */
export interface InterviewTurn {
  move: InterviewMove;
  answer?: string;
}

/** Hard cap so a misbehaving loop can't run indefinitely. */
export const MAX_INTERVIEW_TURNS = 25;
