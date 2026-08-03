import { getSupabaseAndUser } from "@/lib/supabase/server";
import { isRecentlyEnriched } from "@/lib/services/knowledge-base";
import {
  enrichPerson,
  PERSON_ENRICH_COLUMNS,
  type PersonForEnrichment,
} from "@/lib/services/person-enrichment";

export const maxDuration = 120;

export async function POST(request: Request) {
  const ctx = await getSupabaseAndUser();
  if (!ctx) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { supabase, user } = ctx;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { contactId } = body as { contactId: string };
  if (!contactId) {
    return Response.json({ error: "contactId is required" }, { status: 400 });
  }

  // contactId may be a campaign_people link ID -- resolve to person.
  // The link is our ownership hook: campaign_people -> campaigns.user_id
  // (defense in depth on top of RLS, which already scopes campaign_people
  // through its parent campaign).
  let personId: string;

  const { data: link } = await supabase
    .from("campaign_people")
    .select("person_id, campaign:campaigns(user_id)")
    .eq("id", contactId)
    .maybeSingle();

  if (link) {
    const campaign = link.campaign as unknown as { user_id: string } | null;
    if (!campaign) {
      return Response.json({ error: "Contact not found" }, { status: 404 });
    }
    if (campaign.user_id !== user.id) {
      return Response.json({ error: "Forbidden" }, { status: 403 });
    }
    personId = link.person_id;
  } else {
    // Bare person ID path -- people rows aren't user-scoped; RLS on the
    // subsequent select is the only layer we have here.
    personId = contactId;
  }

  const { data: personData, error: fetchError } = await supabase
    .from("people")
    .select(PERSON_ENRICH_COLUMNS)
    .eq("id", personId)
    .single();

  if (fetchError || !personData) {
    return Response.json({ error: "Contact not found" }, { status: 404 });
  }

  const person = personData as unknown as PersonForEnrichment;

  // Check recency
  const recent = await isRecentlyEnriched("people", personId);
  if (recent) {
    const { data: p } = await supabase
      .from("people")
      .select("enrichment_data")
      .eq("id", personId)
      .single();
    return Response.json({
      contactId: personId,
      status: "enriched",
      enrichmentData: p?.enrichment_data || {},
      skipped: true,
    });
  }

  const result = await enrichPerson(supabase, personId, person);

  return Response.json({
    contactId: personId,
    status: result.status,
    enrichmentData: result.enrichmentData,
    errors: result.errors,
  });
}
