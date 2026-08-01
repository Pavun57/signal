import type { SupabaseClient } from "@supabase/supabase-js";

import { getEmailProvider } from "@/lib/services/email-provider";
import { recordAffiliation } from "@/lib/services/affiliation";

/**
 * Just-in-time email verification, run by the send gate.
 *
 * Discovery is free and writes suggestions (`unchecked`); money is spent only
 * here, at the moment an email is actually about to leave. Three properties
 * fall out of that placement:
 *
 *  - Credits are spent solely on contacts that reached the send queue — past
 *    the affiliation gate, past draft review — never on bulk enrichment.
 *  - The verdict is cached on the person, so a contact costs at most one
 *    verification ever; step 2 of a sequence re-reads the cache.
 *  - The daily send cap (5–30/day under the warmup ramp) is automatically the
 *    verification budget. Spend cannot outrun sending.
 *
 * Fail-closed, but never destructive: an unreachable or rate-limited verifier
 * refuses the send as "unavailable" and writes nothing, so the draft stays
 * sendable the moment the provider recovers. Only a definitive `undeliverable`
 * marks the address dead.
 */

export type SendVerification =
  | { outcome: "verified" }
  | { outcome: "blocked"; reason: string }
  /** Provider missing, down, or out of quota — retryable, nothing written. */
  | { outcome: "unavailable"; reason: string };

export async function verifyAddressForSend(
  supabase: SupabaseClient,
  args: {
    personId: string;
    email: string;
    organizationId: string | null;
  },
): Promise<SendVerification> {
  const { personId, email, organizationId } = args;

  const provider = getEmailProvider();
  if (!provider?.canVerify) {
    return {
      outcome: "unavailable",
      reason:
        "no email provider is configured to verify this address — set EMAIL_PROVIDER and its key, or enter the address manually to vouch for it",
    };
  }

  // Is the address at the employer's own domain? Needed twice: the org's
  // cached catch-all flag only speaks for its own domain, and a deliverable
  // mailbox there doubles as proof of employment.
  let orgDomain: string | null = null;
  let orgIsCatchAll: boolean | null = null;
  if (organizationId) {
    const { data: org } = await supabase
      .from("organizations")
      .select("domain, is_catch_all")
      .eq("id", organizationId)
      .maybeSingle();
    orgDomain = org?.domain ?? null;
    orgIsCatchAll = org?.is_catch_all ?? null;
  }
  const atOrgDomain =
    !!orgDomain && email.toLowerCase().endsWith(`@${orgDomain.toLowerCase()}`);

  // A cached catch-all verdict for the org's own domain settles it without a
  // billable call: "deliverable" there proves nothing about this mailbox.
  if (atOrgDomain && orgIsCatchAll === true) {
    await supabase
      .from("people")
      .update({ work_email_verification: "risky", work_email_confidence: 0.5 })
      .eq("id", personId);
    return {
      outcome: "blocked",
      reason:
        "the company's mail server accepts every address (catch-all), so this one cannot be confirmed — verify it manually and enter it to vouch for it",
    };
  }

  const result = await provider.verifyEmail(email);

  // An outage or rate limit tells us nothing about the address. Refuse the
  // send, write nothing: the suggestion stays intact and the next attempt
  // re-checks for free once the provider is back.
  if (result.status === "unknown") {
    return {
      outcome: "unavailable",
      reason:
        "the email verifier is unavailable or out of quota — the send will work once it recovers, or enter the address manually",
    };
  }

  // Cache a definitive catch-all answer about the org's own domain so the next
  // contact at this company is settled without a billable call.
  if (atOrgDomain && organizationId && orgIsCatchAll === null) {
    await supabase
      .from("organizations")
      .update({
        is_catch_all: result.catchAll,
        catch_all_checked_at: new Date().toISOString(),
      })
      .eq("id", organizationId);
  }

  if (result.status === "undeliverable") {
    await supabase
      .from("people")
      .update({
        work_email_verification: "undeliverable",
        work_email_confidence: 0,
        work_email_verified_at: null,
      })
      .eq("id", personId);
    return {
      outcome: "blocked",
      reason: `${email} does not exist — find or enter a corrected address`,
    };
  }

  if (result.status === "risky" || result.catchAll) {
    await supabase
      .from("people")
      .update({ work_email_verification: "risky", work_email_confidence: 0.5 })
      .eq("id", personId);
    return {
      outcome: "blocked",
      reason: `${email} could not be confirmed (catch-all or risky mailbox) — verify it manually and enter it to vouch for it`,
    };
  }

  // Deliverable, not catch-all: cache the proof so this contact never bills
  // again, and record the employment evidence a working corporate mailbox is.
  await supabase
    .from("people")
    .update({
      work_email_verification: "deliverable",
      work_email_confidence: 0.95,
      work_email_verified_by: provider.id,
      work_email_verified_at: new Date().toISOString(),
    })
    .eq("id", personId);

  if (atOrgDomain && organizationId) {
    await recordAffiliation(supabase, {
      personId,
      organizationId,
      source: "email_domain",
      evidence: `${email} verified deliverable at ${orgDomain}`,
    });
  }

  return { outcome: "verified" };
}
