/**
 * A user's email voice profile — exactly one per scope, authored only by the
 * agent through the swipe deck on /email-skills. Replaces the previous
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
   * The campaign this voice was built for, or null for the user's default.
   * The composer prefers a campaign row over the default — see loadVoiceProfile.
   */
  campaign_id: string | null;
  /** Generated rules, appended to the base composer prompt. Voice wins on conflict. */
  instructions: string;
  /** Short human-readable description shown in the UI. */
  summary: string | null;
  /**
   * What produced this, so refinement can replay rather than restart. Swipe
   * runs store a SwipeTranscript object; rows the retired interview wrote
   * hold an array of turns. buildRefinementTranscript checks the shape rather
   * than trusting it, so this stays opaque here.
   */
  source_transcript: unknown;
  created_at: string;
  updated_at: string;
}
