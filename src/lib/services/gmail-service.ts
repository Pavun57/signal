import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";

/**
 * Gmail app-password transport: SMTP for sending, IMAP for reading replies
 * and bounces. No OAuth app, no Google Cloud project — the user generates an
 * app password (requires 2-Step Verification) and Signal authenticates like
 * any email client. Works identically for personal Gmail and Workspace.
 */

export interface GmailCreds {
  address: string;
  appPassword: string;
}

function smtpTransport(creds: GmailCreds) {
  return nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: { user: creds.address, pass: creds.appPassword },
    // Fail fast instead of riding nodemailer's 2-minute defaults into the
    // route's maxDuration.
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 30_000,
  });
}

function imapClient(creds: GmailCreds) {
  return new ImapFlow({
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    auth: { user: creds.address, pass: creds.appPassword },
    logger: false,
    connectionTimeout: 10_000,
    socketTimeout: 60_000,
  });
}

/**
 * Live credential check used before saving settings: SMTP AUTH + IMAP login.
 * Returns an error string instead of throwing so the settings route can 400
 * with a message that tells the user which half failed.
 */
export async function verifyGmailCredentials(
  creds: GmailCreds,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await smtpTransport(creds).verify();
  } catch {
    return {
      ok: false,
      error:
        "SMTP login failed. Check the address and app password (app passwords require 2-Step Verification on your Google account).",
    };
  }
  try {
    const imap = imapClient(creds);
    await imap.connect();
    await imap.logout();
  } catch {
    return {
      ok: false,
      error:
        "IMAP login failed. Enable IMAP in Gmail (Settings > Forwarding and POP/IMAP).",
    };
  }
  return { ok: true };
}

export async function sendGmailMessage(
  creds: GmailCreds,
  params: {
    fromName?: string | null;
    to: string;
    subject: string;
    html: string;
    text?: string;
    replyTo?: string;
    /** RFC Message-ID being replied to — threads follow-ups client-side. */
    inReplyTo?: string;
  },
): Promise<{ messageId: string }> {
  const info = await smtpTransport(creds).sendMail({
    from: params.fromName
      ? { name: params.fromName, address: creds.address }
      : creds.address,
    to: params.to,
    subject: params.subject,
    html: params.html,
    text: params.text,
    replyTo: params.replyTo,
    inReplyTo: params.inReplyTo,
    references: params.inReplyTo,
  });
  return { messageId: info.messageId };
}

// ── IMAP reply/bounce polling ───────────────────────────────────────────────

export interface InboundSummary {
  fromAddress: string;
  inReplyTo: string | null;
  references: string[];
  bodyText: string;
  subject: string;
  date: Date | null;
}

/**
 * Fetches inbound mail received since `since` as InboundSummary rows. Only
 * daemon messages get their body downloaded (needed to match bounces to
 * sends); everything else is envelope-only.
 */
