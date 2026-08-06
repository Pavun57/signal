import { NextResponse } from "next/server";

import { getSupabaseAndUser } from "@/lib/supabase/server";

const STATUSES = new Set(["active", "retired", "user_dismissed"]);

/**
 * Edit one learning: revise its statement or set its status (retire /
 * dismiss / reactivate). RLS makes a foreign row read as not-found. Edited
 * statements are marked source 'user' so the analysis knows the user
 * rewrote it.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const ctx = await getSupabaseAndUser();
  if (!ctx) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { supabase } = ctx;

  let body: { statement?: unknown; status?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const updates: Record<string, unknown> = {};
  if (body.statement !== undefined) {
    if (
      typeof body.statement !== "string" ||
      !body.statement.trim() ||
      body.statement.length > 500
    ) {
      return NextResponse.json(
        { error: "statement must be a non-empty string of at most 500 chars" },
        { status: 400 },
      );
    }
    updates.statement = body.statement.trim();
    updates.source = "user";
  }
  if (body.status !== undefined) {
    if (typeof body.status !== "string" || !STATUSES.has(body.status)) {
      return NextResponse.json(
        { error: "status must be active, retired, or user_dismissed" },
        { status: 400 },
      );
    }
    updates.status = body.status;
  }
  if (Object.keys(updates).length === 0) {
    return NextResponse.json(
      { error: "Nothing to update: pass statement and/or status" },
      { status: 400 },
    );
  }

  const { data, error } = await supabase
    .from("email_learnings")
    .update(updates)
    .eq("id", id)
    .select("id, category, statement, confidence, status, source")
    .maybeSingle();
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!data) {
    return NextResponse.json({ error: "Learning not found" }, { status: 404 });
  }
  return NextResponse.json({ learning: data });
}
