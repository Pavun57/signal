import { createClient } from "@/lib/supabase/server";
import type { Signal } from "@/lib/types/signal";

/**
 * Load active signals for a campaign's system prompt.
 * Returns enabled signals joined from campaign_signals + signals.
 */
export async function getActiveSignals(campaignId: string): Promise<Signal[]> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("campaign_signals")
    .select("signal_id, signals(*)")
    .eq("campaign_id", campaignId)
    .eq("enabled", true);

  // Logged rather than silently coalesced: an empty return here strips the
  // enabled-signals block from the chat system prompt, and the prompt tells
  // the agent to only run enrichment for listed signals, so a swallowed
  // failure reads to the agent as "this campaign has zero signals".
  if (error) {
    console.error("[signals] getActiveSignals failed:", error);
    return [];
  }
  if (!data) return [];

  return data
    .map((row: Record<string, unknown>) => row.signals as Signal | null)
    .filter((s): s is Signal => s !== null);
}
