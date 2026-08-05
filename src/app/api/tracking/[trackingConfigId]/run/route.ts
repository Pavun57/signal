import { NextResponse } from "next/server";

import { enqueueJob } from "@/lib/services/jobs";
import { getSupabaseAndUser } from "@/lib/supabase/server";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ trackingConfigId: string }> },
) {
  const { trackingConfigId } = await params;

  const ctx = await getSupabaseAndUser();
  if (!ctx) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { supabase } = ctx;

  // The RLS-scoped read doubles as the ownership check: tracking_configs
  // policies resolve through campaigns.user_id, so a foreign config reads
  // as not-found rather than needing an explicit ownership join here.
  const { data: config } = await supabase
    .from("tracking_configs")
    .select("id, status, campaign:campaigns(user_id)")
    .eq("id", trackingConfigId)
    .maybeSingle();

  if (!config) {
    return NextResponse.json(
      { error: "Tracking config not found" },
      { status: 404 },
    );
  }
  if (config.status !== "active") {
    return NextResponse.json(
      { error: "Tracking is paused: resume it before running" },
      { status: 409 },
    );
  }

  // The joined campaign may surface as an object or a one-element array
  // depending on client typings — handle both so the owner's user_id
  // always lands on the job's queue partition.
  const campaign = Array.isArray(config.campaign)
    ? (config.campaign[0] as { user_id?: string | null } | undefined)
    : (config.campaign as { user_id?: string | null } | null);

  // next_run_at deliberately does not move: a manual run is an extra
  // check, not a rescheduling.
  const jobId = await enqueueJob({
    type: "tracking.run",
    payload: { trackingConfigId },
    userId: campaign?.user_id ?? null,
    // Double-clicks queue at most one extra run; the claim_jobs singleton
    // guard keeps them from executing concurrently.
    singletonKey: `tracking-run:${trackingConfigId}`,
    maxAttempts: 1,
  });

  return NextResponse.json({ ok: true, jobId });
}
