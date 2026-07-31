import { z } from "zod";

import { getSupabaseAndUser } from "@/lib/supabase/server";
import { recordAffiliation } from "@/lib/services/affiliation";
import { linkPersonToCampaign } from "@/lib/services/knowledge-base";

const BodySchema = z.object({
  organizationId: z.string().uuid(),
  campaignId: z.string().uuid().optional(),
});

/**
 * Manually attach a person to a company (and optionally a campaign).
 * Inverse of /api/people/[id]/from-company. Used by the "Add person"
 * dialog in the org chart for cases where the auto-classifier missed
 * someone or the user un-linked them and wants them back.
 *
 * Ownership model: the user must own at least one campaign that links
 * to the target organization (so they can't add people to companies
 * they've never engaged with) and, if a campaignId is supplied,
 * that campaign too.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: personId } = await params;

  const ctx = await getSupabaseAndUser();
  if (!ctx) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { supabase, user } = ctx;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: parsed.error.issues.map((i) => i.message).join("; ") },
      { status: 400 },
    );
  }
  const { organizationId, campaignId } = parsed.data;

  // The target organization must be in at least one of the user's campaigns.
  const { data: orgOwnership } = await supabase
    .from("campaign_organizations")
    .select("campaign:campaigns!inner(user_id)")
    .eq("organization_id", organizationId)
    .limit(1)
    .maybeSingle();

  const orgOwnerId =
    (orgOwnership?.campaign as unknown as { user_id?: string } | null)
      ?.user_id ?? null;
  if (!orgOwnerId || orgOwnerId !== user.id) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  // If a campaignId was supplied, double-check the user owns it too.
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

  const { data: org } = await supabase
    .from("organizations")
    .select("id")
    .eq("id", organizationId)
    .maybeSingle();
  if (!org) {
    return Response.json({ error: "Organization not found" }, { status: 404 });
  }

  // Goes through recordAffiliation rather than writing organization_id
  // directly, so the employer and the evidence for it can never disagree. A
  // human saying so is the strongest source there is, which also means this is
  // the one action that can override a machine verdict — the manual escape
  // hatch when the LLM cannot confirm a real employee.
  await recordAffiliation(supabase, {
    personId,
    organizationId,
    source: "user_entered",
    evidence: "assigned by the user",
  });

  const { data: updated, error: updErr } = await supabase
    .from("people")
    .select("id, name, organization_id")
    .eq("id", personId)
    .maybeSingle();

  if (updErr) {
    return Response.json({ error: updErr.message }, { status: 500 });
  }
  if (!updated) {
    return Response.json({ error: "Person not found" }, { status: 404 });
  }

  let linkedToCampaign = false;
  if (campaignId) {
    try {
      await linkPersonToCampaign(personId, campaignId);
      linkedToCampaign = true;
    } catch (err) {
      console.error("[to-company] failed to link campaign:", err);
    }
  }

  return Response.json({
    id: updated.id,
    name: updated.name,
    organization_id: updated.organization_id,
    linked_to_campaign: linkedToCampaign,
  });
}
