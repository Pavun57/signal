import { z } from "zod";

import { getSupabaseAndUser } from "@/lib/supabase/server";

// All three fields accept `null` so dragging into Unclassified columns or
// the Unclassified tier can clear them; `optional()` lets callers omit
// fields they don't want to touch.
const PatchSchema = z.object({
  department: z.string().min(1).max(80).nullable().optional(),
  seniority: z
    .enum(["founder", "head", "lead", "ic", "intern"])
    .nullable()
    .optional(),
  role_summary: z.string().max(400).nullable().optional(),
  location: z.string().min(1).max(120).nullable().optional(),
});

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: personId } = await params;

  const ctx = await getSupabaseAndUser();
  if (!ctx) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { supabase, user } = ctx;

  // Ownership: person must be linked to at least one campaign the user owns.
  // The `people` RLS policy is intentionally permissive (USING (true)) since
  // people are a shared knowledge base; ownership is enforced via campaigns.
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

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = PatchSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: parsed.error.issues.map((i) => i.message).join("; ") },
      { status: 400 },
    );
  }

  const updates: Record<string, unknown> = { ...parsed.data };
  if (Object.keys(updates).length === 0) {
    return Response.json(
      { error: "No updatable fields provided" },
      { status: 400 },
    );
  }
  // A location edit invalidates the cached timezone so the send gate
  // re-resolves from the new value.
  if ("location" in updates) {
    updates.timezone = null;
  }

  const { data, error } = await supabase
    .from("people")
    .update(updates)
    .eq("id", personId)
    .select("id, department, seniority, role_summary, location")
    .maybeSingle();

  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
  if (!data) {
    return Response.json({ error: "Person not found" }, { status: 404 });
  }

  return Response.json(data);
}
