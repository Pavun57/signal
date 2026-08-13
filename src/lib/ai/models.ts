import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

/**
 * Single OpenAI-compatible provider for every LLM call in the app.
 *
 * Operators point the whole app at any OpenAI-compatible endpoint with env
 * vars — Anthropic's compat endpoint (default), OpenAI, OpenRouter, a local
 * gateway, etc. There is one model for all task tiers.
 *
 *   AI_API_KEY    bearer token (falls back to ANTHROPIC_API_KEY)
 *   AI_BASE_URL   any OpenAI-compatible /v1 root (default: Anthropic)
 *   AI_MODEL      single model for chat, composition, extraction, verdicts
 *
 * Nothing in this module throws at import time — Next.js imports route
 * modules during build — key validation happens inside the getters.
 */

export const AI_BASE_URL =
  process.env.AI_BASE_URL ?? "https://api.anthropic.com/v1";

export const AI_MODEL = process.env.AI_MODEL ?? "claude-sonnet-4-6";

/** Key resolution shared by the LLM factory and Stagehand. */
export function getAiApiKey(): string | undefined {
  return process.env.AI_API_KEY ?? process.env.ANTHROPIC_API_KEY ?? undefined;
}

const MISSING_KEY_ERROR =
  "No AI API key configured. Set AI_API_KEY in .env.local " +
  "(ANTHROPIC_API_KEY is still accepted as a fallback). See docs/setup.md.";

// Memoized on the resolved triple so tests that mutate process.env between
// cases still get a fresh client.
let cache: { key: string; model: unknown } | null = null;

type LlmModel = ReturnType<ReturnType<typeof createOpenAICompatible>>;

export function getLLM(modelId: string = AI_MODEL): LlmModel {
  const apiKey = getAiApiKey();
  if (!apiKey) throw new Error(MISSING_KEY_ERROR);
  const cacheKey = `${AI_BASE_URL}|${modelId}|${apiKey.slice(0, 8)}`;
  if (!cache || cache.key !== cacheKey) {
    const provider = createOpenAICompatible({
      name: "signal-ai",
      baseURL: AI_BASE_URL,
      apiKey,
    });
    cache = { key: cacheKey, model: provider(modelId) };
  }
  return cache.model as LlmModel;
}

/**
 * Stagehand is not the AI SDK: it needs a "provider/model" prefixed name and
 * gets its key/baseURL separately. The prefix is derived from the base URL
 * host; AI_STAGEHAND_MODEL overrides the whole string for gateways that
 * don't match the heuristic.
 */
export function getStagehandModelConfig(): {
  modelName: string;
  apiKey: string;
  baseURL?: string;
} {
  const apiKey = getAiApiKey();
  if (!apiKey) throw new Error(MISSING_KEY_ERROR);
  if (process.env.AI_STAGEHAND_MODEL) {
    return {
      modelName: process.env.AI_STAGEHAND_MODEL,
      apiKey,
      baseURL: AI_BASE_URL,
    };
  }
  const isAnthropic = new URL(AI_BASE_URL).hostname.endsWith("anthropic.com");
  return isAnthropic
    ? { modelName: `anthropic/${AI_MODEL}`, apiKey }
    : { modelName: `openai/${AI_MODEL}`, apiKey, baseURL: AI_BASE_URL };
}

// Cost-center estimate rates (USD per 1M tokens); defaults match the
// default model. Set these to match whatever AI_MODEL points at.
export const AI_INPUT_PRICE_PER_MTOK = Number(
  process.env.AI_INPUT_PRICE_PER_MTOK ?? 3.0,
);
export const AI_OUTPUT_PRICE_PER_MTOK = Number(
  process.env.AI_OUTPUT_PRICE_PER_MTOK ?? 15.0,
);
