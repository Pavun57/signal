import { z } from "zod";

import { getSupabaseAndUser } from "@/lib/supabase/server";

const QuerySchema = z.object({
  campaignId: z.string().uuid().optional(),
});

/**
 * Remove a person from a company's org chart context.
 *
 * Always: clears `people.organization_id` so they no longer appear in the
 * standalone /companies/[id] view.
 *
 * If `campaignId` is provided: also deletes the matching campaign_people
 * row so they disappear from the campaign's embedded chart and flat list.
 *
 * The person record itself is preserved -- they may still be useful as a
 * contact for other campaigns or future research.
 */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: personId } = await params;

  const ctx = await getSupabaseAndUser();
  if (!ctx) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { supabase, user } = ctx;

  const url = new URL(request.url);
  const queryParse = QuerySchema.safeParse({
    campaignId: url.searchParams.get("campaignId") ?? undefined,
  });
  if (!queryParse.success) {
    return Response.json(
      { error: queryParse.error.issues.map((i) => i.message).join("; ") },
      { status: 400 },
    );
  }
  const { campaignId } = queryParse.data;

  // Ownership: person must be linked to at least one of the user's campaigns.
  const { data: ownership } = await supabase
    .from("campaign_people")
    .select("campaign:campaigns!inner(user_id)")
    .eq("person_id", personId)
    .limit(1)
    .maybeSingle();

  const ownerId =
    (ownership?.campaign as unknown as { user_id?: string } | null)?.user_id ??
    null;
  if (!ownerId || ownerId !== user.id) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  // If a specific campaignId was requested, double-check the user owns it
  // (defends against passing someone else's campaign id).
  if (campaignId) {
    const { data: camp } = await supabase
      .from("campaigns")
      .select("user_id")
      .eq("id", campaignId)
      .maybeSingle();
    if (!camp || camp.user_id !== user.id) {
      return Response.json({ error: "Forbidden" }, { status: 403 });
    }
  }

  // Clear the provenance alongside the employer. Detaching while leaving
  // affiliation_source/confidence in place would let the next passing search
  // re-attach the person to a DIFFERENT company that then inherits the old
  // company's confidence and passes the send gate.
  const { error: orgErr } = await supabase
    .from("people")
    .update({
      organization_id: null,
      affiliation_source: null,
      affiliation_confidence: null,
      affiliation_evidence: null,
      affiliation_verified_at: null,
    })
    .eq("id", personId);

  if (orgErr) {
    return Response.json({ error: orgErr.message }, { status: 500 });
  }

  let unlinkedFromCampaign = false;
  if (campaignId) {
    const { error: campErr } = await supabase
      .from("campaign_people")
      .delete()
      .eq("campaign_id", campaignId)
      .eq("person_id", personId);
    if (campErr) {
      return Response.json({ error: campErr.message }, { status: 500 });
    }
    unlinkedFromCampaign = true;
  }

  return Response.json({
    id: personId,
    unlinked_from_company: true,
    unlinked_from_campaign: unlinkedFromCampaign,
  });
}
