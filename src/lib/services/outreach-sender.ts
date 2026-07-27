import type { SupabaseClient } from "@supabase/supabase-js";

import { sendMessage } from "@/lib/services/agentmail-service";
import { trackUsage } from "@/lib/services/cost-tracker";

export interface EnrollmentForSend {
  id: string;
  sequence_id: string;
  person_id: string;
  campaign_people_id: string;
  current_step: number;
}

/** The columns the send core needs from an email_drafts row. */
export interface DraftForSend {
  id: string;
  user_id: string;
  campaign_id: string | null;
  person_id: string | null;
  campaign_people_id: string | null;
  to_email: string;
  subject: string;
  body_html: string;
  body_text: string | null;
}

export type SendResult =
  | { ok: true; messageId: string; draftId: string }
  | { ok: false; reason: string };

/**
 * The one path an email leaves through. Claims the draft atomically, sends,
 * and does the bookkeeping. Every sender — the followups cron, send-now, and
 * the agent's sendEmail/sendBulkEmails tools — must go through here so that
 * overlapping callers can't double-email a prospect.
 *
 * Accepts any Supabase client: the admin client from QStash handlers, or the
 * RLS-scoped client from agent tools (RLS restricts it to the caller's rows,
 * which is exactly right there).
 */
export async function claimAndSendDraft(
  supabase: SupabaseClient,
  draft: DraftForSend,
  inboxId: string,
  trackMetadata?: Record<string, unknown>,
): Promise<SendResult> {
  const now = new Date().toISOString();

  // Atomically claim the draft before sending. Overlapping callers — the
  // followups cron racing a send-now click, agent retries, or two process
  // invocations — all pass their reads; only the one whose conditional
  // update lands gets to send.
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
  // stuck in "queued" with the message already delivered (the cleanup cron
  // reconciles those).
  let result: Awaited<ReturnType<typeof sendMessage>>;
  try {
    result = await sendMessage(inboxId, {
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
    campaign_people_id: draft.campaign_people_id,
    campaign_id: draft.campaign_id,
    person_id: draft.person_id,
    user_id: draft.user_id,
    to_email: draft.to_email,
    from_email: inboxId,
    subject: draft.subject,
    status: "sent",
    sent_at: now,
  });

  await supabase
    .from("email_drafts")
    .update({ status: "sent", sent_at: now, updated_at: now })
    .eq("id", draft.id);

  if (draft.campaign_people_id) {
    await supabase
      .from("campaign_people")
      .update({ outreach_status: "sent" })
      .eq("id", draft.campaign_people_id);
  }

  trackUsage({
    service: "agentmail",
    operation: "send-email",
    estimated_cost_usd: 0.0004,
    campaign_id: draft.campaign_id ?? undefined,
    user_id: draft.user_id,
    metadata: {
      draftId: draft.id,
      to: draft.to_email,
      ...trackMetadata,
    },
  });

  return { ok: true, messageId, draftId: draft.id };
}

/**
 * Sends the next pending approved draft for an enrollment.
 *
 * Expects the enrollment's step to have a draft with
 * `review_status = "approved"` and `status = "draft"`.
 *
 * On success: sends via claimAndSendDraft (claim, sent_emails row,
 * outreach_status), then advances the enrollment to the next step (or marks
 * it completed). Ignores enrollment.next_send_at — callers that need to
 * respect delays must check before calling.
 */
export async function sendApprovedDraft(
  supabase: SupabaseClient,
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

  const sent = await claimAndSendDraft(
    supabase,
    {
      ...(draft as DraftForSend),
      // The enrollment is the authority on who this send is for.
      campaign_people_id: enrollment.campaign_people_id,
      person_id: enrollment.person_id,
    },
    settings.agentmail_inbox_id,
    { sequenceId: enrollment.sequence_id },
  );

  if (!sent.ok) return sent;

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

  return sent;
}
