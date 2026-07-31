import { fetchWithTimeout } from "@/lib/fetch-with-timeout";
import { PRICING, trackUsage } from "@/lib/services/cost-tracker";
import {
  PROVIDER_TIMEOUT_MS,
  type EmailProvider,
  type EmailVerification,
  type FindArgs,
  type FindResult,
  type VerifyResult,
} from "@/lib/services/email-provider";

/**
 * Hunter.io adapter — https://hunter.io/api-keys
 *
 * Chosen as the default because one key covers both halves of the job
 * (`/email-finder` and `/email-verifier`), which suits a self-hosted app where
 * every extra credential is another thing the operator has to go get. Vendors
 * with better LinkedIn-based coverage exist; swapping is a new file
 * implementing EmailProvider plus a branch in getEmailProvider().
 */

const BASE = "https://api.hunter.io/v2";

/**
 * Hunter's verifier statuses → our normalised vocabulary.
 * https://hunter.io/api-documentation/v2#email-verifier
 *
 * `accept_all` is the important one: it means the domain accepts every address,
 * so a positive result there is not evidence about this particular mailbox.
 * Mapping it to `risky` (not `deliverable`) is what stops a catch-all domain
 * from laundering a blind guess into a verified address.
 */
const STATUS_MAP: Record<string, EmailVerification> = {
  valid: "deliverable",
  invalid: "undeliverable",
  accept_all: "risky",
  webmail: "risky",
  disposable: "undeliverable",
  unknown: "unknown",
};

export class HunterProvider implements EmailProvider {
  readonly id = "hunter";
  readonly canFind = true;
  readonly canVerify = true;

  constructor(private readonly apiKey: string) {
    if (!apiKey) {
      throw new Error(
        "Hunter API key missing. Get one at https://hunter.io/api-keys and set HUNTER_API_KEY.",
      );
    }
  }

  async findEmail(args: FindArgs): Promise<FindResult | null> {
    const url = new URL(`${BASE}/email-finder`);
    url.searchParams.set("domain", args.domain);
    url.searchParams.set("first_name", args.firstName);
    url.searchParams.set("last_name", args.lastName);
    url.searchParams.set("api_key", this.apiKey);

    try {
      const response = await fetchWithTimeout(
        url.toString(),
        { headers: { Accept: "application/json" } },
        PROVIDER_TIMEOUT_MS,
      );

      // 404 is Hunter's "no result", not a failure worth logging loudly.
      if (response.status === 404) return null;
      if (!response.ok) {
        console.warn(
          `[hunter] email-finder HTTP ${response.status} for ${args.domain}`,
        );
        return null;
      }

      const body = (await response.json()) as {
        data?: { email?: string | null; score?: number | null };
      };

      trackUsage({
        service: "email_provider",
        operation: "hunter-find",
        estimated_cost_usd: PRICING.email_provider_find,
        metadata: { domain: args.domain, found: Boolean(body.data?.email) },
      });

      const email = body.data?.email;
      if (!email) return null;

      // Hunter scores 0-100; our confidences are 0-1 throughout.
      const score = typeof body.data?.score === "number" ? body.data.score : 0;
      return { email: email.toLowerCase(), confidence: score / 100 };
    } catch (err) {
      console.warn(
        `[hunter] email-finder failed: ${String(err).slice(0, 120)}`,
      );
      return null;
    }
  }

  async verifyEmail(email: string): Promise<VerifyResult> {
    const url = new URL(`${BASE}/email-verifier`);
    url.searchParams.set("email", email);
    url.searchParams.set("api_key", this.apiKey);

    try {
      const response = await fetchWithTimeout(
        url.toString(),
        { headers: { Accept: "application/json" } },
        PROVIDER_TIMEOUT_MS,
      );

      // Rate limit or upstream trouble. Explicitly `unknown`, never
      // `undeliverable` — an outage must not read as "this address is bad" and
      // delete an otherwise good candidate.
      if (!response.ok) {
        console.warn(`[hunter] email-verifier HTTP ${response.status}`);
        return {
          status: "unknown",
          catchAll: false,
          raw: `http_${response.status}`,
        };
      }

      const body = (await response.json()) as {
        data?: { status?: string | null; accept_all?: boolean | null };
      };

      trackUsage({
        service: "email_provider",
        operation: "hunter-verify",
        estimated_cost_usd: PRICING.email_provider_verify,
        metadata: { status: body.data?.status ?? null },
      });

      const rawStatus = (body.data?.status ?? "unknown").toLowerCase();
      const catchAll =
        body.data?.accept_all === true || rawStatus === "accept_all";

      return {
        status: STATUS_MAP[rawStatus] ?? "unknown",
        catchAll,
        raw: rawStatus,
      };
    } catch (err) {
      console.warn(
        `[hunter] email-verifier failed: ${String(err).slice(0, 120)}`,
      );
      return { status: "unknown", catchAll: false, raw: "error" };
    }
  }
}
