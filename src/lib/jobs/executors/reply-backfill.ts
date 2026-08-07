import { getAdminClient } from "@/lib/supabase/admin";
import { decryptSecret } from "@/lib/crypto";
import {
  classifyInboundMessage,
  fetchInboundSince,
  fetchMessageText,
  type InboundSummary,
} from "@/lib/services/gmail-service";
import {
  recordInboundReply,
  replyDedupeKey,
  type TrackedEmail,
} from "@/lib/services/email-tracking";
import { stripQuotedReply } from "@/lib/services/email-test";
import { enqueueJob } from "@/lib/services/jobs";

/**
 * One-shot backfill of reply content for replies that were matched before
 * capture existed.
 *
 * Before 20260803000000 the tracker matched an inbound message, wrote
 * "replied" onto sent_emails.status and threw the message away. Those rows now
 * show a reply with no words, which is honest but unhelpful, so this walks
 * back over them once and fills in what it can still find.
 *
 * WHAT IT CANNOT RECOVER, and this matters more than what it can:
 *
 *   - The historical tracker only ever considered sends inside a 14-day
 *     window, 100 rows per run. A reply to an older send, or one that lost the
 *     limit-100 race, was never matched at all: its status is still 'sent', so
 *     it is not in the candidate set here either and never will be.
 *   - fetchInboundSince searches INBOX only. Anything the user has since
 *     archived, deleted or filtered out is gone as far as this is concerned.
 *
 * So a materially incomplete result is the expected outcome, not a bug. The
 * body_text IS NULL state in the UI is permanent for a real share of rows.
 *
 * Runs as a one-shot job that re-enqueues itself while work remains. One-shot
 * rows are NOT covered by idx_jobs_one_recurring_per_type, so nothing in the
 * database stops a runaway loop: MAX_PASSES is the only backstop and has to
 * stay.
 */

/** Users processed per pass. Each costs one IMAP envelope scan. */
const USERS_PER_PASS = 10;
/** Bodies downloaded per pass, across all users. One connection each. */
const MAX_BODY_FETCHES = 50;
/** Sends considered. Older than this and the historical tracker never saw it. */
const LOOKBACK_DAYS = 30;
/** The only thing preventing an unbounded re-enqueue loop. */
const MAX_PASSES = 20;

interface BackfillResult {
  pass: number;
  users: number;
  filled: number;
  remaining: number;
  requeued: boolean;
}

