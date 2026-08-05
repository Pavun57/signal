import type { SupabaseClient } from "@supabase/supabase-js";

import {
  getEffectiveDailyLimit,
  isWithinSendWindow,
  sendGmailMessage,
} from "@/lib/services/gmail-service";
import {
  resolveSenderConfig,
  type SenderConfig,
} from "@/lib/services/email-transport";
import { trackUsage } from "@/lib/services/cost-tracker";
import { recordVerifiedEmail } from "@/lib/services/email-pattern";
import {
  canSendTo,
  SEND_GATE_COLUMNS,
  type SendCandidate,
} from "@/lib/services/affiliation";
import { resolveTimezoneFromLocation } from "@/lib/services/recipient-timezone";
import { verifyAddressForSend } from "@/lib/services/send-verification";

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
  /**
   * Present on every real row (all loaders select *); the send-window gate
   * uses it to look up a per-sequence scope override.
   */
  sequence_id?: string | null;
}

export type SendResult =
  | { ok: true; messageId: string; draftId: string }
  | { ok: false; reason: string };

/**
 * Why a send did not happen, classified at the point of refusal.
 *
 * `deferred` is the important one to keep separate. Hitting the daily cap is
 * the most common non-send and is completely normal, so folding it in with
 * real failures would fill the failed list with noise within a week of any new
 * mailbox connecting, and the user would stop reading it.
 */
export type SendErrorKind = "deferred" | "blocked" | "failed";

/**
 * Records why a draft did not send, so the reason survives to the UI.
 *
 * These sentences are already written for a person to read ("Not sending to
 * x@y.com: ...", "Draft is addressed to ... but the contact's verified address
 * on file is ..."). Storing them verbatim beats paraphrasing at read time.
 *
 * Never throws: bookkeeping about a refusal must not become a second failure
 * on top of it, matching how recordBounce is treated in email-tracking.
 */
async function recordSendFailure(
  supabase: SupabaseClient,
  draftId: string,
  kind: SendErrorKind,
  reason: string,
): Promise<void> {
  try {
    await supabase
      .from("email_drafts")
      .update({
        last_error: reason,
        last_error_at: new Date().toISOString(),
        last_error_kind: kind,
      })
      .eq("id", draftId);
  } catch (err) {
    console.error("[outreach-sender] recordSendFailure failed:", err);
  }
}

/** Refuse, and leave the reason on the draft for the user to act on. */
async function refuse(
  supabase: SupabaseClient,
  draftId: string,
  kind: SendErrorKind,
  reason: string,
): Promise<{ ok: false; reason: string }> {
  await recordSendFailure(supabase, draftId, kind, reason);
  return { ok: false, reason };
}

/**
 * The one path an email leaves through. Enforces the warmup-ramped daily
 * cap, claims the draft atomically, sends via the user's Gmail, and does the
 * bookkeeping. Every sender — the followups cron, send-now, and the agent's
 * sendEmail/sendBulkEmails tools — must go through here so that overlapping
 * callers can't double-email a prospect.
 *
 * Accepts any Supabase client: the admin client from the job runner, or the
 * RLS-scoped client from agent tools (RLS restricts it to the caller's rows,
 * which is exactly right there).
 */