export async function fetchInboundSince(
  creds: GmailCreds,
  since: Date,
): Promise<InboundSummary[]> {
  // IMAP SINCE is DATE-granular, and the server evaluates it against each
  // message's internal date in the account's own timezone — not UTC. A UTC
  // timestamp taken late in the local day is therefore a calendar day ahead
  // of the server's view, and the search silently returns zero rows. For a
  // US/Pacific account that is every send between 17:00 and midnight local:
  // sent 05:48Z (22:48 local, 30 Jul), searching SINCE 31-Jul finds nothing
  // even though the reply is sitting in the INBOX correctly threaded.
  //
  // Widen by a day so the date can never land ahead of the server's. Max real
  // UTC offset is 14h, so one day always covers it. Over-fetching envelopes
  // is cheap and costs no correctness: matching is exact on Message-ID.
  const searchSince = new Date(since.getTime() - 86400_000);

  const imap = imapClient(creds);
  await imap.connect();
  const results: InboundSummary[] = [];
  const daemonDownloads: Array<{ uid: number; index: number }> = [];
  try {
    const lock = await imap.getMailboxLock("INBOX");
    try {
      // Collect rows ONLY inside the fetch loop. imapflow forbids issuing
      // other IMAP commands while the fetch generator is live: the FETCH
      // doesn't complete until every row is consumed, and a nested command
      // (like download) queues behind it — mutual wait, guaranteed hang.
      for await (const msg of imap.fetch(
        { since: searchSince },
        { envelope: true, headers: ["references"], uid: true },
      )) {
        const fromAddress = msg.envelope?.from?.[0]?.address ?? "";
        const isDaemon = /mailer-daemon|postmaster/i.test(fromAddress);
        results.push({
          fromAddress,
          inReplyTo: msg.envelope?.inReplyTo?.trim() || null,
          references: msg.headers?.toString().match(/<[^<>\s]+>/g) ?? [],
          bodyText: "",
          subject: msg.envelope?.subject ?? "",
          date: msg.envelope?.date ?? null,
        });
        if (isDaemon && msg.uid) {
          daemonDownloads.push({ uid: msg.uid, index: results.length - 1 });
        }
      }

      // Bounce bodies (needed to match reports that quote the Message-ID
      // instead of threading) are downloaded after the fetch completes.
      for (const { uid, index } of daemonDownloads) {
        const dl = await imap.download(String(uid), undefined, { uid: true });
        // download resolves with an empty object for a missing message.
        if (dl?.content) {
          results[index].bodyText = (await streamToString(dl.content)).slice(
            0,
            20_000,
          );
        }
      }
    } finally {
      lock.release();
    }
  } finally {
    await imap.logout().catch(() => {});
  }
  return results;
}

async function streamToString(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

// ── Pure classification ─────────────────────────────────────────────────────

/**
 * Maps one inbound message to a status for one of our pending sends.
 * `pending` maps RFC Message-ID → sent_emails.id. A daemon message is a
 * bounce; anything else from a third party referencing our id is a reply.
 */
export function classifyInboundMessage(
  message: InboundSummary,
  pending: Map<string, string>,
  ourAddress: string,
): { status: "replied" | "bounced"; sentEmailId: string } | null {
  const from = message.fromAddress.toLowerCase();
  if (!from) return null;
  // Compare the parsed address for equality, not substring — a reply from
  // ajay@sahnan.co must not be dropped as "our own" when we are jay@sahnan.co.
  const fromEmail = from.match(/[^\s<>"']+@[^\s<>"']+/)?.[0] ?? from;
  if (fromEmail === ourAddress.toLowerCase()) return null;

  const isDaemon = /mailer-daemon|postmaster|mail delivery subsystem/.test(
    from,
  );

  const referenced = [message.inReplyTo, ...message.references].filter(
    (id): id is string => !!id,
  );
  let sentEmailId =
    referenced.map((id) => pending.get(id)).find(Boolean) ?? null;

  // Bounce reports often quote the original Message-ID in the body rather
  // than threading properly.
  if (!sentEmailId && isDaemon) {
    for (const [msgId, rowId] of pending) {
      if (message.bodyText.includes(msgId)) {
        sentEmailId = rowId;
        break;
      }
    }
  }
  if (!sentEmailId) return null;

  return { status: isDaemon ? "bounced" : "replied", sentEmailId };
}

// ── Warmup ramp (pure) ──────────────────────────────────────────────────────

/**
 * Warmup-aware daily limit: fresh mailboxes ramp 5 → 10 → 20 → cap over two
 * weeks so a new domain can't be burned on day one. Null connect date
 * (legacy rows) means fully ramped.
 */
export function getEffectiveDailyLimit(
  connectedAt: string | null,
  configuredLimit: number,
): number {
  if (!connectedAt) return configuredLimit;
  const days = (Date.now() - new Date(connectedAt).getTime()) / 86400_000;
  let rampCap: number;
  if (days < 3) rampCap = 5;
  else if (days < 7) rampCap = 10;
  else if (days < 14) rampCap = 20;
  else rampCap = configuredLimit;
  return Math.min(rampCap, configuredLimit);
}