export async function backfillReplyBodies(
  payload: Record<string, unknown> = {},
): Promise<BackfillResult> {
  const pass = typeof payload.pass === "number" ? payload.pass : 1;
  const supabase = getAdminClient();

  const windowStart = new Date(
    Date.now() - LOOKBACK_DAYS * 86400_000,
  ).toISOString();

  // Candidates: a send that reached a terminal state, whose reply we either
  // never stored or stored without a body.
  const { data: emails, error: scanError } = await supabase
    .from("sent_emails")
    .select(
      "id, message_id, campaign_people_id, user_id, status, sent_at, person_id, to_email, campaign_id, " +
        "email_replies(id, body_text)",
    )
    .in("status", ["replied", "bounced"])
    .gte("sent_at", windowStart)
    .order("sent_at", { ascending: false })
    .limit(500);

  // A failed scan must fail the run (execute.ts -> failJob), not read as
  // "no bodies missing" and report clean.
  if (scanError) throw new Error(`sent_emails load: ${scanError.message}`);

  // Typed by hand: PostgREST's inference gives up on the embed and widens the
  // whole result to an error type.
  type CandidateRow = TrackedEmail & {
    email_replies: Array<{ id: string; body_text: string | null }> | null;
  };

  const needsBody = ((emails ?? []) as unknown as CandidateRow[]).filter(
    (e) => {
      const replies = e.email_replies ?? [];
      // Nothing stored at all, or stored without words. Either is a candidate;
      // a row that already has a body is done and must not be re-downloaded.
      return replies.length === 0 || replies.every((r) => !r.body_text);
    },
  ) as TrackedEmail[];

  if (needsBody.length === 0) {
    return { pass, users: 0, filled: 0, remaining: 0, requeued: false };
  }

  const byUser = new Map<string, TrackedEmail[]>();
  for (const e of needsBody) {
    const list = byUser.get(e.user_id) ?? [];
    list.push(e);
    byUser.set(e.user_id, list);
  }

  const userIds = [...byUser.keys()].slice(0, USERS_PER_PASS);
  const { data: settingsRows, error: settingsError } = await supabase
    .from("user_settings")
    .select("user_id, gmail_address, gmail_app_password_enc")
    .in("user_id", userIds);
  if (settingsError)
    throw new Error(`user_settings load: ${settingsError.message}`);

  const credsByUser = new Map<
    string,
    { address: string; appPassword: string }
  >();
  for (const row of settingsRows ?? []) {
    if (row.gmail_address && row.gmail_app_password_enc) {
      try {
        credsByUser.set(row.user_id, {
          address: row.gmail_address,
          appPassword: decryptSecret(row.gmail_app_password_enc),
        });
      } catch {
        // Rotated EMAIL_CREDENTIALS_KEY. Nothing to do until they reconnect.
      }
    }
  }

  let filled = 0;
  let bodyFetches = 0;

  for (const userId of userIds) {
    const creds = credsByUser.get(userId);
    const userEmails = byUser.get(userId) ?? [];
    if (!creds || userEmails.length === 0) continue;

    const pending = new Map<string, string>();
    for (const e of userEmails) {
      if (e.message_id?.startsWith("<")) pending.set(e.message_id, e.id);
    }
    if (pending.size === 0) continue;

    const oldest = userEmails.reduce(
      (min, e) => (e.sent_at < min ? e.sent_at : min),
      userEmails[0].sent_at,
    );

    // Replays the tracker: UIDs were never persisted and there is no thread
    // id, so the only way back to a message is to re-scan and re-match it.
    let inbound: InboundSummary[];
    try {
      inbound = await fetchInboundSince(creds, new Date(oldest));
    } catch {
      continue;
    }

    // Same two-phase shape as email-track, and for the same reason: a download
    // must never be interleaved with the fetch generator.
    const hits: Array<{
      email: TrackedEmail;
      status: "replied" | "bounced";
      message: InboundSummary;
    }> = [];
    for (const message of inbound) {
      const hit = classifyInboundMessage(message, pending, creds.address);
      if (!hit) continue;
      const email = userEmails.find((e) => e.id === hit.sentEmailId);
      if (email) hits.push({ email, status: hit.status, message });
    }

    for (const { email, status, message } of hits) {
      if (bodyFetches >= MAX_BODY_FETCHES) break;

      let bodyText: string | null = null;
      if (status === "bounced") {
        bodyText = message.bodyText || null;
      } else if (message.uid !== null) {
        bodyFetches++;
        try {
          const raw = await fetchMessageText(creds, message.uid);
          bodyText = raw ? stripQuotedReply(raw) : null;
        } catch {
          // Leave it null; the row stays a candidate for a later pass.
        }
      }
      if (!bodyText) continue;

      // The row may already exist without a body, so update rather than
      // relying on the insert path's conflict-ignore, which would no-op.
      const dedupeKey = replyDedupeKey(message);
      const { data: existing } = await supabase
        .from("email_replies")
        .select("id")
        .eq("sent_email_id", email.id)
        .eq("dedupe_key", dedupeKey)
        .maybeSingle();

      if (existing) {
        const { error } = await supabase
          .from("email_replies")
          .update({ body_text: bodyText, imap_uid: message.uid })
          .eq("id", existing.id);
        if (!error) filled++;
      } else if (
        await recordInboundReply(supabase, {
          email,
          message,
          kind: status === "bounced" ? "bounce" : "reply",
          bodyText,
        })
      ) {
        filled++;
      }
    }
  }

  const remaining = Math.max(needsBody.length - filled, 0);
  // Re-enqueue while there is work AND we are under the pass cap. The delay
  // keeps a stuck mailbox from spinning the queue.
  const requeued = remaining > 0 && pass < MAX_PASSES;
  if (requeued) {
    await enqueueJob({
      type: "email.backfill-replies",
      payload: { pass: pass + 1 },
      runAt: new Date(Date.now() + 120_000),
      // No retries. A failed pass just means the next one picks the same
      // candidates back up, and retrying would double-scan a mailbox.
      maxAttempts: 1,
    });
  }

  return { pass, users: userIds.length, filled, remaining, requeued };
}