export async function claimAndSendDraft(
  supabase: SupabaseClient,
  draft: DraftForSend,
  sender: SenderConfig,
  trackMetadata?: Record<string, unknown>,
  opts?: { bypassSendWindow?: boolean },
): Promise<SendResult> {
  const now = new Date().toISOString();

  // Kill switch. Checked before everything else so a paused send spends
  // nothing (no JIT verification credits, no claim) and the draft stays
  // sendable for the moment sending resumes. "deferred": resuming sends it,
  // nothing about the draft or contact needs fixing.
  if (sender.sendingPaused) {
    return refuse(
      supabase,
      draft.id,
      "deferred",
      "Sending is paused in Settings > Email. Unpause to resume.",
    );
  }

  // Send window: cron-driven paths wait for the window; interactive paths
  // (send-now click, agent send confirmed in chat) pass bypassSendWindow —
  // an explicit human "send" beats a schedule preference.
  if (
    !opts?.bypassSendWindow &&
    sender.sendWindowStart !== null &&
    sender.sendWindowEnd !== null
  ) {
    let windowTimezone = sender.sendTimezone;
    let timezoneLabel = sender.sendTimezone ?? "UTC";

    // The sequence can override whose clock the window reads; null inherits
    // the user's global setting.
    let windowScope: "sender" | "recipient" = sender.sendWindowScope;
    if (draft.sequence_id) {
      const { data: seq } = await supabase
        .from("sequences")
        .select("send_window_scope")
        .eq("id", draft.sequence_id)
        .maybeSingle();
      if (seq?.send_window_scope === "recipient") windowScope = "recipient";
      else if (seq?.send_window_scope === "sender") windowScope = "sender";
    }

    // Recipient scope reads the contact's clock instead of the sender's:
    // cached people.timezone first, then resolved best-effort from location
    // strings. Unresolvable falls back to the sender's zone: a send must
    // never be deferred forever because a contact's location is unknown.
    if (windowScope === "recipient" && draft.person_id) {
      const { data: located } = await supabase
        .from("people")
        .select(
          "timezone, location, enrichment_data, organization:organizations(location)",
        )
        .eq("id", draft.person_id)
        .maybeSingle();
      const enrichment = (located?.enrichment_data ?? {}) as Record<
        string,
        unknown
      >;
      const github = (enrichment.github ?? {}) as Record<string, unknown>;
      const org = Array.isArray(located?.organization)
        ? located?.organization[0]
        : located?.organization;
      const recipientTimezone =
        (located?.timezone as string | null) ??
        resolveTimezoneFromLocation(
          located?.location as string | undefined,
          enrichment.location as string | undefined,
          enrichment.city as string | undefined,
          enrichment.country as string | undefined,
          github.location as string | undefined,
          (org as { location?: string | null } | null)?.location,
        );
      if (recipientTimezone) {
        windowTimezone = recipientTimezone;
        timezoneLabel = `${recipientTimezone} (recipient's timezone)`;
        // Cache the resolution so each contact resolves at most once; a
        // location edit clears the cache (people PATCH nulls timezone).
        if (!located?.timezone) {
          await supabase
            .from("people")
            .update({ timezone: recipientTimezone })
            .eq("id", draft.person_id)
            .is("timezone", null);
        }
      }
    }

    if (
      !isWithinSendWindow(
        sender.sendWindowStart,
        sender.sendWindowEnd,
        windowTimezone,
      )
    ) {
      return refuse(
        supabase,
        draft.id,
        "deferred",
        `Outside the configured send window (${sender.sendWindowStart}:00–${sender.sendWindowEnd}:00 ${timezoneLabel}); will send during the next window.`,
      );
    }
  }

  // Data-quality gate, before the claim so a blocked draft stays sendable once
  // the contact is fixed rather than being parked in "queued".
  //
  // This is the last line of defence and the only one that cannot be bypassed:
  // every sender — the followups cron, send-now, and the agent's sendEmail and
  // sendBulkEmails tools — funnels through here. A check placed only in
  // pickAndDraft would be skipped by three of those four.
  if (draft.person_id) {
    const { data: person, error: personError } = await supabase
      .from("people")
      .select(SEND_GATE_COLUMNS)
      .eq("id", draft.person_id)
      .maybeSingle();

    // Fail closed. maybeSingle() returns data: null both for "no such row" and
    // for a query error, so ignoring either would let a transient PostgREST
    // failure, an RLS denial, or a person deleted by a merge wave the send
    // through unchecked — turning the one gate that cannot be bypassed into one
    // that a database hiccup disables. Not sending is always recoverable;
    // sending is not.
    if (personError || !person) {
      return refuse(
        supabase,
        draft.id,
        "failed",
        `Not sending to ${draft.to_email}: could not load the contact to check it (${personError?.message ?? "no such person"}).`,
      );
    }

    // Just-in-time verification — the only place provider credits are spent.
    // Discovery stored this address as a free, unchecked suggestion; now that
    // an email is actually about to leave, prove it. The verdict is cached on
    // the person, so this bills at most once per contact ever, and because it
    // runs inside the daily-send-capped path, verification spend can never
    // outrun sending.
    let gated = person as unknown as SendCandidate & {
      organization_id?: string | null;
    };
    const needsJit =
      !!gated.work_email &&
      gated.work_email_source !== "user_entered" &&
      gated.work_email_source !== "send_confirmed" &&
      gated.work_email_verification !== "deliverable" &&
      gated.work_email_verification !== "undeliverable" &&
      gated.work_email_verification !== "risky";

    if (needsJit && gated.work_email) {
      const jit = await verifyAddressForSend(supabase, {
        personId: draft.person_id,
        email: gated.work_email,
        organizationId: gated.organization_id ?? null,
      });

      if (jit.outcome !== "verified") {
        // blocked and unavailable both refuse; only `blocked` wrote a verdict.
        // Unavailable is retryable — the next attempt re-checks for free.
        return refuse(
          supabase,
          draft.id,
          "blocked",
          `Not sending to ${draft.to_email}: ${jit.reason}.`,
        );
      }

      // The service just wrote verification (and possibly an affiliation
      // upgrade — a deliverable mailbox at the employer's domain is proof of
      // employment). Re-read rather than patching fields by hand so the gate
      // judges exactly what was persisted.
      const { data: refreshed, error: refreshError } = await supabase
        .from("people")
        .select(SEND_GATE_COLUMNS)
        .eq("id", draft.person_id)
        .maybeSingle();
      if (refreshError || !refreshed) {
        return refuse(
          supabase,
          draft.id,
          "failed",
          `Not sending to ${draft.to_email}: could not re-read the contact after verification (${refreshError?.message ?? "no such person"}).`,
        );
      }
      gated = refreshed as unknown as typeof gated;
    }

    const check = canSendTo(gated);
    if (!check.ok) {
      return refuse(
        supabase,
        draft.id,
        "blocked",
        `Not sending to ${draft.to_email}: ${check.reason}.`,
      );
    }

    // The gate's verdict is about the person's address on file — but the mail
    // goes to draft.to_email, which was frozen into the draft when it was
    // written. Sequence drafts for every step are pre-created at enrollment,
    // so after a bounce is fixed by verifying a NEW address onto the person,
    // the remaining steps still carry the old one: without this comparison the
    // gate would approve on the new address's verdict and deliver to the very
    // address that just hard-bounced.
    const personEmail = gated.work_email;
    if (
      personEmail &&
      draft.to_email.toLowerCase() !== personEmail.toLowerCase()
    ) {
      return refuse(
        supabase,
        draft.id,
        "blocked",
        `Draft is addressed to ${draft.to_email}, but the contact's verified address on file is ${personEmail}. Regenerate the draft so it uses the current address.`,
      );
    }
  }

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

  // Warmup-aware daily cap, counted AFTER winning the claim so the snapshot
  // is as late as possible. Concurrent callers claiming different drafts can
  // still each read a pre-insert count, so the cap can overshoot by at most
  // the number of concurrent send paths (cron + send-now + agent tool ≈ 3) —
  // an accepted tolerance; exact enforcement would need a DB-side lock.
  const effectiveLimit = getEffectiveDailyLimit(
    sender.connectedAt,
    sender.dailyLimit,
  );
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);
  const { count, error: countError } = await supabase
    .from("sent_emails")
    .select("id", { count: "exact", head: true })
    .eq("user_id", draft.user_id)
    .gte("sent_at", todayStart.toISOString());

  // A failed count used to read as `count ?? 0`, so any error -- an expired
  // JWT past the retry, a PostgREST hiccup, an RLS denial -- disabled the cap
  // instead of enforcing it, and a 40-draft bulk send could empty itself into
  // a mailbox rated 5/day. Everything else in this function is deliberately
  // fail-closed ("Not sending is always recoverable; sending is not"); this
  // one check was inverted.
  if (countError || count === null) {
    await supabase
      .from("email_drafts")
      .update({ status: "draft", updated_at: new Date().toISOString() })
      .eq("id", draft.id)
      .eq("status", "queued");
    return refuse(
      supabase,
      draft.id,
      "deferred",
      `Could not read today's send count, so the daily limit could not be checked: ${countError?.message ?? "no count returned"}`,
    );
  }

  if (count >= effectiveLimit) {
    // Release the claim — the draft should send tomorrow, not rot in queued.
    await supabase
      .from("email_drafts")
      .update({ status: "draft", updated_at: new Date().toISOString() })
      .eq("id", draft.id)
      .eq("status", "queued");
    return refuse(
      supabase,
      draft.id,
      "deferred",
      `Daily send limit reached (${effectiveLimit}/day${
        effectiveLimit < sender.dailyLimit ? ", warmup ramp" : ""
      }), draft left for tomorrow`,
    );
  }

  // Only a failure of the send itself releases the claim. Once the email has
  // left, bookkeeping errors below must NOT flip the draft back to "draft" —
  // a retry would email the prospect twice. Worst case there is a draft
  // stuck in "queued" with the message already delivered (the cleanup cron
  // reconciles those).
  let sent: { messageId: string };
  try {
    sent = await sendGmailMessage(
      { address: sender.address, appPassword: sender.appPassword },
      {
        fromName: sender.fromName,
        to: draft.to_email,
        subject: draft.subject,
        html: draft.body_html,
        text: draft.body_text ?? undefined,
        replyTo: sender.replyTo ?? undefined,
      },
    );
  } catch (err) {
    // Release the claim so the draft is retryable instead of stuck in
    // "queued" forever.
    await supabase
      .from("email_drafts")
      .update({ status: "draft", updated_at: new Date().toISOString() })
      .eq("id", draft.id)
      .eq("status", "queued");

    const reason = err instanceof Error ? err.message : "Send failed";
    return refuse(supabase, draft.id, "failed", reason);
  }

  // message_id is the RFC 5322 Message-ID — the key IMAP reply/bounce
  // tracking matches In-Reply-To/References against. Never substitute a
  // random value: an unmatched id is better than an unmatchable one.
  const messageId = sent.messageId || null;

  const { error: insertError } = await supabase.from("sent_emails").insert({
    message_id: messageId,
    draft_id: draft.id,
    campaign_people_id: draft.campaign_people_id,
    campaign_id: draft.campaign_id,
    person_id: draft.person_id,
    user_id: draft.user_id,
    to_email: draft.to_email,
    from_email: sender.address,
    subject: draft.subject,
    status: "sent",
    sent_at: now,
  });
  if (insertError) {
    // The email already left — never release the claim — but a missing
    // sent_emails row is invisible to cap counting, reply tracking, and the
    // cleanup reconciler, so it must at least be loud.
    console.error(
      `[outreach-sender] sent_emails insert failed for draft ${draft.id} (message ${messageId}): ${insertError.message}`,
    );
  }

  // A mailbox that accepted an SMTP handover is the strongest evidence we get
  // short of a reply, and it is free. Recording it here is what finally writes
  // `send_confirmed` — the highest-weighted machine source in SOURCE_WEIGHT,
  // which nothing in the codebase had ever set — so a company's email pattern
  // learns from addresses that actually worked. A later bounce reverses it via
  // recordBounce in the tracking cron; together those two are the feedback loop.
  //
  // Deliberately here rather than in sendGmailMessage: the Settings test send
  // calls that directly, has no person_id, and must stay invisible to this
  // bookkeeping.
  if (draft.person_id) {
    try {
      await recordVerifiedEmail(supabase, {
        personId: draft.person_id,
        email: draft.to_email,
        source: "send_confirmed",
      });
    } catch (err) {
      // The email has already left; bookkeeping must never surface as a failure.
      console.error("[outreach-sender] recordVerifiedEmail failed:", err);
    }
  }

  await supabase
    .from("email_drafts")
    .update({
      status: "sent",
      sent_at: now,
      updated_at: now,
      // Clear any earlier refusal. A draft that was blocked on Monday for an
      // unverified address and sends on Tuesday must not keep showing the
      // Monday reason next to a sent email.
      last_error: null,
      last_error_at: null,
      last_error_kind: null,
    })
    .eq("id", draft.id);

  if (draft.campaign_people_id) {
    await supabase
      .from("campaign_people")
      .update({ outreach_status: "sent" })
      .eq("id", draft.campaign_people_id);
  }

  trackUsage({
    service: "gmail",
    operation: "send-email",
    estimated_cost_usd: 0,
    campaign_id: draft.campaign_id ?? undefined,
    user_id: draft.user_id,
    metadata: {
      draftId: draft.id,
      to: draft.to_email,
      ...trackMetadata,
    },
  });

  return { ok: true, messageId: messageId ?? draft.id, draftId: draft.id };
}

