import { after, NextResponse } from "next/server";
import { isJobRequestAuthorized } from "@/lib/services/jobs";
import { executeClaimedJob } from "@/lib/jobs/execute";

// One invocation per job. 202 goes back to the tick immediately; the actual
// work runs in after() with this route's full duration budget. A runner that
// dies mid-job never reports back — the job's lease expires and claim_jobs()
// reaps it back to pending, which is the retry path.
export const maxDuration = 300;

export async function POST(request: Request) {
  if (!isJobRequestAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as {
    jobId?: unknown;
  } | null;
  if (!body || typeof body.jobId !== "string") {
    return NextResponse.json({ error: "jobId required" }, { status: 400 });
  }
  const jobId = body.jobId;

  after(async () => {
    await executeClaimedJob(jobId);
  });

  return NextResponse.json({ accepted: jobId }, { status: 202 });
}
