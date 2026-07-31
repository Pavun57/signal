import { NextResponse } from "next/server";
import { getAdminClient } from "@/lib/supabase/admin";
import { decryptSecret } from "@/lib/crypto";
import {
  classifyInboundMessage,
  fetchInboundSince,
} from "@/lib/services/gmail-service";
import { verifyQStashSignature } from "@/lib/services/qstash";
import {
  applyInboundStatus,
  type TrackedEmail,
} from "@/lib/services/email-tracking";

// One IMAP connect + TLS handshake + fetch per user per run — slower than
// REST polling, so give the route real headroom.
export const maxDuration = 120;

/**
 * Reply/bounce tracking. Call via a QStash schedule (the route is public, so
 * the signature check is the only auth). Polls each user's Gmail INBOX over
 * IMAP and matches inbound In-Reply-To/References headers against the RFC
 * Message-IDs of pending sends.
 *
 * Gmail rows only ever move sent → replied | bounced: there is no
 * delivered/opened/clicked signal because Signal deliberately sends no
 * tracking pixel (pixels hurt cold-email deliverability and the data is
 * mostly fiction post-Apple-MPP).
 *
 * The status application itself lives in services/email-tracking so it can be
 * tested without a QStash signature and a live mailbox.
 */

export async function POST(request: Request) {
  try {
    await verifyQStashSignature(request);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Invalid signature";
    return NextResponse.json({ error: msg }, { status: 401 });
  }

  const supabase = getAdminClient();

  // Load recent sent emails that haven't reached a terminal state. Clamped
  // to 14 days: unanswered sends and migrated legacy rows must not drag the
  // IMAP fetch window (each user's real inbox!) weeks into the past.
  const windowStart = new Date(Date.now() - 14 * 86400_000).toISOString();
  const { data: emails, error } = await supabase
    .from("sent_emails")
    .select(
      "id, message_id, campaign_people_id, user_id, status, sent_at, person_id, to_email",
    )
    .in("status", ["sent", "delivered", "opened"])
    .gte("sent_at", windowStart)
    .order("sent_at", { ascending: false })
    .limit(100);

  if (error || !emails || emails.length === 0) {
    return NextResponse.json({ checked: 0, updated: 0 });
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

    try {
      const inbound = await fetchInboundSince(creds, new Date(oldest));
      for (const message of inbound) {
        const hit = classifyInboundMessage(message, pending, creds.address);
        if (!hit) continue;
        const email = userEmails.find((e) => e.id === hit.sentEmailId);
        if (!email) continue;
        if (await applyInboundStatus(supabase, email, hit.status)) updated++;
      }
    } catch {
      // One user's IMAP failure must not break the whole run
    }
  }

  return NextResponse.json({ checked: emails.length, updated });
}