/**
 * Moves an enrollment onto its next step, or completes it when the step just
 * sent was the last one.
 *
 * Every path that puts a sequence email on the wire has to call this. When it
 * is skipped the enrollment stays pinned to the step it just sent, so the
 * cron re-reads the same step forever while every *other* step's pre-created
 * draft still looks sendable: the prospect gets the cold email, the follow-up
 * and the breakup mail in the same minute and the sequence can never progress
 * again. `sendEmail` and `sendBulkEmails` both used to skip it.
 */
export async function advanceEnrollmentAfterSend(
  supabase: SupabaseClient,
  enrollment: Pick<EnrollmentForSend, "id" | "sequence_id" | "current_step">,
): Promise<void> {
  const now = new Date().toISOString();
  const nextStep = enrollment.current_step + 1;

  const { data: nextStepRow } = await supabase
    .from("sequence_steps")
    .select("delay_days, delay_hours")
    .eq("sequence_id", enrollment.sequence_id)
    .eq("step_number", nextStep)
    .single();

  if (!nextStepRow) {
    await supabase
      .from("sequence_enrollments")
      .update({ status: "completed", updated_at: now })
      .eq("id", enrollment.id);
    return;
  }

  const delayMs =
    ((nextStepRow.delay_days ?? 0) * 86400 +
      (nextStepRow.delay_hours ?? 0) * 3600) *
    1000;

  await supabase
    .from("sequence_enrollments")
    .update({
      current_step: nextStep,
      status: "active",
      next_send_at: new Date(Date.now() + delayMs).toISOString(),
      updated_at: now,
    })
    .eq("id", enrollment.id);
}

