import { generateObject } from "ai";
import { llmTimeout } from "@/lib/utils/timeout";
import { anthropic } from "@ai-sdk/anthropic";
import {
  ComposedEmailSchema,
  buildComposeUserPrompt,
  buildEmailSystemPrompt,
  type ComposedEmail,
} from "./skill";
import { apiSafeSchema } from "@/lib/ai/api-safe-schema";
import { MODELS } from "@/lib/ai/models";
import { generateWithRetry } from "@/lib/ai/salvage-object";
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
 * Single-email composition via generateObject. One focused Claude call per
 * contact × step. The system prompt is stable for a given (user, profile,
 * campaign, voice, fact bank) so parallel fan-out hits prompt cache on all
 * but the first call — the sender facts are part of the stable prompt, not
 * the per-contact one.
 *
 * Model: Opus — chosen for its ability to balance the base cold-email rules
 * against the user's voice profile, whose rules layer over and can conflict
 * with them. Haiku 4.5 tends to drop rules when too many are stacked; Opus
 * holds them. Cost/latency are cushioned by the ephemeral prompt cache and
 * bounded concurrency in the fan-out.
 */
export async function composeEmail(
  input: ComposeInput,
): Promise<ComposeResult> {
  // factBank and learnings are destructured out so they cannot leak into the
  // per-contact user prompt; they belong only in the cached system prompt.
  const { voice, factBank, learnings, ...userPromptInput } = input;

  // claude-opus-5 honours the structured-output schema only ~65-80% of the time
  // on this prompt, sometimes wrapping the payload and sometimes emitting
  // malformed JSON inside it. Salvage recovers the wrapped-but-valid responses
  // for free; the retries cover the rest. Measured live — without both, a fifth
  // or more of every fan-out silently loses its draft.
  const attempt = await generateWithRetry(async () => {
    const { object } = await generateObject({
      abortSignal: llmTimeout(),
      model: anthropic(MODELS.EMAIL),
      schema: apiSafeSchema(ComposedEmailSchema),
      system: buildEmailSystemPrompt(
        voice ?? null,
        factBank ?? null,
        learnings ?? null,
      ),
      prompt: buildComposeUserPrompt(userPromptInput),
      providerOptions: {
        anthropic: {
          // Cache the stable system prompt across the fan-out batch.
          cacheControl: { type: "ephemeral" },
          // Opus 5 thinks by default (Opus 4.6 did not), and maxOutputTokens
          // caps thinking + visible output together — so the old 1200 budget
          // would have been eaten by reasoning and truncated the email,
          // failing generateObject and silently skipping the draft. Medium
          // effort is the right depth here: enough to hold the base rules and
          // the user's voice profile together without spending xhigh-level
          // reasoning on a 125-word email.
          effort: "medium",
        },
      },
      // Visible output is ~600 tokens (subject + bodyHtml + bodyText +
      // aiReasoning). The rest is headroom for thinking.
      // generateWithRetry owns retrying. Leaving the SDK default of 2 in place
      // would stack to 12 upstream requests per email under a 429 storm.
      maxRetries: 0,
      maxOutputTokens: 4000,
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
