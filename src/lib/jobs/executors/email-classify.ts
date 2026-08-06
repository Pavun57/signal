import { getAdminClient } from "@/lib/supabase/admin";
import {
  classifyReplyIntent,
  shouldSuppress,
  suppressionReason,
} from "@/lib/services/reply-intent";

/**
 * Rows classified per run. Each is one haiku call; at the 15-minute cadence
 * this drains a fully unclassified history (the backfill case) within a few
 * hours without ever risking the 300s job budget.
 */
const MAX_PER_RUN = 20;

/**
 * Reply intent classification (recurring job, every 15 min).
 *
 * Scans email_replies rows that have a captured body but no intent yet and
 * stamps each with a classifier verdict. The scan predicate IS the backfill:
 * pre-existing rows simply drain over the first few runs. Rows whose body
 * was never captured are left for email.track's body retry to fill first.
 *
 * Suppress-worthy verdicts (unsubscribe, confident not_interested) also
 * upsert outreach_suppressions for the address the original email was sent
 * to; claimAndSendDraft refuses future sends to it.
 */
export async function classifyReplies(): Promise<{
  scanned: number;
  classified: number;
  suppressed: number;
}> {
  const supabase = getAdminClient();

  const { data: rows, error } = await supabase
    .from("email_replies")
    .select(
      "id, user_id, person_id, subject, body_text, sent_email_id, sent_emails(subject, to_email)",
    )
    .eq("kind", "reply")
    .is("intent", null)
    .not("body_text", "is", null)
    .order("received_at", { ascending: true })
    .limit(MAX_PER_RUN);

  if (error || !rows || rows.length === 0) {
    if (error) console.error("[email-classify] scan failed:", error);
    return { scanned: 0, classified: 0, suppressed: 0 };
  }

  let classified = 0;
  let suppressed = 0;

  for (const row of rows) {
    const sent = Array.isArray(row.sent_emails)
      ? row.sent_emails[0]
      : row.sent_emails;

    const verdict = await classifyReplyIntent({
      subject: row.subject ?? "",
      bodyText: row.body_text as string,
      sentSubject: sent?.subject ?? null,
    });
    // Left unclassified on purpose: the row stays in the scan window and a
    // later run retries, matching how email.track treats a failed body fetch.
    if (!verdict) continue;

    const { error: updateError } = await supabase
      .from("email_replies")
      .update({
        intent: verdict.intent,
        intent_confidence: verdict.confidence,
        classified_at: new Date().toISOString(),
      })
      .eq("id", row.id)
      .eq("user_id", row.user_id);
    if (updateError) {
      console.error("[email-classify] intent update failed:", updateError);
      continue;
    }
    classified++;

    if (!shouldSuppress(verdict.intent, verdict.confidence)) continue;

    // Suppress the address we SENT to, not the reply's From: a colleague
    // answering "please stop emailing Sam" must block sam@, and a referral
    // target must never be suppressed for being mentioned.
    const address = sent?.to_email?.toLowerCase();
    if (!address) continue;

    const { error: suppressError } = await supabase
      .from("outreach_suppressions")
      .upsert(
        {
          user_id: row.user_id,
          person_id: row.person_id,
          email: address,
          reason: suppressionReason(verdict.intent) ?? "not_interested",
          source: "classifier",
          // Sliced to the column's check constraint: a rambling classifier
          // must never fail the insert and silently drop an unsubscribe.
          detail: verdict.reasoning.slice(0, 1000),
        },
        {
          onConflict: "user_id,email",
          // An unsubscribe upgrades an existing softer row (not_interested,
          // user) so the strongest opt-out evidence is what's on record;
          // anything weaker never overwrites what's already there.
          ignoreDuplicates: verdict.intent !== "unsubscribe",
        },
      );
    if (suppressError) {
      console.error(
        "[email-classify] suppression upsert failed:",
        suppressError,
      );
      continue;
    }
    suppressed++;
  }

  return { scanned: rows.length, classified, suppressed };
}
