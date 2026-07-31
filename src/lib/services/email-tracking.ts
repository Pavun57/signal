import type { SupabaseClient } from "@supabase/supabase-js";

import { getPostHogClient } from "@/lib/posthog-server";
import { recordBounce } from "@/lib/services/email-pattern";

/**
 * Applying an inbound classification (replied / bounced) to a sent email.
 *
 * Lifted out of the tracking route so it can be tested without standing up
 * QStash signatures and an IMAP connection — the route keeps the IO, this owns
 * the decision, matching the split email-test.ts established.
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

  await supabase
    .from("sent_emails")
    .update({ status: newStatus })
    .eq("id", email.id);

  await supabase
    .from("campaign_people")
    .update({ outreach_status: newStatus })
    .eq("id", email.campaign_people_id);

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
