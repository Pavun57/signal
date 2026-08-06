import { NextResponse } from "next/server";

import { getSupabaseAndUser } from "@/lib/supabase/server";

/**
 * Everything the Learnings section on /email-skills renders: the learning
 * rows the weekly analysis maintains, the weekday x day-part timing grid,
 * and the suppression list. All reads are RLS-scoped, so tenancy is done
 * by policy.
 */
export async function GET() {
  const ctx = await getSupabaseAndUser();
  if (!ctx) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { supabase } = ctx;

  const [learnings, timing, suppressions] = await Promise.all([
    supabase
      .from("email_learnings")
      .select(
        "id, category, statement, confidence, status, source, evidence, created_at, last_evaluated_at",
      )
      .neq("status", "user_dismissed")
      .order("created_at", { ascending: false })
      .limit(100),
    supabase
      .from("outreach_timing_stats")
      .select("weekday, day_part, sends, replies, positive")
      .order("weekday", { ascending: true }),
    supabase
      .from("outreach_suppressions")
      .select("id, email, reason, source, detail, created_at")
      .order("created_at", { ascending: false })
      .limit(200),
  ]);

  const firstError = learnings.error ?? timing.error ?? suppressions.error;
  if (firstError) {
    return NextResponse.json({ error: firstError.message }, { status: 500 });
  }

  return NextResponse.json({
    learnings: learnings.data ?? [],
    timing: timing.data ?? [],
    suppressions: suppressions.data ?? [],
  });
}
