import type { InboundSummary } from "@/lib/services/gmail-service";
import { classifyInboundMessage } from "@/lib/services/gmail-service";

/**
 * Diagnostic "send a test email" flow for Settings > Email. Pure helpers only
 * — the route owns IO so these stay unit-testable.
 */

/** One test a minute. Bounds a stuck retry loop to 60/hour, far under
 *  Gmail's ~500/day, without making the button feel sticky in normal use. */
export const TEST_COOLDOWN_MS = 60_000;

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export type Validation =
  | { ok: true; to: string }
  | { ok: false; error: string };

/**
 * A test sent to the connected address can never resolve: classifyInboundMessage
 * drops inbound mail from our own address so a reply from the same mailbox is
 * filtered out by design. Reject it here with an explanation rather than let
 * the user watch a spinner that will never settle.
 */
export function validateTestRecipient(
  raw: string,
  connectedAddress: string,
): Validation {
  const to = raw.trim().toLowerCase();
  if (!EMAIL_RE.test(to)) {
    return { ok: false, error: "Enter a valid email address." };
  }
  if (to === connectedAddress.trim().toLowerCase()) {
    return {
      ok: false,
      error:
        "Send the test to a different mailbox you own. Signal ignores replies from your own connected address, so a test to yourself can never show a reply.",
    };
  }
  return { ok: true, to };
}

export type Cooldown = { ok: true } | { ok: false; retryAfterSeconds: number };

export function checkTestCooldown(
  lastSentAt: string | null,
  now: Date = new Date(),
): Cooldown {
  if (!lastSentAt) return { ok: true };
  const elapsed = now.getTime() - new Date(lastSentAt).getTime();
  if (elapsed >= TEST_COOLDOWN_MS) return { ok: true };
  return {
    ok: false,
    retryAfterSeconds: Math.ceil((TEST_COOLDOWN_MS - elapsed) / 1000),
  };
}

export interface TestReply {
  status: "replied" | "bounced";
  fromAddress: string;
  subject: string;
  date: Date | null;
  uid: number | null;
}

/** Longest reply excerpt the Settings test card stores and renders. */
export const REPLY_SNIPPET_MAX = 400;

/**
 * Reduces a raw text/plain reply body to just what the person actually typed,
 * at full length.
 *
 * Mail clients append the entire quoted original below an attribution line, so
 * a two-word reply arrives as several hundred characters of our own copy. We
 * drop everything from the attribution onwards, plus any quoted ">" lines,
 * which is what makes the result readable proof that the reply is genuinely
 * theirs rather than an echo of what we sent.
 *
 * Split out of extractReplyText so reply capture can store a whole reply while
 * the Settings test card keeps its 400-character excerpt. Truncation is the
 * caller's decision, not this function's.
 */
export function stripQuotedReply(raw: string): string {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const kept: string[] = [];

  for (const line of lines) {
    // "On Thu, 30 Jul 2026 at 22:48, <jay@sahnan.co> wrote:" and the many
    // client-specific variants of it. Everything after is quoted history.
    if (/^\s*(on\b.*\bwrote:\s*$|-+\s*original message\s*-+)/i.test(line))
      break;
    if (/^\s*>/.test(line)) continue;
    kept.push(line);
  }

  return kept
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * The Settings test card's excerpt: stripped, then capped.
 *
 * Behaviour is unchanged from before the split, which its existing tests
 * assert. Reply capture deliberately does not use this.
 */
export function extractReplyText(raw: string): string {
  const text = stripQuotedReply(raw);
  return text.length > REPLY_SNIPPET_MAX
    ? text.slice(0, REPLY_SNIPPET_MAX).trimEnd() + "…"
    : text;
}

/**
 * Feeds the test's Message-ID to the shared classifier as a one-entry pending
 * map. Bounce detection comes along for free — a test aimed at a dead address
 * reports "bounced" rather than hanging as unanswered.
 */
export function matchTestReply(
  inbound: InboundSummary[],
  testMessageId: string,
  ourAddress: string,
): TestReply | null {
  const pending = new Map([[testMessageId, "test"]]);
  for (const message of inbound) {
    const hit = classifyInboundMessage(message, pending, ourAddress);
    if (!hit) continue;
    return {
      status: hit.status,
      fromAddress: message.fromAddress,
      subject: message.subject,
      date: message.date,
      uid: message.uid,
    };
  }
  return null;
}
