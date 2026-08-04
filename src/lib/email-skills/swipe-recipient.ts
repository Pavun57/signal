import type { SwipeRecipient } from "@/lib/email-skills/swipe-prompts";
import type { getSupabaseAndUser } from "@/lib/supabase/server";

/**
 * Choosing the one real prospect a voice run is written about.
 *
 * Lives here rather than in the route because the route is scaffolding: the
 * plan replaces it with an agent tool, and the selection rule — and the
 * security argument underneath it — has to survive that move intact.
 */

/**
 * How far down the priority order to look for someone with enrichment. Bounded
 * because a campaign can hold thousands of contacts and this runs on every
 * batch; if the top 50 are all unenriched, the highest-scored of them is a
 * better recipient than paging to the end of the list to find one who isn't.
 */
export const RECIPIENT_SCAN = 50;

/** The `campaign_people` row shape this reads. */
export interface ContactRow {
  person_id: string;
  person: {
    name: string | null;
    title: string | null;
    enrichment_data: unknown;
    organization: { name: string | null } | null;
  } | null;
}

export const CONTACT_SELECT =
  // !organization_id disambiguates: people carries a second FK to
  // organizations (affiliation_detached_from), so unhinted embeds error.
  "person_id, person:people(name, title, enrichment_data, organization:organizations!organization_id(name))";

export interface ResolvedRecipient {
  personId: string;
  recipient: SwipeRecipient;
}

/**
 * The RLS-scoped client, exactly as `getSupabaseAndUser` hands it back. Taking
 * the real type rather than a hand-written structural slice is deliberate: a
 * narrower interface made TypeScript give up on the assignability check
 * ("excessively deep") at the call site, and the whole point of this function
 * is that the client it queries through is the RLS-scoped one.
 */
export type ScopedClient = NonNullable<
  Awaited<ReturnType<typeof getSupabaseAndUser>>
>["supabase"];

function toRecipient(row: ContactRow): SwipeRecipient | null {
  const p = row.person;
  if (!p) return null;
  return {
    name: p.name,
    title: p.title,
    company: p.organization?.name ?? null,
    enrichmentData: p.enrichment_data ?? null,
  };
}

/**
 * Picks the one contact every draft in a run is written about.
 *
 * Held constant for the whole run, which is the entire reason the caller pins
 * an id and sends it back: if the recipient changed between batches, a keep or
 * a pass could be about the prospect rather than about the voice, and voice is
 * the only thing this flow measures.
 *
 * Everything goes through `campaign_people` rather than `people` directly.
 * `people` and `organizations` are shared tables whose RLS select policy is
 * `using (true)` — any authenticated user can read any row — so a person id
 * taken off a request body and looked up in `people` would let one user write
 * emails about another user's prospect, enrichment and all. `campaign_people`
 * is scoped transitively through `campaigns.user_id`, so joining through it is
 * what makes a client-supplied id safe.
 *
 * It also means no campaign means no recipient: without one there is no
 * user-scoped path to a contact at all. That is a degraded run, not a failed
 * one — the prompt has a fallback for an unnamed recipient.
 */
export async function resolveRecipient(
  supabase: ScopedClient,
  campaignId: string | null | undefined,
  pinnedPersonId: string | null | undefined,
): Promise<ResolvedRecipient | null> {
  if (!campaignId) return null;

  if (pinnedPersonId) {
    // (campaign_id, person_id) is unique, so maybeSingle is exact.
    const { data } = await supabase
      .from("campaign_people")
      .select(CONTACT_SELECT)
      .eq("campaign_id", campaignId)
      .eq("person_id", pinnedPersonId)
      .maybeSingle();
    const recipient = data ? toRecipient(data as unknown as ContactRow) : null;
    if (recipient) return { personId: pinnedPersonId, recipient };
    // Fall through rather than fail. A contact unlinked from the campaign
    // mid-run should not end the run; a different real prospect for the
    // remaining drafts is a smaller loss than no drafts at all.
  }

  const { data } = await supabase
    .from("campaign_people")
    .select(CONTACT_SELECT)
    .eq("campaign_id", campaignId)
    .order("priority_score", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false })
    .limit(RECIPIENT_SCAN);

  // The generated types describe an embedded row as an array; the same
  // `as unknown as` step getContacts uses in enrichment-tools.ts.
  const rows = (data ?? []) as unknown as ContactRow[];
  // Enrichment first: a draft grounded in a real signal is the whole point of
  // picking a real person. The highest-scored contact overall is the fallback
  // for a campaign where nobody has been enriched yet — their name, title and
  // company are still true, and the no-fabrication rule covers the rest.
  const chosen = rows.find((r) => r.person?.enrichment_data) ?? rows[0];
  if (!chosen) return null;
  const recipient = toRecipient(chosen);
  return recipient ? { personId: chosen.person_id, recipient } : null;
}
