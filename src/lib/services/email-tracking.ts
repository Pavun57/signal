import type { SupabaseClient } from "@supabase/supabase-js";

import { getPostHogClient } from "@/lib/posthog-server";
import { recordBounce } from "@/lib/services/email-pattern";

/**
 * Applying an inbound classification (replied / bounced) to a sent email.
 *
 * Lifted out of the tracking executor so it can be tested without standing up
 * an IMAP connection: the executor keeps the IO, this owns the decision,
 * matching the split email-test.ts established.
 */

/** The columns the status application needs from a sent_emails row. */
export interface TrackedEmail {
  id: string;
  message_id: string | null;
  campaign_people_id: string;
  user_id: string;
  status: string;
  sent_at: string;
  /** Both needed to attribute a bounce back to a contact and address. */
  person_id: string | null;
  to_email: string | null;
  /**
   * Needed by recordInboundReply: email_replies.campaign_id is NOT NULL
   * because its select policy is transitive through campaigns, so a row
   * without one would be invisible to its own owner.
   */
  campaign_id: string;
}

export const STATUS_EVENT: Record<string, string> = {
  replied: "email_replied",
  bounced: "email_bounced",
};

/**
 * Ordering so a late-arriving weaker signal can't walk a status backwards
 * (an open pixel firing after a reply, say).
 */
export const STATUS_PRIORITY: Record<string, number> = {
  not_contacted: 0,
  queued: 1,
  sent: 2,
  delivered: 3,
  opened: 4,
  clicked: 5,
  replied: 6,
  bounced: 6,
  complained: 6,
};

/**
 * Moves a sent email to `newStatus`, if that is forward progress.
 *
 * Returns true when something changed, so the caller can count updates.
 */
export async function applyInboundStatus(
  supabase: SupabaseClient,
  email: TrackedEmail,
  newStatus: string,
): Promise<boolean> {
  const currentPriority = STATUS_PRIORITY[email.status] ?? 0;
  const newPriority = STATUS_PRIORITY[newStatus] ?? 0;
  if (newPriority <= currentPriority) return false;

  // campaign_people first, sent_emails last. The re-poll ladder above
  // compares against sent_emails.status, so that stamp is the dedupe
  // marker: writing it first meant a crash (or a failed campaign_people
  // write) between the two lost the reply forever. The next poll saw
  // replied -> replied and skipped while campaign_people still said
  // "sent" and follow-ups kept going.
  let cpQuery = supabase
    .from("campaign_people")
    .update({ outreach_status: newStatus })
    .eq("id", email.campaign_people_id);
  if (newPriority < 6) {
    // Sub-terminal signals (delivered/opened/clicked) must not walk a
    // terminal campaign_people status backwards when the two tables have
    // diverged (e.g. after a data repair).
    cpQuery = cpQuery.not(
      "outreach_status",
      "in",
      '("replied","bounced","complained","unsubscribed")',
    );
  }
  const { error: cpError } = await cpQuery;
  if (cpError) {
    // Not stamped: the next poll's ladder still sees the old sent_emails
    // status and retries both writes.
    console.error(
      "[email-tracking] campaign_people status write failed:",
      cpError,
    );
    return false;
  }

  await supabase
    .from("sent_emails")
    .update({ status: newStatus })
    .eq("id", email.id);

  // A bounce is the only ground truth we ever get about an address we guessed.
  // Feeding it back clears the contact's verification and, when the address was
  // derived from the org's email pattern, counts against that pattern — so a
  // wrong pattern degrades and eventually clears itself instead of generating
  // bad addresses for every future contact at that company.
  if (newStatus === "bounced" && email.person_id && email.to_email) {
    try {
      await recordBounce(supabase, {
        personId: email.person_id,
        email: email.to_email,
      });
    } catch (err) {
      // Pattern bookkeeping must never cost us the status update itself.
      console.error("[email-tracking] recordBounce failed:", err);
    }
  }

  const eventName = STATUS_EVENT[newStatus];
  if (eventName) {
    getPostHogClient().capture({
      distinctId: email.user_id,
      event: eventName,
      properties: {
        sent_email_id: email.id,
        campaign_people_id: email.campaign_people_id,
        previous_status: email.status,
      },
    });
  }

  return true;
}

/** The fields of an inbound message that identify it, for deduping. */
export interface InboundIdentity {
  messageId: string | null;
  uid: number | null;
  fromAddress: string;
  date: Date | null;
  subject: string;
}

/**
 * A stable identity for one inbound message, scoped to the send it answers.
 *
 * The tracker re-polls the same 14-day window every 10 minutes, so the same
 * reply is re-matched dozens of times and something has to make the insert
 * idempotent. The status ladder cannot: it is about status, and a *second*
 * genuine reply in a thread fails it (replied -> replied) while still needing
 * to be stored.
 *
 * Preference order matters:
 *   1. The sender's own Message-ID. Globally unique by spec and stable across
 *      mailbox rebuilds.
 *   2. The IMAP UID. Unique only within a UIDVALIDITY generation, so a rebuilt
 *      mailbox can renumber it and re-admit a duplicate. Acceptable fallback,
 *      never a first choice.
 *   3. Sender, timestamp and subject. Last resort for a sender that omits the
 *      header and a fetch that lost the UID. Two distinct replies sent in the
 *      same second with the same subject would collide, which is a far better
 *      failure than storing the same reply forever.
 */
export function replyDedupeKey(m: InboundIdentity): string {
  if (m.messageId) return m.messageId;
  if (m.uid !== null) return `uid:${m.uid}`;
  return `${m.fromAddress.toLowerCase()}|${m.date?.getTime() ?? 0}|${m.subject}`;
}

/**
 * Stores the content of one inbound reply or bounce.
 *
 * Three rules, all deliberate:
 *
 * - Called INDEPENDENTLY of applyInboundStatus's return value. Gating on it
 *   would mean the second reply in a thread is never stored, and a transient
 *   body-fetch failure could never be retried on a later poll.
 * - Never throws upward. Losing a reply body must not cost the status update,
 *   matching the recordBounce precedent above.
 * - Writes body_text: null rather than "" when nothing was captured, so
 *   "we never got the words" stays distinguishable from "they sent an empty
 *   reply". The UI and the backfill both depend on that distinction.
 *
 * Returns true when a row was actually inserted.
 */
export async function recordInboundReply(
  supabase: SupabaseClient,
  params: {
    email: TrackedEmail;
    message: InboundIdentity;
    kind: "reply" | "bounce";
    bodyText: string | null;
  },
): Promise<boolean> {
  const { email, message, kind, bodyText } = params;
  try {
    const { data, error } = await supabase
      .from("email_replies")
      .upsert(
        {
          sent_email_id: email.id,
          user_id: email.user_id,
          campaign_id: email.campaign_id,
          person_id: email.person_id,
          kind,
          from_email: message.fromAddress,
          subject: message.subject ?? "",
          message_id: message.messageId,
          imap_uid: message.uid,
          body_text: bodyText && bodyText.length > 0 ? bodyText : null,
          received_at: (message.date ?? new Date()).toISOString(),
          dedupe_key: replyDedupeKey(message),
        },
        { onConflict: "sent_email_id,dedupe_key", ignoreDuplicates: true },
      )
      .select("id");

    if (error) {
      console.error("[email-tracking] recordInboundReply failed:", error);
      return false;
    }
    // ignoreDuplicates returns zero rows when the conflict target already
    // existed, which is the steady state on every poll after the first.
    return (data?.length ?? 0) > 0;
  } catch (err) {
    console.error("[email-tracking] recordInboundReply threw:", err);
    return false;
  }
}
