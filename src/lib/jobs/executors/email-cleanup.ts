import { getAdminClient } from "@/lib/supabase/admin";
import {
  advanceEnrollmentForDraft,
  draftIsCurrentStep,
} from "@/lib/services/outreach-sender";

/**
 * Draft cleanup (recurring job, daily).
 * - Recovers drafts stranded in "queued" by a send process that died
 * - Deletes discarded drafts older than 7 days
 * - Deletes stale drafts (never sent) older than 30 days
 */
export async function cleanupEmails(): Promise<{
  cleaned: { discarded: number; stale: number };
  recovered: { markedSent: number; returnedToDraft: number };
}> {
  const supabase = getAdminClient();

  const sevenDaysAgo = new Date(
    Date.now() - 7 * 24 * 60 * 60 * 1000,
  ).toISOString();
  const thirtyDaysAgo = new Date(
    Date.now() - 30 * 24 * 60 * 60 * 1000,
  ).toISOString();

  // Recover drafts stranded in "queued": the send claim was taken but the
  // process died before finishing. If a sent_emails row exists the message
  // left the building — finish the bookkeeping as "sent". If none exists the
  // send (almost certainly) never happened — release back to "draft" so it's
  // retryable. The residual risk (crash in the instant between the SMTP send
  // accepting the send and the sent_emails insert) is taken deliberately:
  // after 24h, a stuck invisible draft is worse than the sliver of a chance
  // of a duplicate.
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  let recoveredSent = 0;
  let recoveredDraft = 0;

  const { data: stuck, error: stuckError } = await supabase
    .from("email_drafts")
    .select("id, enrollment_id, campaign_people_id, sequence_step_id")
    .eq("status", "queued")
    .lt("updated_at", dayAgo);
  if (stuckError) throw new Error(`stuck-draft scan: ${stuckError.message}`);

  if (stuck && stuck.length > 0) {
    const ids = stuck.map((d) => d.id);
    const { data: sentRows, error: sentError } = await supabase
      .from("sent_emails")
      .select("draft_id")
      .in("draft_id", ids);
    // Fail loudly. A failed lookup used to read as "no sent_emails rows",
    // classifying EVERY stuck draft as never-sent and resetting it to
    // "draft": the next cron then re-sent emails that had already been
    // delivered to real prospects.
    if (sentError) throw new Error(`sent_emails lookup: ${sentError.message}`);
    const sentIds = new Set((sentRows ?? []).map((r) => r.draft_id));

    const wasSent = stuck.filter((d) => sentIds.has(d.id));
    const neverSent = stuck.filter((d) => !sentIds.has(d.id));
    const now = new Date().toISOString();

    if (wasSent.length > 0) {
      await supabase
        .from("email_drafts")
        .update({ status: "sent", updated_at: now })
        .in(
          "id",
          wasSent.map((d) => d.id),
        )
        .eq("status", "queued");
      recoveredSent = wasSent.length;

      // Finishing the bookkeeping means finishing ALL of it. Marking the
      // draft sent while leaving the enrollment pinned to that step made
      // every 15-minute followups run fail "No approved draft ready for
      // this step" forever, and the contact's status never left "queued".
      for (const d of wasSent) {
        // Only advance an enrollment still waiting on THIS draft's step:
        // if it moved on already, the send's own bookkeeping won the race.
        const stepCheck = await draftIsCurrentStep(supabase, d);
        if (stepCheck.current) {
          await advanceEnrollmentForDraft(
            supabase,
            d.enrollment_id as string | null,
          );
        }
        if (d.campaign_people_id) {
          await supabase
            .from("campaign_people")
            .update({ outreach_status: "sent" })
            .eq("id", d.campaign_people_id)
            // Same monotonic rule as the sender: a reply or bounce recorded
            // since the crash must survive this late bookkeeping.
            .not(
              "outreach_status",
              "in",
              '("replied","bounced","complained","unsubscribed")',
            );
        }
      }
    }
    if (neverSent.length > 0) {
      await supabase
        .from("email_drafts")
        .update({ status: "draft", updated_at: now })
        .in(
          "id",
          neverSent.map((d) => d.id),
        )
        .eq("status", "queued");
      recoveredDraft = neverSent.length;
    }
  }

  // Delete old discarded drafts
  const { count: discardedCount } = await supabase
    .from("email_drafts")
    .delete({ count: "exact" })
    .eq("status", "discarded")
    .lt("created_at", sevenDaysAgo);

  // Delete stale unsent drafts.
  //
  // Drafts for every step of a sequence are created up front, so a step-3
  // draft on a 21-day delay is routinely older than this window while still
  // being the thing the enrollment is waiting to send. Deleting it left the
  // enrollment active with next_send_at in the past, retrying every 15
  // minutes forever and occupying a slot in the due-enrollment batch. Only
  // drafts that nothing is waiting on are stale.
  const { count: staleCount } = await supabase
    .from("email_drafts")
    .delete({ count: "exact" })
    .eq("status", "draft")
    .is("enrollment_id", null)
    // review_status is nullable, and `neq` would silently skip NULL rows.
    .or("review_status.is.null,review_status.neq.approved")
    .lt("created_at", thirtyDaysAgo);

  return {
    cleaned: {
      discarded: discardedCount ?? 0,
      stale: staleCount ?? 0,
    },
    recovered: {
      markedSent: recoveredSent,
      returnedToDraft: recoveredDraft,
    },
  };
}
