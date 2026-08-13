import { generateObject } from "ai";
import { llmTimeout } from "@/lib/utils/timeout";
import {
  ComposedEmailSchema,
  buildComposeUserPrompt,
  buildEmailSystemPrompt,
  type ComposedEmail,
} from "./skill";
import { apiSafeSchema } from "@/lib/ai/api-safe-schema";
import { AI_MODEL, getLLM } from "@/lib/ai/models";
import { generateWithRetry } from "@/lib/ai/salvage-object";
import {
  estimateLlmCostFromUsage,
  trackUsage,
} from "@/lib/services/cost-tracker";
import type { VoiceProfile } from "@/lib/types/email-voice";

type UserPromptInput = Parameters<typeof buildComposeUserPrompt>[0];

export type ComposeInput = UserPromptInput & {
  voice?: VoiceProfile | null;
  factBank?: string | null;
  /** Rendered LEARNINGS block (email-learnings.ts), part of the cached system prompt. */
  learnings?: string | null;
};

export type ComposeResult =
  | { ok: true; email: ComposedEmail }
  | { ok: false; error: string };

/**
 * Single-email composition via generateObject. One focused LLM call per
 * contact × step. The system prompt is stable for a given (user, profile,
 * campaign, voice, fact bank) — the sender facts are part of the stable
 * prompt, not the per-contact one.
 *
 * Model quality matters here: the configured model must balance the base
 * cold-email rules against the user's voice profile, whose rules layer over
 * and can conflict with them. Weaker models tend to drop rules when too many
 * are stacked — pick a frontier model via AI_MODEL for this workload.
 */
export async function composeEmail(
  input: ComposeInput,
): Promise<ComposeResult> {
  // factBank and learnings are destructured out so they cannot leak into the
  // per-contact user prompt; they belong only in the cached system prompt.
  const { voice, factBank, learnings, ...userPromptInput } = input;

  // Frontier models honour the structured-output schema only most of the time
  // on this prompt, sometimes wrapping the payload and sometimes emitting
  // malformed JSON inside it. Salvage recovers the wrapped-but-valid responses
  // for free; the retries cover the rest. Measured live — without both, a
  // fifth or more of every fan-out silently loses its draft.
  const attempt = await generateWithRetry(async () => {
    const { object, usage } = await generateObject({
      abortSignal: llmTimeout(),
      model: getLLM(),
      schema: apiSafeSchema(ComposedEmailSchema),
      messages: [
        {
          role: "system",
          content: buildEmailSystemPrompt(
            voice ?? null,
            factBank ?? null,
            learnings ?? null,
          ),
        },
        { role: "user", content: buildComposeUserPrompt(userPromptInput) },
      ],
      // Visible output is ~600 tokens (subject + bodyHtml + bodyText +
      // aiReasoning). The rest is headroom for reasoning-style models whose
      // thinking counts against maxOutputTokens.
      // generateWithRetry owns retrying. Leaving the SDK default of 2 in place
      // would stack to 12 upstream requests per email under a 429 storm.
      maxRetries: 0,
      maxOutputTokens: 4000,
    });
    // K18: every composed email is an LLM call and none of it was ever
    // cost-tracked. Attribution inherits the nearest withAction context.
    trackUsage({
      service: "llm",
      operation: "compose-email",
      tokens_input: usage.inputTokens ?? 0,
      tokens_output: usage.outputTokens ?? 0,
      estimated_cost_usd: estimateLlmCostFromUsage(usage),
      metadata: { model: AI_MODEL },
    });
    return object;
  }, ComposedEmailSchema);

  return attempt.ok
    ? { ok: true, email: attempt.value }
    : { ok: false, error: attempt.error };
}

/**
 * Run an async task-returning function against items with bounded concurrency.
 * Small local helper — avoids pulling in p-limit for one call site.
 */
export async function mapConcurrent<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (true) {
        const i = cursor++;
        if (i >= items.length) return;
        results[i] = await fn(items[i], i);
      }
    },
  );
  await Promise.all(workers);
  return results;
}
