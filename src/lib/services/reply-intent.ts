import { generateObject } from "ai";
import { z } from "zod";

import { apiSafeSchema } from "@/lib/ai/api-safe-schema";
import { AI_MODEL, getLLM } from "@/lib/ai/models";
import { generateWithRetry } from "@/lib/ai/salvage-object";
import { llmTimeout } from "@/lib/utils/timeout";
import {
  estimateLlmCostFromUsage,
  trackUsage,
} from "@/lib/services/cost-tracker";
import {
  UNTRUSTED_NOTICE,
  stringify,
  wrapUntrusted,
} from "@/lib/prompt-safety";

/**
 * Intent classification for captured reply bodies.
 *
 * Raw "replied" status treats a vacation auto-responder the same as "yes,
 * let's talk", which poisons every reply-rate metric downstream: the
 * learning job would happily conclude that whatever copy triggers the most
 * OOO responders is the winning style. Stamping an intent on each reply is
 * what makes "reply rate" mean something.
 *
 * The executor (email-classify.ts) keeps the IO; this module owns the
 * decision, matching the split email-tracking.ts established.
 */

export const REPLY_INTENTS = [
  "interested",
  "question",
  "not_interested",
  "ooo",
  "referral",
  "unsubscribe",
  "other",
] as const;

export type ReplyIntent = (typeof REPLY_INTENTS)[number];

/** Intents that count as a genuine human reply for outcome metrics. */
export const REAL_REPLY_INTENTS: ReadonlySet<ReplyIntent> = new Set([
  "interested",
  "question",
  "not_interested",
  "referral",
  "unsubscribe",
  "other",
]);

/** Intents that count as a positive outcome for the learning job. */
export const POSITIVE_INTENTS: ReadonlySet<ReplyIntent> = new Set([
  "interested",
  "question",
  "referral",
]);

/**
 * Strength ordering for collapsing a thread's replies to one intent per
 * send: a positive answer beats a neutral one beats an OOO, so a thread
 * that auto-replied first and answered later counts as the answer.
 */
export function intentRank(intent: ReplyIntent): number {
  return POSITIVE_INTENTS.has(intent)
    ? 3
    : REAL_REPLY_INTENTS.has(intent)
      ? 2
      : 1;
}

export const ReplyIntentSchema = z.object({
  intent: z.enum(REPLY_INTENTS),
  confidence: z
    .number()
    .min(0)
    .max(1)
    .describe("How sure you are of the intent label, 0 to 1"),
  reasoning: z
    .string()
    .describe("One short sentence explaining the label, under 140 characters"),
});

export type ReplyIntentResult = z.infer<typeof ReplyIntentSchema>;

/**
 * Whether a classified reply should suppress future outreach to the address.
 *
 * Unsubscribe suppresses at any confidence: honoring a possible opt-out and
 * being wrong costs one prospect; ignoring a real one costs trust and can
 * cost deliverability. not_interested needs high confidence because "not
 * right now" phrasing is easy for the classifier to over-read.
 */
export function shouldSuppress(
  intent: ReplyIntent,
  confidence: number,
): boolean {
  if (intent === "unsubscribe") return true;
  if (intent === "not_interested") return confidence >= 0.8;
  return false;
}

const SUPPRESSION_REASON: Partial<
  Record<ReplyIntent, "unsubscribe" | "not_interested">
> = {
  unsubscribe: "unsubscribe",
  not_interested: "not_interested",
};

/** Maps a suppress-worthy intent to the outreach_suppressions reason value. */
export function suppressionReason(
  intent: ReplyIntent,
): "unsubscribe" | "not_interested" | null {
  return SUPPRESSION_REASON[intent] ?? null;
}

/**
 * Classifies one reply body. Returns null when generation fails after
 * retries; the caller leaves the row unclassified so a later run retries.
 */
export async function classifyReplyIntent(params: {
  /** Subject of the reply as received. */
  subject: string;
  /** Plain-text reply body, already quote-stripped at capture time. */
  bodyText: string;
  /** Subject of the email we sent, for context. */
  sentSubject?: string | null;
}): Promise<ReplyIntentResult | null> {
  const prompt = `You are classifying the intent of a reply to a cold sales email.

${UNTRUSTED_NOTICE}

Labels:
- "interested": wants to learn more, agrees to a call, asks for a demo or pricing with buying interest.
- "question": engages with a genuine question but no clear buying signal yet.
- "not_interested": a human politely or bluntly declining ("not for us", "we already have a vendor", "no budget").
- "ooo": an automatic reply: out of office, parental leave, "no longer with the company" autoresponders.
- "referral": redirects to a better-suited person ("talk to our CTO", "forwarding to...").
- "unsubscribe": asks to stop being contacted, remove from list, or threatens spam reporting.
- "other": anything else a human wrote that fits none of the above.

Rules:
- Automated messages are always "ooo", even when the text mentions another contact.
- A decline that ALSO asks to never be contacted again is "unsubscribe", not "not_interested".
- Judge only from the text given. Do not guess beyond it.

We sent an email with subject ${stringify(params.sentSubject ?? "(unknown)")}. The reply:

Subject: ${stringify(params.subject)}
Body:
${wrapUntrusted(params.bodyText.slice(0, 8000))}`;

  const result = await generateWithRetry(
    async () => {
      const { object, usage } = await generateObject({
        abortSignal: llmTimeout(),
        model: getLLM(),
        schema: apiSafeSchema(ReplyIntentSchema),
        prompt,
      });
      trackUsage({
        service: "llm",
        operation: "reply-intent",
        tokens_input: usage.inputTokens ?? 0,
        tokens_output: usage.outputTokens ?? 0,
        estimated_cost_usd: estimateLlmCostFromUsage(usage),
        metadata: { model: AI_MODEL },
      });
      return object;
    },
    ReplyIntentSchema,
    3,
  );

  return result.ok ? result.value : null;
}
