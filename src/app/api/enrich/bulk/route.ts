import { NextResponse } from "next/server";

import { getSupabaseAndUser } from "@/lib/supabase/server";
import { isRecentlyEnriched } from "@/lib/services/knowledge-base";
import {
  enrichPerson,
  PERSON_ENRICH_COLUMNS,
  type PersonForEnrichment,
} from "@/lib/services/person-enrichment";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Bulk "Enrich all" for one company's contacts.
 *
 * Deliberately capped and re-clickable rather than unbounded. A single
 * enrichment is allowed 120s of its own (see /api/enrich), so a 40-contact
 * company cannot possibly finish inside one request: the honest design is a
 * small batch plus "click again", the same shape /api/find-email/bulk already
 * uses for the same reason.
 */
const MAX_PER_REQUEST = 10;

/**
 * Enrichments in flight at once.
 *
 * find-email/bulk is sequential ON PURPOSE, because the first lookup at an org
 * caches an email pattern the rest derive from for free. Enrichment has no
 * such dependency -- each contact is independent -- so serialising it would
 * only make a batch four times slower. Kept modest because each one fans out
 * to LinkedIn, X and three Exa searches.
 */
const CONCURRENCY = 4;

/** organizationId is required: one click = one company, never a campaign-wide fanout. */
export async function POST(req: Request) {
  const ctx = await getSupabaseAndUser();
  if (!ctx) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { supabase, user } = ctx;

  let body: { campaignId?: string; organizationId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { campaignId, organizationId } = body;
  if (!campaignId) {
    return NextResponse.json({ error: "campaignId required" }, { status: 400 });
  }
  if (!organizationId) {
    return NextResponse.json(
      { error: "organizationId required (one company per request)" },
      { status: 400 },
    );
  }

  const { data: campaign } = await supabase
    .from("campaigns")
    .select("user_id")
    .eq("id", campaignId)
    .maybeSingle();
  if (!campaign || campaign.user_id !== user.id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { data: rows, error } = await supabase
    .from("campaign_people")
    .select(
      `person:people!inner(id, organization_id, ${PERSON_ENRICH_COLUMNS})`,
    )
    .eq("campaign_id", campaignId);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  type Row = {
    person:
      | (PersonForEnrichment & { id: string; organization_id: string | null })
      | null;
  };

  const candidates: Array<{ id: string; person: PersonForEnrichment }> = [];
  for (const row of (rows ?? []) as unknown as Row[]) {
    const person = row.person;
    if (!person) continue;
    if (person.organization_id !== organizationId) continue;
    candidates.push({ id: person.id, person });
  }

  // Skip anyone already enriched recently. isRecentlyEnriched's default window
  // is 7 days, so genuinely stale data still refreshes rather than being
  // frozen forever by one old run.
  const fresh = await Promise.all(
    candidates.map((c) => isRecentlyEnriched("people", c.id)),
  );
  const pending = candidates.filter((_, i) => !fresh[i]);
  const alreadyEnriched = candidates.length - pending.length;

  const targets = pending.slice(0, MAX_PER_REQUEST);

  const enriched: string[] = [];
  const failed: Array<{ personId: string; reason?: string }> = [];

  // Simple worker pool: CONCURRENCY workers pulling from one cursor.
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, targets.length) }, async () => {
      for (;;) {
        const index = cursor++;
        if (index >= targets.length) return;
        const target = targets[index];
        try {
          const result = await enrichPerson(
            supabase,
            target.id,
            target.person,
            user.id,
          );
          if (result.status === "enriched") enriched.push(target.id);
          else
            failed.push({
              personId: target.id,
              reason: result.errors?.[0] ?? "No data found",
            });
        } catch (err) {
          failed.push({
            personId: target.id,
            reason: err instanceof Error ? err.message : "Unknown error",
          });
        }
      }
    }),
  );

  const remaining = Math.max(0, pending.length - targets.length);

  // Report the skip rather than dropping it: without this, clicking Enrich all
  // on a fully-enriched company looks like the button did nothing.
  const skipNote =
    alreadyEnriched > 0 ? ` ${alreadyEnriched} already enriched, skipped.` : "";

  return NextResponse.json({
    enriched: enriched.length,
    failed: failed.length,
    attempted: targets.length,
    pendingTotal: pending.length,
    remaining,
    alreadyEnriched,
    failures: failed,
    summary:
      targets.length === 0
        ? alreadyEnriched > 0
          ? `Nothing to do: all ${alreadyEnriched} contacts are already enriched.`
          : "No contacts to enrich at this company."
        : remaining > 0
          ? `Enriched ${enriched.length} of ${targets.length} (${remaining} more to go, click again).${skipNote}`
          : `Enriched ${enriched.length} of ${targets.length}.${skipNote}`,
  });
}
