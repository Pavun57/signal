import { NextResponse } from "next/server";

import { getSupabaseAndUser } from "@/lib/supabase/server";

/**
 * Remove one address from the suppression list, re-allowing outreach to it.
 * RLS makes a foreign row read as not-found.
 */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const ctx = await getSupabaseAndUser();
  if (!ctx) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { supabase } = ctx;

  const { data, error } = await supabase
    .from("outreach_suppressions")
    .delete()
    .eq("id", id)
    .select("id, email")
    .maybeSingle();
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!data) {
    return NextResponse.json(
      { error: "Suppression not found" },
      { status: 404 },
    );
  }
  return NextResponse.json({ removed: data.email });
}
