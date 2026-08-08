import { NextResponse } from "next/server";
import { getSupabaseAndUser } from "@/lib/supabase/server";
import { recordVerifiedEmail } from "@/lib/services/email-pattern";

export const runtime = "nodejs";

/**
 * Record that a user manually confirmed (typed) an email for a person. The
 * server-side `recordVerifiedEmail` does role-prefix filtering and recomputes
 * the org's email pattern. The page calls this in addition to its own
 * email_drafts update, so the agent (and other contacts) benefit from the
 * confirmation.
 */
export async function POST(req: Request) {
  const ctx = await getSupabaseAndUser();
  if (!ctx) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { supabase } = ctx;

  let body: { personId?: string; email?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { personId, email } = body;
  if (!personId || !email) {
    return NextResponse.json(
      { error: "personId and email are required" },
      { status: 400 },
    );
  }

  // Ownership: person must be linked to a campaign owned by this user. Without
  // this check any logged-in user could overwrite anyone's work_email and
  // poison the org's email_pattern (cross-tenant).
  const { data: ownership } = await supabase
    .from("campaign_people")
    .select("campaign:campaigns!inner(user_id)")
    .eq("person_id", personId)
    .limit(1)
    .maybeSingle();

  const ownerId =
    (ownership?.campaign as unknown as { user_id?: string } | null)?.user_id ??
    null;

  if (!ownerId || ownerId !== ctx.user.id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const result = await recordVerifiedEmail(supabase, {
    personId,
    email,
    source: "user_entered",
  });

  // A database failure is a 500 the client can retry. A semantic skip (role
  // prefix, weaker source) is not an error, but reporting bare ok:true for it
  // told the UI a user-confirmed address was recorded when nothing was.
  if (result.error) {
    return NextResponse.json({ error: result.error }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    recorded: result.recorded,
    ...(result.reason ? { reason: result.reason } : {}),
  });
}
