import { getAdminClient } from "@/lib/supabase/admin";
import { getPostHogClient } from "@/lib/posthog-server";
import { sendApprovedDraft } from "@/lib/services/outreach-sender";
import {
  canDraftFor,
  SEND_GATE_COLUMNS,
  type SendCandidate,
} from "@/lib/services/affiliation";
import {
  selectContactsForSignal,
  type Candidate,
} from "@/lib/services/contact-selector";
import { composeEmail } from "@/lib/email-composition/compose";
import { loadVoiceProfile } from "@/lib/email-composition/load-voice";
import { saveDraft } from "@/lib/email-composition/save";
import { loadSenderFacts, renderFactBank } from "@/lib/sender-facts";

/**
 * Outreach processor. Handles two jobs:
 *
 * 1. Signal-triggered sends: enqueued by the tracking.run executor after a
 *    threshold crossing. Payload: { signalId, campaignId, organizationId }
 *
 * 2. Time-delayed follow-ups: the seeded recurring job. Payload: { type: "followups" }
 *    Checks sequence_enrollments where next_send_at <= now and conditions are met.
 */

interface SignalPayload {
  type: "signal";
  signalId: string;
  campaignId: string;
  organizationId?: string;
  reason?: string;
  confidence?: string;
}

interface FollowupPayload {
  type: "followups";
}

type Payload = SignalPayload | FollowupPayload;

export type { Payload, SignalPayload, FollowupPayload };

/**
 * Job-queue entry point for outreach processing. This executor sends real
 * email through the admin client, and the /api/jobs routes that reach it are
 * public (Vercel Cron / pg_cron can't send Clerk cookies), so the CRON_SECRET
 * bearer check on those routes is the only thing standing between the
 * internet and the user's outbox. All callers must go through the job queue:
 * the signal path enqueues from the tracking.run executor, and the followups
 * schedule is the seeded recurring {"type":"followups"} job, not a bare cron.
 */
export async function processOutreach(payload: Payload) {
  const supabase = getAdminClient();
  if (payload.type === "signal") {
    return handleSignalTrigger(supabase, payload);
  }
  if (payload.type === "followups") {
    return handleFollowups(supabase);
  }
  throw new Error(
    `Unknown outreach payload type: ${(payload as { type?: string }).type}`,
  );
}

// ── Signal-triggered sends ─────────────────────────────────────────────────

