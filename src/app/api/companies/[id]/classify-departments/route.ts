import { withAction } from "@/lib/services/cost-tracker";
import { getSupabaseAndUser } from "@/lib/supabase/server";
import { classifyPeople } from "@/lib/services/department-classifier";

export const maxDuration = 120;

interface PersonRow {
  id: string;
  name: string;
  title: string | null;
  enrichment_data: Record<string, unknown> | null;
}

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: companyId } = await params;

  const ctx = await getSupabaseAndUser();
  if (!ctx) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { supabase, user } = ctx;

  // Ownership: target organization must be reachable from one of the
  // user's campaigns. Mirrors the /api/people/[id]/to-company pattern --
  // people RLS is permissive on purpose, so ownership is enforced here.
  const { data: orgOwnership } = await supabase
    .from("campaign_organizations")
    .select("campaign:campaigns!inner(user_id)")
    .eq("organization_id", companyId)
    .limit(1)
    .maybeSingle();

  const orgOwnerId =
    (orgOwnership?.campaign as unknown as { user_id?: string } | null)
      ?.user_id ?? null;
  if (!orgOwnerId || orgOwnerId !== user.id) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  const { data: org } = await supabase
    .from("organizations")
    .select("id, name")
    .eq("id", companyId)
    .maybeSingle();

  if (!org) {
    return Response.json({ error: "Company not found" }, { status: 404 });
  }

  const { data: rows, error } = await supabase
    .from("people")
    .select("id, name, title, enrichment_data")
    .eq("organization_id", companyId)
    .is("department", null)
    .limit(100);

  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }

  const people = (rows ?? []) as PersonRow[];
  if (people.length === 0) {
    return Response.json({ classified: 0 });
  }

  const inputs = people.map((p) => {
    const enrich = (p.enrichment_data ?? {}) as {
      linkedin?: { profileInfo?: { headline?: string } };
    };
    return {
      id: p.id,
      name: p.name,
      title: p.title,
      headline: enrich.linkedin?.profileInfo?.headline ?? null,
    };
  });

  let classifications;
  try {
    classifications = await withAction(
      `Classify departments: ${org.name}`,
      () => classifyPeople(org.name, inputs),
      // Attribution, matching find-contacts/enrich-company: without it the
      // classification spend lands with user_id NULL.
      user.id,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[classify-departments] LLM classification failed:", err);
    return Response.json(
      { error: `Classification failed: ${message}` },
      { status: 500 },
    );
  }

  let failedWrites = 0;
  for (const c of classifications) {
    const { error: updErr } = await supabase
      .from("people")
      .update({
        department: c.department,
        seniority: c.seniority,
        role_summary: c.role_summary,
      })
      .eq("id", c.id);
    if (updErr) {
      failedWrites++;
      console.error(
        `[classify-departments] update failed for ${c.id}:`,
        updErr,
      );
    }
  }

  // Failed writes are not classifications: reporting them as successes hid
  // rows the user believed were classified.
  return Response.json({
    classified: classifications.length - failedWrites,
    failed: failedWrites,
  });
}
