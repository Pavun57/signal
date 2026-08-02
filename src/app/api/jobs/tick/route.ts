import { NextResponse } from "next/server";
import { getAdminClient } from "@/lib/supabase/admin";
import { getBaseUrl, isJobRequestAuthorized } from "@/lib/services/jobs";

// Dispatcher only: claims a batch and hands each job to its own /api/jobs/run
// invocation. Never does job work itself, so it finishes in seconds.
export const maxDuration = 60;

async function tick(request: Request): Promise<NextResponse> {
  if (!isJobRequestAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: jobs, error } = await getAdminClient().rpc("claim_jobs", {
    batch_size: 25,
    lease_seconds: 330, // runner maxDuration (300s) + headroom
    per_user_cap: 5,
  });
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const claimed = (jobs ?? []) as Array<{ id: string }>;
  const results = await Promise.allSettled(
    claimed.map((job) =>
      fetch(`${getBaseUrl()}/api/jobs/run`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${process.env.CRON_SECRET}`,
        },
        body: JSON.stringify({ jobId: job.id }),
      }),
    ),
  );

  // The runner 202s before doing the work, so "dispatched" means delivered,
  // not succeeded. A job whose dispatch failed just sits on its lease until
  // claim_jobs() reaps it — no special handling needed here.
  const dispatched = results.filter(
    (r) => r.status === "fulfilled" && r.value.ok,
  ).length;

  return NextResponse.json({ claimed: claimed.length, dispatched });
}

// Vercel Cron sends GET; pg_cron and manual curls may POST.
export async function GET(request: Request) {
  return tick(request);
}
export async function POST(request: Request) {
  return tick(request);
}