async function handleSignalTrigger(
  supabase: ReturnType<typeof getAdminClient>,
  payload: SignalPayload,
) {
  // Sequences triggered by this signal in this campaign.
  //
  // "draft" is included deliberately. `createSequence` is the only writer of
  // this column and it only ever writes "draft" -- nothing in the codebase
  // has ever promoted a sequence to "active", so requiring "active" here
  // meant this function returned "no matching sequences" for every user and
  // the whole signal -> pick -> draft -> send loop was dead code.
  //
  // Accepting "draft" cannot leak an unreviewed email: pickAndDraft leaves
  // its drafts pending for the reviewer, and the send below goes through
  // sendApprovedDraft, which requires review_status = 'approved'. "paused"
  // and "completed" stay excluded, so pausing still halts a sequence.
  const { data: sequences } = await supabase
    .from("sequences")
    .select("id, user_id")
    .eq("trigger_signal_id", payload.signalId)
    .eq("campaign_id", payload.campaignId)
    .in("status", ["draft", "active"]);

  if (!sequences || sequences.length === 0) {
    return { sent: 0, reason: "no matching sequences" };
  }

  const sequenceIds = sequences.map((s) => s.id);

  // Org-scoped fires: pick the best contact, auto-enroll, auto-draft.
  // Person-scoped fires (no organizationId): skip selection and use the
  // legacy pre-enrolled path directly.
  let drafted = 0;
  if (payload.organizationId) {
    drafted = await pickAndDraft(supabase, payload, sequences);
    // pickAndDraft returns 0 and logs when there are no candidates; fall
    // through to the send loop either way -- legacy pre-approved drafts
    // for this org should still send.
  }

  // Find enrollments for this signal's sequences. Include status "waiting"
  // (legacy pre-enrolled) and newly-created "queued" enrollments that already
  // had an approved draft saved some other way. Pending drafts from
  // pickAndDraft stay in the queue for the reviewer.
  let enrollmentQuery = supabase
    .from("sequence_enrollments")
    .select("id, sequence_id, person_id, campaign_people_id, current_step")
    .in("sequence_id", sequenceIds)
    .in("status", ["waiting", "queued"])
    .eq("current_step", 1);

  if (payload.organizationId) {
    const { data: people } = await supabase
      .from("people")
      .select("id")
      .eq("organization_id", payload.organizationId);
    if (!people || people.length === 0) {
      return {
        sent: 0,
        drafted,
        reason: "no contacts at this org -- run findContacts for this org",
      };
    }
    enrollmentQuery = enrollmentQuery.in(
      "person_id",
      people.map((p) => p.id),
    );
  }

  const { data: enrollments } = await enrollmentQuery;

  if (!enrollments || enrollments.length === 0) {
    return { sent: 0, drafted, reason: "no enrollments" };
  }

  let sent = 0;
  const failures: Record<string, number> = {};
  for (const enrollment of enrollments) {
    const result = await sendApprovedDraft(supabase, enrollment);
    if (result.ok) {
      sent++;
    } else {
      console.error(
        `[outreach/process] signal send failed for enrollment ${enrollment.id}: ${result.reason}`,
      );
      failures[result.reason] = (failures[result.reason] ?? 0) + 1;
    }
  }

  return {
    sent,
    drafted,
    total: enrollments.length,
    failures,
  };
}

// ── Contact selection + auto-draft for org-scoped fires ────────────────────