/**
 * Advances the enrollment a draft belongs to, given only the draft's
 * `enrollment_id`. For callers that hold a draft rather than an enrollment.
 *
 * A draft with no enrollment (an ad-hoc one-off) is not an error: there is
 * simply nothing to advance.
 */
export async function advanceEnrollmentForDraft(
  supabase: SupabaseClient,
  enrollmentId: string | null | undefined,
): Promise<void> {
  if (!enrollmentId) return;

  const { data: enrollment } = await supabase
    .from("sequence_enrollments")
    .select("id, sequence_id, current_step")
    .eq("id", enrollmentId)
    .maybeSingle();

  if (!enrollment) return;

  await advanceEnrollmentAfterSend(supabase, {
    id: enrollment.id as string,
    sequence_id: enrollment.sequence_id as string,
    current_step: enrollment.current_step as number,
  });
}

/**
 * Send a draft and advance its enrollment — the composed operation the
 * agent's sendEmail/sendBulkEmails tools need. Exists so the
 * "send succeeded ⇒ enrollment advanced" invariant lives in one place
 * instead of being re-implemented at every tool call site.
 */
export async function sendDraftAndAdvance(
  supabase: SupabaseClient,
  draft: DraftForSend & { enrollment_id?: string | null },
  sender: SenderConfig,
  trackMetadata?: Record<string, unknown>,
  opts?: { bypassSendWindow?: boolean },
): Promise<SendResult> {
  const result = await claimAndSendDraft(
    supabase,
    draft,
    sender,
    trackMetadata,
    opts,
  );
  if (result.ok) {
    // Without this the enrollment stays pinned to the step just sent.
    await advanceEnrollmentForDraft(supabase, draft.enrollment_id);
  }
  return result;
}

