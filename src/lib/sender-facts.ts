import type { SupabaseClient } from "@supabase/supabase-js";

import { wrapUntrusted } from "@/lib/prompt-safety";

/** Canonical order: how the categories render in every prompt. */
export const FACT_CATEGORIES = [
  "background",
  "proof_point",
  "story",
  "pov",
  "credibility",
  "personal",
] as const;

export type FactCategory = (typeof FACT_CATEGORIES)[number];

export interface SenderFact {
  id: string;
  category: FactCategory;
  fact: string;
  source: "research" | "user" | "agent";
}

/** Hard cap on facts rendered into a prompt; the bank is append-forever. */
export const MAX_FACTS_IN_PROMPT = 40;

/**
 * The SENDER FACT BANK prompt block, or null when there is nothing to say —
 * null keeps every existing prompt byte-identical for users with no facts.
 *
 * The whole bank renders and the *drafting model* picks: a separate selection
 * call per recipient would break the stable-system-prompt cache during
 * fan-out, and picking one relevant detail from forty labeled sentences is
 * exactly what the model is good at.
 */
export function renderFactBank(facts: SenderFact[]): string | null {
  const byCategory = new Map<FactCategory, string[]>();
  for (const f of facts.slice(0, MAX_FACTS_IN_PROMPT)) {
    if (!FACT_CATEGORIES.includes(f.category)) continue;
    const list = byCategory.get(f.category) ?? [];
    list.push(f.fact.trim());
    byCategory.set(f.category, list);
  }
  if (![...byCategory.values()].some((l) => l.length)) return null;

  const body = FACT_CATEGORIES.filter((c) => byCategory.get(c)?.length)
    .map(
      (c) =>
        `${c}:\n${byCategory
          .get(c)!
          .map((f) => `- ${f}`)
          .join("\n")}`,
    )
    .join("\n\n");

  return `SENDER FACT BANK: true facts about the sender, grouped by kind.
Pick AT MOST one or two that genuinely connect to THIS recipient; most emails
need zero or one. A fact used because it fits beats three used because they
exist. Never invent a sender fact that is not listed here.
${wrapUntrusted(body)}`;
}

/**
 * All facts for a profile, newest first. The bank is append-forever and the
 * prompt takes at most MAX_FACTS_IN_PROMPT, so the ordering decides which
 * facts fall off once the bank outgrows the cap: the fact the user added
 * yesterday ("we just crossed 200 customers") must never lose its prompt slot
 * to one researched months ago.
 *
 * Errors degrade to an empty bank so a facts outage never blocks drafting,
 * but they are logged: this repo has been bitten before by RLS failures that
 * silently returned nothing.
 */
export async function loadSenderFacts(
  supabase: SupabaseClient,
  profileId: string | null | undefined,
): Promise<SenderFact[]> {
  if (!profileId) return [];
  const { data, error } = await supabase
    .from("sender_facts")
    .select("id, category, fact, source")
    .eq("profile_id", profileId)
    .order("created_at", { ascending: false })
    .limit(MAX_FACTS_IN_PROMPT);
  if (error) {
    console.warn(
      `[sender-facts] load failed for profile ${profileId}: ${error.message}`,
    );
  }
  return (data ?? []) as SenderFact[];
}