async function pickAndDraft(
  supabase: ReturnType<typeof getAdminClient>,
  payload: SignalPayload,
  sequences: Array<{ id: string; user_id: string }>,
): Promise<number> {
  if (!payload.organizationId) return 0;

  // Load signal metadata for the selector prompt.
  const { data: signal } = await supabase
    .from("signals")
    .select("name, category")
    .eq("id", payload.signalId)
    .single();

  // Load candidates: people at the org joined with campaign_people for this
  // campaign. Skip contacts already replied/bounced/complained.
  const { data: people } = await supabase
    .from("people")
    .select(
      `id, name, title, work_email, personal_email, linkedin_url, enrichment_data, ${SEND_GATE_COLUMNS}`,
    )
    .eq("organization_id", payload.organizationId);

  if (!people || people.length === 0) return 0;

  const personIds = people.map((p) => p.id as string);
  const { data: cpRows } = await supabase
    .from("campaign_people")
    .select("id, person_id, priority_score, outreach_status")
    .eq("campaign_id", payload.campaignId)
    .in("person_id", personIds);

  const cpByPersonId = new Map<string, Record<string, unknown>>();
  for (const cp of cpRows ?? []) {
    cpByPersonId.set(cp.person_id as string, cp as Record<string, unknown>);
  }

  // Anyone already in flight or contacted is off-limits for a fresh draft —
  // a second signal fire must not re-email someone mid-sequence.
  const SKIP_STATUSES = new Set([
    "queued",
    "sent",
    "delivered",
    "opened",
    "clicked",
    "replied",
    "bounced",
    "complained",
  ]);
  const candidates: Candidate[] = [];
  const blockedByGate: string[] = [];
  for (const p of people) {
    const cp = cpByPersonId.get(p.id as string);
    if (!cp) continue; // not in this campaign
    const status = cp.outreach_status as string;
    if (SKIP_STATUSES.has(status)) continue;
    // Must have an email to be draft-able. saveDraft reads work_email ?? personal_email.
    const email = (p.work_email as string) ?? (p.personal_email as string);
    if (!email) continue;
    // Don't spend a Claude call drafting for someone the send gate will refuse.
    // outreach-sender re-checks this — that is the authoritative gate — but
    // filtering here means a signal fire doesn't quietly bill for a draft that
    // can never leave.
    // Draft-stage check, deliberately NOT canSendTo: an unchecked address is
    // draftable — the send gate verifies it just-in-time when the mail leaves.
    const gate = canDraftFor(p as unknown as SendCandidate);
    if (!gate.ok) {
      blockedByGate.push(`${p.name ?? p.id}: ${gate.reason}`);
      continue;
    }
    const enrichment = p.enrichment_data as Record<string, unknown> | null;
    candidates.push({
      personId: p.id as string,
      name: (p.name as string) ?? null,
      title: (p.title as string) ?? null,
      workEmail: email,
      linkedinUrl: (p.linkedin_url as string) ?? null,
      priorityScore: (cp.priority_score as number) ?? null,
      enrichmentSummary: summarizeEnrichment(enrichment),
    });
  }

  if (candidates.length === 0) {
    if (blockedByGate.length > 0) {
      console.warn(
        `[outreach/process] ${blockedByGate.length} contact(s) blocked by the data-quality gate: ${blockedByGate.slice(0, 5).join("; ")}`,
      );
    }
    return 0;
  }

  const { picks } = await selectContactsForSignal({
    reason: payload.reason ?? "Signal fired",
    signalName: (signal?.name as string) ?? "Unknown signal",
    signalCategory: (signal?.category as string) ?? "custom",
    candidates,
    maxPicks: 1,
  });

  if (picks.length === 0) return 0;

  // Load campaign + sender profile once (shared across all picks/sequences).
  const { data: campaign } = await supabase
    .from("campaigns")
    .select("name, icp, offering, positioning, profile_id")
    .eq("id", payload.campaignId)
    .single();

  let senderProfile: Record<string, unknown> | null = null;
  if (campaign?.profile_id) {
    const { data: profile } = await supabase
      .from("user_profile")
      .select("id, name, role_title, company_name, offering_summary, notes")
      .eq("id", campaign.profile_id)
      .single();
    senderProfile = (profile as Record<string, unknown>) ?? null;
  }

  // Sender fact bank, loaded once for the whole batch (never per contact).
  const factBank = renderFactBank(
    await loadSenderFacts(supabase, campaign?.profile_id ?? null),
  );

  const { data: org } = await supabase
    .from("organizations")
    .select("name, domain, industry, enrichment_data")
    .eq("id", payload.organizationId)
    .single();

  const ownerId = sequences[0]?.user_id ?? null;
  const voice = ownerId
    ? await loadVoiceProfile(supabase, ownerId, payload.campaignId)
    : null;

  let drafted = 0;

  for (const pick of picks) {
    const person = people.find((p) => p.id === pick.personId);
    const cp = cpByPersonId.get(pick.personId);
    if (!person || !cp) continue;

    for (const seq of sequences) {
      // Upsert enrollment (unique on sequence_id, campaign_people_id).
      const { data: existingEnrollment } = await supabase
        .from("sequence_enrollments")
        .select("id, status")
        .eq("sequence_id", seq.id)
        .eq("campaign_people_id", cp.id)
        .maybeSingle();

      let enrollmentId: string;
      if (existingEnrollment) {
        if (
          existingEnrollment.status !== "waiting" &&
          existingEnrollment.status !== "queued"
        ) {
          continue; // person already moved past step 1
        }
        enrollmentId = existingEnrollment.id as string;
      } else {
        const { data: newEnrollment, error: enrollErr } = await supabase
          .from("sequence_enrollments")
          .insert({
            sequence_id: seq.id,
            campaign_people_id: cp.id,
            person_id: pick.personId,
            current_step: 1,
            status: "waiting",
            waiting_since: new Date().toISOString(),
          })
          .select("id")
          .single();
        if (enrollErr || !newEnrollment) {
          console.error("[outreach] enrollment insert failed", enrollErr);
          continue;
        }
        enrollmentId = newEnrollment.id as string;
      }

      // Load step 1 and total steps for this sequence.
      const { data: step1 } = await supabase
        .from("sequence_steps")
        .select("id, step_number, condition")
        .eq("sequence_id", seq.id)
        .eq("step_number", 1)
        .single();
      if (!step1) continue;

      const { count: totalSteps } = await supabase
        .from("sequence_steps")
        .select("*", { count: "exact", head: true })
        .eq("sequence_id", seq.id);

      // Skip if a draft already exists for (enrollment, step).
      const { data: existingDraft } = await supabase
        .from("email_drafts")
        .select("id")
        .eq("enrollment_id", enrollmentId)
        .eq("sequence_step_id", step1.id)
        .maybeSingle();
      if (existingDraft) continue;

      // Compose.
      const composed = await composeEmail({
        voice,
        contact: {
          name: (person.name as string) ?? null,
          title: (person.title as string) ?? null,
          email: (person.work_email as string) ?? "unknown@example.com", // placeholder; saveDraft re-reads from DB
          enrichmentData:
            (person.enrichment_data as Record<string, unknown>) ?? null,
        },
        company: org
          ? {
              name: (org.name as string) ?? null,
              domain: (org.domain as string) ?? null,
              industry: (org.industry as string) ?? null,
              enrichmentData:
                (org.enrichment_data as Record<string, unknown>) ?? null,
            }
          : null,
        step: {
          stepNumber: 1,
          totalSteps: totalSteps ?? 1,
          condition: (step1.condition as string) ?? "always",
          isFinal: (totalSteps ?? 1) === 1,
        },
        campaign: {
          name: (campaign?.name as string) ?? "Campaign",
          icp: (campaign?.icp as Record<string, unknown>) ?? null,
          offering: (campaign?.offering as Record<string, unknown>) ?? null,
          positioning:
            (campaign?.positioning as Record<string, unknown>) ?? null,
        },
        senderProfile: {
          name: (senderProfile?.name as string) ?? null,
          title: (senderProfile?.role_title as string) ?? null,
          company: (senderProfile?.company_name as string) ?? null,
          signature: null,
          offeringSummary: (senderProfile?.offering_summary as string) ?? null,
          notes: (senderProfile?.notes as string) ?? null,
        },
        factBank,
        triggerReason: payload.reason ?? null,
      });

      if (!composed.ok) {
        console.error(
          "[outreach] compose failed",
          pick.personId,
          composed.error,
        );
        continue;
      }

      const saveResult = await saveDraft(
        supabase as unknown as Parameters<typeof saveDraft>[0],
        {
          userId: seq.user_id,
          campaignId: payload.campaignId,
          personId: pick.personId,
          subject: composed.email.subject,
          bodyHtml: composed.email.bodyHtml,
          bodyText: composed.email.bodyText ?? null,
          sequenceId: seq.id,
          sequenceStepId: step1.id as string,
          enrollmentId,
          aiReasoning: payload.reason ?? composed.email.aiReasoning ?? null,
        },
      );

      if (saveResult.ok) {
        drafted++;
        getPostHogClient().capture({
          distinctId: seq.user_id,
          event: "outreach_drafted",
          properties: {
            campaign_id: payload.campaignId,
            signal_id: payload.signalId,
            sequence_id: seq.id,
            person_id: pick.personId,
            organization_id: payload.organizationId ?? null,
          },
        });
      } else {
        console.error("[outreach] saveDraft failed", saveResult.error);
      }
    }
  }

  return drafted;
}

