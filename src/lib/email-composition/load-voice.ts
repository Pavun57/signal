import type { SupabaseClient } from "@supabase/supabase-js";

import type { VoiceProfile } from "@/lib/types/email-voice";

/**
 * Load the voice profile that should write this email.
 *
 * Two scopes live in one table: a row with `campaign_id = null` is the user's
 * default voice, a row with a campaign id is that campaign's. The campaign row
 * wins where both exist, because the interview that produced it was grounded in
 * that campaign's ICP and offering — the default was grounded in whatever
 * campaign happened to be open at the time.
 *
 * Both candidates come back in one query rather than two sequential reads; the
 * fan-out calls this once per batch but the extra round trip is free to avoid.
 *
 * A missing profile is the normal state for a user who hasn't run the interview,
 * so this returns null rather than throwing. A read failure is treated the same
 * way, so a transient DB error costs a draft its voice instead of failing the
 * whole fan-out.
 */
export async function loadVoiceProfile(
  supabase: SupabaseClient,
  userId: string,
  campaignId?: string | null,
): Promise<VoiceProfile | null> {
  let query = supabase
    .from("email_voice_profiles")
    .select("*")
    .eq("user_id", userId);

  // `is null` and `eq` can't be expressed together in one filter, so the
  // campaign-scoped case uses `or`. Without a campaign we want the default row
  // only — not an arbitrary campaign's voice.
  query = campaignId
    ? query.or(`campaign_id.eq.${campaignId},campaign_id.is.null`)
    : query.is("campaign_id", null);

  const { data, error } = await query;
  if (error || !data || data.length === 0) return null;

  const rows = data as VoiceProfile[];
  return rows.find((r) => r.campaign_id === campaignId) ?? rows[0] ?? null;
}
