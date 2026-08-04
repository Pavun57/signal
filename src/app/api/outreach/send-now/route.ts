import { NextResponse } from "next/server";

import { sendApprovedDraft } from "@/lib/services/outreach-sender";
import { getPostHogClient } from "@/lib/posthog-server";
import { getAdminClient } from "@/lib/supabase/admin";
import { getSupabaseAndUser } from "@/lib/supabase/server";

export const maxDuration = 60;

interface Body {
  draftId?: string;
}

export async function POST(request: Request) {
  const ctx = await getSupabaseAndUser();
  if (!ctx) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { user } = ctx;

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!body.draftId) {
    return NextResponse.json({ error: "draftId is required" }, { status: 400 });
  }

  const supabase = getAdminClient();

  const { data: draft, error: draftError } = await supabase
    .from("email_drafts")
    .select(
      "id, user_id, review_status, status, enrollment_id, sequence_step_id",
    )
    .eq("id", body.draftId)
    .single();

  if (draftError || !draft) {
    return NextResponse.json({ error: "Draft not found" }, { status: 404 });
  }

  if (draft.user_id !== user.id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  if (draft.review_status !== "approved") {
    return NextResponse.json(
      {
        ok: false,
        blocker: "not_approved",
        error: "Draft must be approved before it can be sent",
      },
      { status: 409 },
    );
  }

  if (draft.status !== "draft") {
    return NextResponse.json(
      {
        ok: false,
        blocker: "already_sent",
        error: `Draft is already ${draft.status}`,
      },
      { status: 409 },
    );
  }

  if (!draft.enrollment_id) {
    return NextResponse.json(
      {
        ok: false,
        blocker: "no_enrollment",
        error: "Draft has no enrollment",
      },
      { status: 409 },
    );
  }

  // sendApprovedDraft resolves the draft to send from the *enrollment*, not
  // from body.draftId, and this runs on the admin client. enrollment_id is an
  // attacker-settable column on a row they own -- email_drafts_insert only
  // asserts user_id -- and sequence_enrollments carries no user_id of its own,
  // so ownership has to be read through the sequence. Without this join a
  // crafted draft pointing at someone else's enrollment sends their approved
  // email, from their mailbox, against their daily cap.
  const { data: enrollment } = await supabase
    .from("sequence_enrollments")
    .select(
      "id, sequence_id, person_id, campaign_people_id, current_step, sequence:sequences!inner(user_id)",
    )
    .eq("id", draft.enrollment_id)
    .single();

  if (!enrollment) {
    return NextResponse.json(
      { ok: false, blocker: "no_enrollment", error: "Enrollment not found" },
      { status: 404 },
    );
  }

  const enrollmentOwner = (
    enrollment.sequence as unknown as { user_id?: string } | null
  )?.user_id;
  if (!enrollmentOwner || enrollmentOwner !== user.id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // sendApprovedDraft resolves the draft from the enrollment's current step,
  // NOT from body.draftId — so if the clicked draft belongs to a different
  // step, proceeding would silently send a different email than the one the
  // reviewer looked at. Refuse instead.
  const { data: currentStep } = await supabase
    .from("sequence_steps")
    .select("id")
    .eq("sequence_id", enrollment.sequence_id)
    .eq("step_number", enrollment.current_step)
    .single();

  if (!currentStep || currentStep.id !== draft.sequence_step_id) {
    return NextResponse.json(
      {
        ok: false,
        blocker: "step_mismatch",
        error: `This draft is not the enrollment's current step (step ${enrollment.current_step}). Send or discard the current step's draft first.`,
      },
      { status: 409 },
    );
  }

  const result = await sendApprovedDraft(supabase, enrollment);

  if (!result.ok) {
    return NextResponse.json(
      { ok: false, error: result.reason },
      { status: 500 },
    );
  }

  const posthog = getPostHogClient();
  posthog.capture({
    distinctId: user.id,
    event: "outreach_email_sent",
    properties: {
      draft_id: result.draftId,
      sequence_id: enrollment.sequence_id,
      person_id: enrollment.person_id,
      step: enrollment.current_step,
    },
  });

  return NextResponse.json({
    ok: true,
    draftId: result.draftId,
    messageId: result.messageId,
    sentAt: new Date().toISOString(),
  });
}
