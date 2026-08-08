import { getSupabaseAndUser } from "@/lib/supabase/server";

/**
 * Search unassigned people (organization_id IS NULL) for the
 * "Add person to company" picker. Filters by name / title / linkedin /
 * email substring (case-insensitive). Returns up to 25 matches.
 *
 * Scope: only returns orphans that are linked via campaign_people to one
 * of the requesting user's campaigns. Orphans that have never touched any
 * of the user's campaigns are not exposed here -- they belong to other
 * users in a future multi-tenant world.
 */
export async function GET(request: Request) {
  const ctx = await getSupabaseAndUser();
  if (!ctx) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { supabase, user } = ctx;

  const url = new URL(request.url);
  const q = url.searchParams.get("q")?.trim() ?? "";

  // Require >=2 chars when a query is provided to avoid noisy substring
  // matches (e.g. "io" hitting random LinkedIn URLs).
  if (q.length > 0 && q.length < 2) {
    return Response.json({ people: [] });
  }

  // Surface only orphans the user has touched: any person with no
  // organization_id whose campaign_people row points to one of the
  // user's campaigns.
  // A failed read must not render as "no unassigned people": that empty
  // state is a data-quality claim the user acts on.
  const { data: ownedPersonIds, error: ownedError } = await supabase
    .from("campaign_people")
    .select("person_id, campaign:campaigns!inner(user_id)")
    .eq("campaign.user_id", user.id);
  if (ownedError) {
    return Response.json(
      { error: `Could not load people: ${ownedError.message}` },
      { status: 500 },
    );
  }

  const allowedIds = new Set(
    ((ownedPersonIds ?? []) as Array<{ person_id: string }>).map(
      (r) => r.person_id,
    ),
  );

  if (allowedIds.size === 0) {
    return Response.json({ people: [] });
  }

  let query = supabase
    .from("people")
    .select("id, name, title, linkedin_url, work_email")
    .is("organization_id", null)
    .in("id", [...allowedIds])
    .order("created_at", { ascending: false })
    .limit(25);

  if (q.length >= 2) {
    const safe = q.replace(/[%,]/g, "");
    const pattern = `%${safe}%`;
    query = query.or(
      [
        `name.ilike.${pattern}`,
        `title.ilike.${pattern}`,
        `linkedin_url.ilike.${pattern}`,
        `work_email.ilike.${pattern}`,
      ].join(","),
    );
  }

  const { data, error } = await query;
  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
  return Response.json({ people: data ?? [] });
}