function summarizeEnrichment(
  data: Record<string, unknown> | null,
): string | null {
  if (!data) return null;
  const headline = (data.headline as string) ?? (data.summary as string);
  if (typeof headline === "string" && headline.length > 0) {
    return headline.slice(0, 240);
  }
  return null;
}

// ── Time-delayed follow-ups ────────────────────────────────────────────────

async function handleFollowups(supabase: ReturnType<typeof getAdminClient>) {
  const now = new Date().toISOString();

  // Find enrollments where it's time to send the next step
  const { data: dueEnrollments } = await supabase
    .from("sequence_enrollments")
    .select("id, sequence_id, person_id, campaign_people_id, current_step")
    .eq("status", "active")
    .lte("next_send_at", now)
    .limit(50);

  // Also pick up enrollments still parked at "waiting": pickAndDraft leaves
  // them there pending review, and nothing re-enters after the reviewer
  // approves — without this, bulk-approved step-1 drafts never send.
  const { data: waitingEnrollments } = await supabase
    .from("sequence_enrollments")
    .select("id, sequence_id, person_id, campaign_people_id, current_step")
    .eq("status", "waiting")
    .limit(50);

  let approvedWaiting: typeof waitingEnrollments = [];
  if (waitingEnrollments && waitingEnrollments.length > 0) {
    const { data: approvedDrafts } = await supabase
      .from("email_drafts")
      .select("enrollment_id")
      .in(
        "enrollment_id",
        waitingEnrollments.map((e) => e.id),
      )
      .eq("review_status", "approved")
      .eq("status", "draft");
    const approvedIds = new Set(
      (approvedDrafts ?? []).map((d) => d.enrollment_id as string),
    );
    approvedWaiting = waitingEnrollments.filter((e) => approvedIds.has(e.id));
  }

  const enrollments = [...(dueEnrollments ?? []), ...(approvedWaiting ?? [])];

  if (enrollments.length === 0) {
    return { sent: 0 };
  }

  let sent = 0;
  let skipped = 0;
  const failures: Record<string, number> = {};

  for (const enrollment of enrollments) {
    // Load the step to check its condition
    const { data: step } = await supabase
      .from("sequence_steps")
      .select("id, condition")
      .eq("sequence_id", enrollment.sequence_id)
      .eq("step_number", enrollment.current_step)
      .single();

    if (!step) {
      // No more steps -- mark completed
      await supabase
        .from("sequence_enrollments")
        .update({ status: "completed", updated_at: now })
        .eq("id", enrollment.id);
      continue;
    }

    // Check condition against outreach status
    const { data: cp } = await supabase
      .from("campaign_people")
      .select("outreach_status")
      .eq("id", enrollment.campaign_people_id)
      .single();

    const outreachStatus = cp?.outreach_status ?? "sent";

    // If they replied, stop the sequence
    if (outreachStatus === "replied") {
      await supabase
        .from("sequence_enrollments")
        .update({ status: "replied", updated_at: now })
        .eq("id", enrollment.id);
      skipped++;
      continue;
    }

    // If they bounced, stop the sequence
    if (outreachStatus === "bounced" || outreachStatus === "complained") {
      await supabase
        .from("sequence_enrollments")
        .update({ status: "bounced", updated_at: now })
        .eq("id", enrollment.id);
      skipped++;
      continue;
    }

    // Check step condition
    const shouldSend = checkCondition(step.condition, outreachStatus);
    if (!shouldSend) {
      skipped++;
      continue;
    }

    const result = await sendApprovedDraft(supabase, enrollment);
    if (result.ok) {
      sent++;
    } else {
      // Never swallow the reason: capped, unconfigured, and claimed-elsewhere
      // outcomes must be distinguishable in job logs.
      console.error(
        `[outreach/process] followup send failed for enrollment ${enrollment.id}: ${result.reason}`,
      );
      failures[result.reason] = (failures[result.reason] ?? 0) + 1;
    }
  }

  return {
    sent,
    skipped,
    total: enrollments.length,
    failures,
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────

function checkCondition(condition: string, outreachStatus: string): boolean {
  switch (condition) {
    case "always":
      return true;
    case "no_reply":
      return outreachStatus !== "replied";
    case "no_open":
      return !["opened", "clicked", "replied"].includes(outreachStatus);
    case "opened_no_reply":
      return ["opened", "clicked"].includes(outreachStatus);
    default:
      return true;
  }
}
