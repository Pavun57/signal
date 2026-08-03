import { getAdminClient } from "@/lib/supabase/admin";
import { decryptSecret } from "@/lib/crypto";
import {
  classifyInboundMessage,
  fetchInboundSince,
  fetchMessageText,
  type InboundSummary,
} from "@/lib/services/gmail-service";
import {
  applyInboundStatus,
  recordInboundReply,
  replyDedupeKey,
  type TrackedEmail,
} from "@/lib/services/email-tracking";
import { stripQuotedReply } from "@/lib/services/email-test";

/**
 * Reply bodies downloaded per run, across all users.
 *
 * Each one is its own short-lived IMAP connection (fetchMessageText opens its
 * own client on purpose). Gmail allows roughly 15 simultaneous connections per
 * account, and the job runs inside a 300s budget, so this bounds a first run
 * against a busy mailbox without starving the status updates that matter more.
 * Anything skipped is picked up by the next poll ten minutes later.
 */
const MAX_BODY_FETCHES_PER_RUN = 25;

/**
 * Reply/bounce tracking (recurring job, every 10 min). Polls each user's
 * Gmail INBOX over IMAP and matches inbound In-Reply-To/References headers
 * against the RFC Message-IDs of pending sends.
 *
 * Gmail rows only ever move sent → replied | bounced: there is no
 * delivered/opened/clicked signal because Signal deliberately sends no
 * tracking pixel (pixels hurt cold-email deliverability and the data is
 * mostly fiction post-Apple-MPP).
 *
 * Naturally idempotent: re-running re-matches already-applied statuses,
 * which applyInboundStatus's monotonic status ladder ignores.
 */
export async function trackEmailReplies(): Promise<{
  checked: number;
  updated: number;
  captured: number;
}> {
  const supabase = getAdminClient();

  // Load recent sent emails that haven't reached a terminal state. Clamped
  // to 14 days: unanswered sends and migrated legacy rows must not drag the
  // IMAP fetch window (each user's real inbox!) weeks into the past.
  const windowStart = new Date(Date.now() - 14 * 86400_000).toISOString();
  const { data: emails, error } = await supabase
    .from("sent_emails")
    .select(
      "id, message_id, campaign_people_id, user_id, status, sent_at, person_id, to_email, campaign_id",
    )
    .in("status", ["sent", "delivered", "opened"])
    .gte("sent_at", windowStart)
    .order("sent_at", { ascending: false })
    .limit(100);

  if (error || !emails || emails.length === 0) {
    return { checked: 0, updated: 0, captured: 0 };
  }

  // Load gmail credentials for the affected users
  const userIds = [...new Set(emails.map((e) => e.user_id))];
  const { data: settingsRows } = await supabase
    .from("user_settings")
    .select("user_id, gmail_address, gmail_app_password_enc")
    .in("user_id", userIds);

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
        // Undecryptable credential (rotated EMAIL_CREDENTIALS_KEY) — skip;
        // the user has to reconnect in Settings > Email.
      }
    }
  }

  const emailsByUser = new Map<string, TrackedEmail[]>();
  for (const email of emails as TrackedEmail[]) {
    const list = emailsByUser.get(email.user_id) ?? [];
    list.push(email);
    emailsByUser.set(email.user_id, list);
  }

  let updated = 0;
  let captured = 0;
  let bodyFetches = 0;

  // Replies already captured, so a re-poll never re-downloads a body it has.
  // Loaded once for every candidate send rather than per user: without it,
  // every 10-minute run opens a fresh IMAP connection for every reply inside
  // the 14-day window, which is the single most expensive mistake available
  // in this file.
  const capturedKeys = new Set<string>();
  {
    const { data: existing } = await supabase
      .from("email_replies")
      .select("sent_email_id, dedupe_key, body_text")
      .in(
        "sent_email_id",
        emails.map((e) => e.id),
      );
    for (const row of existing ?? []) {
      // A row whose body was never captured is deliberately NOT counted as
      // done: leaving it out lets a later poll retry the download that failed.
      if (row.body_text)
        capturedKeys.add(`${row.sent_email_id}|${row.dedupe_key}`);
    }
  }

  for (const [userId, userEmails] of emailsByUser) {
    const creds = credsByUser.get(userId);
    if (!creds) continue;

    const pending = new Map<string, string>();
    for (const e of userEmails) {
      // Only RFC 5322 Message-IDs ("<...>") can ever match a reply header;
      // legacy provider ids would just waste window and lookups.
      if (e.message_id?.startsWith("<")) pending.set(e.message_id, e.id);
    }
    if (pending.size === 0) continue;

    const oldest = userEmails.reduce(
      (min, e) => (e.sent_at < min ? e.sent_at : min),
      userEmails[0].sent_at,
    );

    let inbound: InboundSummary[];
    try {
      inbound = await fetchInboundSince(creds, new Date(oldest));
    } catch {
      // One user's IMAP failure must not break the whole run.
      continue;
    }

    // Phase 1: classify. Deliberately separate from the body downloads below.
    // fetchInboundSince returns a fully-drained array today, but interleaving a
    // download with the fetch generator deadlocks imapflow, and keeping the two
    // phases textually apart is what stops a future refactor reintroducing it.
    // See the regression test in gmail-imap.test.ts.
    const hits: Array<{
      email: TrackedEmail;
      status: "replied" | "bounced";
      message: InboundSummary;
    }> = [];
    for (const message of inbound) {
      const hit = classifyInboundMessage(message, pending, creds.address);
      if (!hit) continue;
      const email = userEmails.find((e) => e.id === hit.sentEmailId);
      if (!email) continue;
      hits.push({ email, status: hit.status, message });
    }

    // Phase 2: apply status, then capture content. Each step is guarded on its
    // own so a failure to store a reply body can never cost the status update,
    // which is the more important of the two.
    for (const { email, status, message } of hits) {
      try {
        if (await applyInboundStatus(supabase, email, status)) updated++;
      } catch (err) {
        console.error("[email-track] applyInboundStatus failed:", err);
      }

      const key = `${email.id}|${replyDedupeKey(message)}`;
      if (capturedKeys.has(key)) continue;

      let bodyText: string | null = null;
      if (status === "bounced") {
        // Already downloaded by fetchInboundSince to match the quoted
        // Message-ID, so bounce capture costs nothing extra.
        bodyText = message.bodyText || null;
      } else if (
        message.uid !== null &&
        bodyFetches < MAX_BODY_FETCHES_PER_RUN
      ) {
        bodyFetches++;
        try {
          const raw = await fetchMessageText(creds, message.uid);
          bodyText = raw ? stripQuotedReply(raw) : null;
        } catch (err) {
          // A missing body is cosmetic. The row is still worth storing, and
          // leaving body_text null lets a later poll retry the download.
          console.error("[email-track] fetchMessageText failed:", err);
        }
      }

      if (
        await recordInboundReply(supabase, {
          email,
          message,
          kind: status === "bounced" ? "bounce" : "reply",
          bodyText,
        })
      ) {
        captured++;
        if (bodyText) capturedKeys.add(key);
      }
    }
  }

  return { checked: emails.length, updated, captured };
}
