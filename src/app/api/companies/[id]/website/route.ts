import { getSupabaseAndUser } from "@/lib/supabase/server";
import { saveOrganizationWebsite } from "@/lib/services/organization-website";

export const maxDuration = 60;

/**
 * Fill in the website of a company that has none.
 *
 * The work lives in the service so the agent tool runs the same code. What is
 * here is the ownership gate and the HTTP shape.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: organizationId } = await params;

  const ctx = await getSupabaseAndUser();
  if (!ctx) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { supabase, user } = ctx;

  // `organizations` is a shared pool with no owner column, so the campaign link
  // is the only thing that can say whether this caller may touch the row. Same
  // gate as the sibling routes.
  const { data: ownership } = await supabase
    .from("campaign_organizations")
    .select("campaign:campaigns!inner(user_id)")
    .eq("organization_id", organizationId)
    .limit(1)
    .maybeSingle();
  const ownerId =
    (ownership?.campaign as unknown as { user_id?: string } | null)?.user_id ??
    null;
  if (!ownerId || ownerId !== user.id) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = (await request.json().catch(() => null)) as {
    url?: unknown;
    resolve?: unknown;
  } | null;

  const result = await saveOrganizationWebsite(supabase, {
    organizationId,
    url: typeof body?.url === "string" ? body.url : null,
    resolve: body?.resolve === true,
  });

  if (!result.ok) {
    // A 200 here means "no website could be found", which is a normal fact
    // about a small business rather than a failure. The caller shows the
    // message either way.
    return Response.json(
      { error: result.error },
      result.status === 200 ? undefined : { status: result.status },
    );
  }

  return Response.json(result);
}
