import { fetchWithTimeout } from "@/lib/fetch-with-timeout";
import { trackUsage } from "@/lib/services/cost-tracker";
import {
  PROVIDER_TIMEOUT_MS,
  type EmailProvider,
  type EmailVerification,
  type FindArgs,
  type FindResult,
  type VerifyResult,
} from "@/lib/services/email-provider";

/**
 * Reacher adapter — self-hosted `check-if-email-exists` backend.
 * https://github.com/reacherhq/check-if-email-exists
 *
 * Runs as a Docker container (`reacherhq/backend`, see docker-compose.yaml)
 * and exposes one endpoint: POST /v0/check_email { to_email } →
 * { is_reachable, syntax, smtp: { is_catch_all, ... }, mx, misc }.
 *
 * Unlike Hunter it cannot *find* addresses — verification only — and it costs
 * nothing per call, so every trackUsage row here is estimated_cost_usd: 0 and
 * exists purely so verification activity stays visible in the cost dashboard.
 *
 * Operational caveat: the backend probes the recipient's MX over SMTP, which
 * needs outbound port 25 open on the host. When it is blocked, every verdict
 * comes back is_reachable: "unknown" — which Signal treats as retryable, so a
 * blocked port degrades verification rather than corrupting it.
 */

const DEFAULT_BASE_URL = "http://localhost:8080";

/**
 * Reacher's top-level verdict → our normalised vocabulary.
 *
 * `risky` is the important one: Reacher returns it whenever the SMTP exchange
 * was inconclusive — most often a catch-all domain, which accepts every
 * address and therefore proves nothing about this one. Mapping it to `risky`
 * (not `deliverable`) is what stops a catch-all domain from laundering a blind
 * guess into a verified address.
 */
const STATUS_MAP: Record<string, EmailVerification> = {
  safe: "deliverable",
  risky: "risky",
  invalid: "undeliverable",
  unknown: "unknown",
};

interface ReacherCheckResponse {
  is_reachable?: string | null;
  syntax?: { is_valid_syntax?: boolean | null } | null;
  smtp?: { is_catch_all?: boolean | null } | null;
}

function baseUrl(): string {
  // An empty-but-set env (common in compose files) must still fall back.
  const url = (process.env.REACHER_API_URL ?? "").trim().replace(/\/+$/, "");
  return url || DEFAULT_BASE_URL;
}

export class ReacherProvider implements EmailProvider {
  readonly id = "reacher";
  readonly canFind = false;
  readonly canVerify = true;

  // Callers guard on `canFind` before calling this; if one doesn't, returning
  // null (not throwing) keeps the contract.
  async findEmail(_args: FindArgs): Promise<FindResult | null> {
    return null;
  }

  async verifyEmail(email: string): Promise<VerifyResult> {
    try {
      const response = await fetchWithTimeout(
        `${baseUrl()}/v0/check_email`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({ to_email: email }),
        },
        PROVIDER_TIMEOUT_MS,
      );

      // Backend down or erroring. Explicitly `unknown`, never `undeliverable`
      // — an unreachable verifier must not read as "this address is bad" and
      // delete an otherwise good candidate.
      if (!response.ok) {
        console.warn(`[reacher] check_email HTTP ${response.status}`);
        trackUsage({
          service: "email_provider",
          operation: "reacher-verify-failed",
          estimated_cost_usd: 0,
          metadata: { httpStatus: response.status },
        });
        return {
          status: "unknown",
          catchAll: false,
          raw: `http_${response.status}`,
        };
      }

      const body = (await response.json()) as ReacherCheckResponse;
      const rawStatus = (body.is_reachable ?? "unknown").toLowerCase();
      const catchAll = body.smtp?.is_catch_all === true;

      trackUsage({
        service: "email_provider",
        operation: "reacher-verify",
        estimated_cost_usd: 0,
        metadata: { status: rawStatus, catchAll },
      });

      // A syntactically invalid address is undeliverable no matter what the
      // SMTP layer said (there is nothing to probe).
      const status =
        body.syntax?.is_valid_syntax === false
          ? "undeliverable"
          : (STATUS_MAP[rawStatus] ?? "unknown");

      return { status, catchAll, raw: rawStatus };
    } catch (err) {
      console.warn(`[reacher] check_email failed: ${String(err).slice(0, 120)}`);
      return { status: "unknown", catchAll: false, raw: "error" };
    }
  }
}