/**
 * Is this draft the step its enrollment is actually waiting on?
 *
 * Drafts are pre-created for every step at enrollment time, so "approved and
 * unsent" is not the same as "due". Sending a later step early delivers the
 * follow-up before the email it follows up on.
 */
export async function draftIsCurrentStep(
  supabase: SupabaseClient,
  draft: { enrollment_id?: string | null; sequence_step_id?: string | null },
): Promise<{ current: true } | { current: false; reason: string }> {
  if (!draft.enrollment_id) return { current: true };

  const { data: enrollment } = await supabase
    .from("sequence_enrollments")
    .select("sequence_id, current_step")
    .eq("id", draft.enrollment_id)
    .maybeSingle();

  if (!enrollment) return { current: true };

  const { data: step } = await supabase
    .from("sequence_steps")
    .select("id")
    .eq("sequence_id", enrollment.sequence_id as string)
    .eq("step_number", enrollment.current_step as number)
    .maybeSingle();

  if (!step) return { current: true };

  if (step.id !== draft.sequence_step_id) {
    return {
      current: false,
      reason: `Not this enrollment's current step (waiting on step ${enrollment.current_step}). Send that step first.`,
    };
  }
  return { current: true };
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
  opts?: { bypassSendWindow?: boolean },
): Promise<SendResult> {
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

  const sender = await resolveSenderConfig(supabase, draft.user_id);
  if ("error" in sender) return { ok: false, reason: sender.error };

  const sent = await claimAndSendDraft(
    supabase,
    {
      ...(draft as DraftForSend),
      // The enrollment is the authority on who this send is for.
      campaign_people_id: enrollment.campaign_people_id,
      person_id: enrollment.person_id,
    },
    sender,
    { sequenceId: enrollment.sequence_id },
    opts,
  );

  if (!sent.ok) return sent;

  await advanceEnrollmentAfterSend(supabase, enrollment);

  return sent;
}
