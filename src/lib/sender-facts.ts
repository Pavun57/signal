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

/** All facts for a profile, canonical category order then insertion order. */
export async function loadSenderFacts(
  supabase: SupabaseClient,
  profileId: string | null | undefined,
): Promise<SenderFact[]> {
  if (!profileId) return [];
  const { data } = await supabase
    .from("sender_facts")
    .select("id, category, fact, source")
    .eq("profile_id", profileId)
    .order("created_at", { ascending: true })
    .limit(MAX_FACTS_IN_PROMPT);
  return (data ?? []) as SenderFact[];
}
