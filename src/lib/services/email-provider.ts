/**
 * Vendor-neutral email finding + verification.
 *
 * Signal's own email discovery is free but unproven: it scrapes team pages,
 * regexes addresses out of Exa results, and failing both, guesses
 * {first}.{last}@domain. The only network check is an MX lookup, which proves
 * the *domain* accepts mail and says nothing about whether the mailbox exists.
 * A third-party verifier is what turns those guesses into something safe to
 * send to — and a finder is what fills the gap when the free path finds nothing
 * at all.
 *
 * Kept behind an interface because the vendor is a commodity and self-hosters
 * will each have their own. `getEmailProvider()` returns null when no key is
 * configured, and every caller must treat that as "carry on with the free
 * path" — an unconfigured instance keeps exactly its previous behaviour.
 *
 * Shipped adapters: `hunter` (hosted, paid, finds + verifies) and `reacher`
 * (self-hosted check-if-email-exists, free, verifies only).
 *
 * Pure contract + registry only; the adapters own their own IO.
 */

import { HunterProvider } from "@/lib/services/providers/hunter-provider";
import { ReacherProvider } from "@/lib/services/providers/reacher-provider";

/**
 * Normalised verdict, mapped from whatever vocabulary a vendor uses.
 *
 *  - `deliverable`   the mailbox accepts mail. Safe to send.
 *  - `risky`         syntactically fine but unproven — most often a catch-all
 *                    domain, which accepts every address and therefore proves
 *                    nothing about this one.
 *  - `undeliverable` the mailbox was rejected. Never write this address.
 *  - `unknown`       the verifier could not decide, OR we could not reach it.
 *
 * `unknown` deliberately absorbs transport failures. A rate-limited or timed-out
 * verifier must never be reported as `undeliverable`: that would let a provider
 * outage silently delete good addresses.
 */
export type EmailVerification =
  | "deliverable"
  | "risky"
  | "undeliverable"
  | "unknown";

export interface VerifyResult {
  status: EmailVerification;
  /** True when the domain accepts all addresses, making `deliverable` meaningless. */
  catchAll: boolean;
  /** Vendor's own verdict string, kept for debugging and stored on the person. */
  raw?: string;
}

export interface FindArgs {
  firstName: string;
  lastName: string;
  domain: string;
  /**
   * Some vendors (Findymail, Prospeo) resolve straight from a LinkedIn profile,
   * which is more accurate than name+domain guessing. Every person row in this
   * codebase already carries one, so it is always worth passing.
   */
  linkedinUrl?: string | null;
}

export interface FindResult {
  email: string;
  /** Vendor's own confidence, normalised to 0..1. */
  confidence: number;
}

export interface EmailProvider {
  readonly id: string;
  readonly canFind: boolean;
  readonly canVerify: boolean;
  /** Returns null when the vendor has no address for this person. Never throws. */
  findEmail(args: FindArgs): Promise<FindResult | null>;
  /** Never throws — unreachable vendor resolves to `unknown`. */
  verifyEmail(email: string): Promise<VerifyResult>;
}

/**
 * How many verification calls one person is allowed to cost.
 *
 * The waterfall can produce up to five candidate addresses. Verifying all of
 * them bills five times to answer a question the first or second candidate
 * almost always settles, so stop early. Exported so tests assert the bound
 * rather than hardcoding it.
 */
export const MAX_VERIFICATIONS_PER_PERSON = 3;

/** Hard deadline per provider call. */
export const PROVIDER_TIMEOUT_MS = 15_000;

/**
 * Resolves the configured provider, or null when none is set.
 *
 * `EMAIL_PROVIDER` selects the adapter; leaving it unset (or setting it to
 * `none`) is a supported configuration, not an error — Signal is self-hosted
 * and most instances will run without a paid vendor.
 */
export function getEmailProvider(): EmailProvider | null {
  const configured = (process.env.EMAIL_PROVIDER ?? "").trim().toLowerCase();
  if (!configured || configured === "none") return null;

  if (configured === "hunter") {
    const key = process.env.HUNTER_API_KEY;
    if (!key) {
      console.warn(
        "[email-provider] EMAIL_PROVIDER=hunter but HUNTER_API_KEY is unset; falling back to free-only discovery.",
      );
      return null;
    }
    return new HunterProvider(key);
  }

  if (configured === "reacher") {
    // No key needed — the backend is self-hosted and REACHER_API_URL defaults
    // to http://localhost:8080 (docker-compose wires http://reacher:8080).
    if (!process.env.REACHER_API_URL) {
      console.warn(
        "[email-provider] EMAIL_PROVIDER=reacher with REACHER_API_URL unset; assuming http://localhost:8080.",
      );
    }
    return new ReacherProvider();
  }

  console.warn(
    `[email-provider] Unknown EMAIL_PROVIDER "${configured}"; falling back to free-only discovery.`,
  );
  return null;
}
