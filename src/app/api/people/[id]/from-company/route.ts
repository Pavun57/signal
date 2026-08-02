import { z } from "zod";

import { recordAffiliation } from "@/lib/services/affiliation";
import { getSupabaseAndUser } from "@/lib/supabase/server";

const QuerySchema = z.object({
  campaignId: z.string().uuid().optional(),
  organizationId: z.string().uuid().optional(),
});

/**
 * Remove a person from a company: the user saying "not here".
 *
 * Always: records the rejection through `recordAffiliation` as `user_rejected`,
 * which clears `people.organization_id` (so they leave the standalone
 * /companies/[id] view) while KEEPING the memory of why.
 *
 * This used to null organization_id and all four provenance columns together.
 * A row with no org and no source is scored -1 by recordAffiliation, below a
 * bare search stamp at 0.2, so the next discovery run at that company pulled the
 * same person back out of Exa, the judge returned `uncertain` again, and the
 * stamp re-attached them. They reappeared under "Needs review" and the queue
 * never terminated: a human's rejection was recorded as nothing at all, so the
 * machine outranked it. At 1.0 nothing machine-made is strictly stronger, and
 * `user_entered` (also a human override) is still free to put them back if the
 * user changes their mind.
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
    organizationId: url.searchParams.get("organizationId") ?? undefined,
  });
  if (!queryParse.success) {
    return Response.json(
      { error: queryParse.error.issues.map((i) => i.message).join("; ") },
      { status: 400 },
    );
  }
  const { campaignId, organizationId } = queryParse.data;

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

  // Which company is being rejected. Preferring the caller's value is the whole
  // reason the check is worth anything: the UI knows which company it drew the
  // row under, and reading the company off the person instead would compare the
  // row to itself and pass no matter what changed since the page loaded. A
  // stale tab, or another user on the same shared `people` pool having moved
  // them first, is then a refusal rather than a rejection recorded against a
  // company the user never looked at.
  //
  // The fallback exists for the callers that do not name one (the org chart's
  // Remove button and the standalone company page). recordAffiliation refuses a
  // detach that names no company at all, so without it those callers would
  // simply stop working.
  let detachedFrom = organizationId ?? null;
  if (!detachedFrom) {
    const { data: person } = await supabase
      .from("people")
      .select("organization_id")
      .eq("id", personId)
      .maybeSingle();
    if (!person) {
      return Response.json({ error: "Person not found" }, { status: 404 });
    }
    detachedFrom = (person.organization_id as string | null) ?? null;
    if (!detachedFrom) {
      return Response.json(
        {
          error:
            "This contact is not linked to any company, so there is nothing to remove them from.",
        },
        { status: 409 },
      );
    }
  }

  // Goes through recordAffiliation rather than writing the columns directly, so
  // the removal is recorded as evidence instead of erased, and so it inherits
  // the scope check: a detach is about one company, never "detach from wherever
  // you are".
  const write = await recordAffiliation(supabase, {
    personId,
    organizationId: null,
    source: "user_rejected",
    detachedFrom,
    evidence: "the user said this person does not work here",
  });

  if (!write.written) {
    if (write.reason === "person_not_found") {
      return Response.json({ error: "Person not found" }, { status: 404 });
    }
    if (write.notAtJudgedOrg) {
      // They are filed somewhere else now. Deleting the campaign link on top of
      // this would drop a contact out of the campaign over a click aimed at a
      // company they are not at.
      return Response.json(
        {
          error:
            "This contact is no longer linked to that company. Refresh and try again.",
        },
        { status: 409 },
      );
    }
    return Response.json(
      { error: `Could not remove this contact: ${write.reason}` },
      { status: 500 },
    );
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
