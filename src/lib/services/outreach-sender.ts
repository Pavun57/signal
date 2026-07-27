import { getAdminClient } from "@/lib/supabase/admin";
import { sendMessage } from "@/lib/services/agentmail-service";
import { trackUsage } from "@/lib/services/cost-tracker";

export interface EnrollmentForSend {
  id: string;
  sequence_id: string;
  person_id: string;
  campaign_people_id: string;
  current_step: number;
}

export type SendResult =
  | { ok: true; messageId: string; draftId: string }
  | { ok: false; reason: string };

/**
 * Sends the next pending approved draft for an enrollment.
 *
 * Expects the enrollment's step to have a draft with
 * `review_status = "approved"` and `status = "draft"`.
 *
 * On success: marks draft sent, records sent_emails row, updates
 * campaign_people.outreach_status, advances the enrollment to the next
 * step (or marks it completed). Ignores enrollment.next_send_at — callers
 * that need to respect delays must check before calling.
 */
export async function sendApprovedDraft(
  supabase: ReturnType<typeof getAdminClient>,
  enrollment: EnrollmentForSend,
): Promise<SendResult> {
  const now = new Date().toISOString();

  const { data: step } = await supabase
    .from("sequence_steps")
    .select("id")
    .eq("sequence_id", enrollment.sequence_id)
    .eq("step_number", enrollment.current_step)
    .single();

  if (!step) return { ok: false, reason: "Step not found" };

  const { data: draft } = await supabase
    .from("email_drafts")
    .select("*")
    .eq("enrollment_id", enrollment.id)
    .eq("sequence_step_id", step.id)
    .eq("review_status", "approved")
    .eq("status", "draft")
    .single();

  if (!draft) {
    return { ok: false, reason: "No approved draft ready for this step" };
  }

  const { data: settings } = await supabase
    .from("user_settings")
    .select("agentmail_inbox_id")
    .eq("user_id", draft.user_id)
    .single();

  if (!settings?.agentmail_inbox_id) {
    return { ok: false, reason: "No AgentMail inbox configured" };
  }

  // Atomically claim the draft before sending. Overlapping callers — the
  // followups cron racing a send-now click, or two process invocations — all
  // pass the read above; only the one whose conditional update lands gets to
  // send, so the prospect can't receive the same email twice.
  const { data: claimed } = await supabase
    .from("email_drafts")
    .update({ status: "queued", updated_at: now })
    .eq("id", draft.id)
    .eq("status", "draft")
    .select("id")
    .maybeSingle();

  if (!claimed) {
    return { ok: false, reason: "Draft already claimed by another send" };
  }

  // Only a failure of the send itself releases the claim. Once the email has
  // left, bookkeeping errors below must NOT flip the draft back to "draft" —
  // a retry would email the prospect twice. Worst case there is a draft
  // stuck in "queued" with the message already delivered.
  let result: Awaited<ReturnType<typeof sendMessage>>;
  try {
    result = await sendMessage(settings.agentmail_inbox_id, {
      to: draft.to_email,
      subject: draft.subject,
      html: draft.body_html,
      text: draft.body_text ?? undefined,
    });
  } catch (err) {
    // Release the claim so the draft is retryable instead of stuck in
    // "queued" forever.
    await supabase
      .from("email_drafts")
      .update({ status: "draft", updated_at: new Date().toISOString() })
      .eq("id", draft.id)
      .eq("status", "queued");

    const reason = err instanceof Error ? err.message : "Send failed";
    return { ok: false, reason };
  }

  const messageId = result.messageId ?? crypto.randomUUID();
  const threadId = result.threadId ?? null;

  await supabase.from("sent_emails").insert({
    agentmail_message_id: messageId,
    agentmail_thread_id: threadId,
    draft_id: draft.id,
    campaign_people_id: enrollment.campaign_people_id,
    campaign_id: draft.campaign_id,
    person_id: enrollment.person_id,
    user_id: draft.user_id,
    to_email: draft.to_email,
    from_email: settings.agentmail_inbox_id,
    subject: draft.subject,
    status: "sent",
    sent_at: now,
  });

  await supabase
    .from("email_drafts")
    .update({ status: "sent", sent_at: now, updated_at: now })
    .eq("id", draft.id);

  await supabase
    .from("campaign_people")
    .update({ outreach_status: "sent" })
    .eq("id", enrollment.campaign_people_id);

  const nextStep = enrollment.current_step + 1;
  const { data: nextStepRow } = await supabase
    .from("sequence_steps")
    .select("delay_days, delay_hours")
    .eq("sequence_id", enrollment.sequence_id)
    .eq("step_number", nextStep)
    .single();

  if (nextStepRow) {
    const delayMs =
      ((nextStepRow.delay_days ?? 0) * 86400 +
        (nextStepRow.delay_hours ?? 0) * 3600) *
      1000;
    const nextSendAt = new Date(Date.now() + delayMs).toISOString();

    await supabase
      .from("sequence_enrollments")
      .update({
        current_step: nextStep,
        status: "active",
        next_send_at: nextSendAt,
        updated_at: now,
      })
      .eq("id", enrollment.id);
  } else {
    await supabase
      .from("sequence_enrollments")
      .update({ status: "completed", updated_at: now })
      .eq("id", enrollment.id);
  }

  trackUsage({
    service: "agentmail",
    operation: "send-email",
    estimated_cost_usd: 0.0004,
    campaign_id: draft.campaign_id,
    user_id: draft.user_id,
    metadata: {
      draftId: draft.id,
      to: draft.to_email,
      sequenceId: enrollment.sequence_id,
    },
  });

  return { ok: true, messageId, draftId: draft.id };
}
