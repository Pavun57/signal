import { anthropic } from "@ai-sdk/anthropic";
import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  streamText,
  stepCountIs,
  type UIMessage,
  type ModelMessage,
} from "ai";

import { MODELS } from "@/lib/ai/models";
import { getProfileForPrompt } from "@/lib/profile";
import { getActiveSignals } from "@/lib/signals";
import {
  estimateClaudeCostFromUsage,
  trackUsage,
} from "@/lib/services/cost-tracker";
import { getPostHogClient } from "@/lib/posthog-server";
import { buildSystemPrompt } from "@/lib/system-prompt";
import { allTools } from "@/lib/tools";
import { saveChat } from "@/lib/services/chat-history";
import { getSupabaseAndUser } from "@/lib/supabase/server";

// Full-pipeline agent runs (enrich → score → find contacts) regularly exceed
// two minutes; at 120 the platform killed the function mid-stream and the UI
// looked stuck. Vercel fluid compute allows up to 300s on all current plans.
export const maxDuration = 300;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── Token budget ───────────────────────────────────────────────────────────
// Chat context is capped aggressively: once cache_control is applied to the
// last message, kept history reads at ~10% cost, but keeping less of it in
// the first place still saves cache-creation cost and keeps latency down.
// ~50k tokens of history is plenty for a sales-research sidekick.
const MAX_INPUT_CHARS = 150_000; // ~50k tokens at ~3 chars/token

/**
 * Trim messages from the front (oldest) to fit within the character budget.
 * Always keeps the first message (initial user context) and the last N messages.
 */
function trimMessages(messages: ModelMessage[]): ModelMessage[] {
  let totalChars = 0;
  for (const msg of messages) {
    totalChars += JSON.stringify(msg).length;
  }

  if (totalChars <= MAX_INPUT_CHARS) return messages;

  // Keep first message + trim from the middle, keeping recent messages
  const first = messages[0];
  const rest = messages.slice(1);

  // Walk backwards from the end, accumulating messages that fit
  const kept: ModelMessage[] = [];
  let budget = MAX_INPUT_CHARS - JSON.stringify(first).length;

  for (let i = rest.length - 1; i >= 0; i--) {
    const size = JSON.stringify(rest[i]).length;
    if (budget - size < 0) break;
    budget -= size;
    kept.unshift(rest[i]);
  }

  return [first, ...kept];
}

export async function POST(request: Request) {
  const ctx = await getSupabaseAndUser();
  if (!ctx) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { user } = ctx;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const {
    messages: uiMessages,
    campaignId,
    pageContext,
    chatId,
  } = body as {
    messages: UIMessage[];
    campaignId?: string;
    pageContext?: string;
    chatId?: string;
  };
  const persistChatId =
    typeof chatId === "string" && UUID_RE.test(chatId) ? chatId : null;
  const modelMessages = trimMessages(await convertToModelMessages(uiMessages));

  // Mark the last message with ephemeral cache_control so everything before
  // it (system prompt, tools, all prior turns) is cached. On the next turn,
  // those tokens read back at ~10% of input cost. The AI SDK top-level
  // providerOptions below caches the system+tools preamble; this extends the
  // cache boundary over the growing message history.
  if (modelMessages.length > 0) {
    const lastIdx = modelMessages.length - 1;
    modelMessages[lastIdx] = {
      ...modelMessages[lastIdx],
      providerOptions: {
        ...modelMessages[lastIdx].providerOptions,
        anthropic: {
          ...(modelMessages[lastIdx].providerOptions?.anthropic ?? {}),
          cacheControl: { type: "ephemeral" },
        },
      },
    };
  }

  const profile = await getProfileForPrompt(campaignId);
  const signals = campaignId ? await getActiveSignals(campaignId) : null;
  const systemPrompt = buildSystemPrompt({
    profile,
    campaignId,
    signals,
    pageContext,
  });

  const stream = createUIMessageStream({
    // originalMessages + onFinish give us the full final message list so the
    // conversation is persisted server-side — the client-side save in
    // agent-panel never runs when the tab dies or navigates mid-stream.
    originalMessages: uiMessages,
    onFinish: persistChatId
      ? async ({ messages }) => {
          await saveChat(
            ctx.supabase,
            user.id,
            persistChatId,
            messages,
            campaignId,
          );
        }
      : undefined,
    execute: ({ writer }) => {
      const result = streamText({
        model: anthropic(MODELS.CHAT),
        system: systemPrompt,
        messages: modelMessages,
        tools: allTools,
        maxOutputTokens: 8192,
        // Full-pipeline agent runs (enrich → score → find contacts → draft)
        // routinely take 20+ steps; at 15 the loop halted silently mid-batch
        // and the UI just looked stuck. 40 covers the longest observed runs.
        stopWhen: stepCountIs(40),
        // Without this, Stop / closing the tab leaves the server running the
        // whole remaining pipeline (and paying for it) invisibly.
        abortSignal: request.signal,
        // Cache the system prompt + tool definitions (~30k stable tokens) across
        // turns in a conversation. Follow-up turns read them at ~10% of input cost.
        providerOptions: {
          anthropic: {
            cacheControl: { type: "ephemeral" },
          },
        },
        experimental_context: {
          writer,
          userId: user.id,
          campaignId: campaignId ?? null,
        },
        onFinish({ usage }) {
          trackUsage({
            service: "claude",
            operation: "chat",
            tokens_input: usage.inputTokens ?? 0,
            tokens_output: usage.outputTokens ?? 0,
            estimated_cost_usd: estimateClaudeCostFromUsage("sonnet", usage),
            metadata: {
              model: "claude-sonnet-4-6",
              cache_creation_tokens: usage.inputTokenDetails?.cacheWriteTokens,
              cache_read_tokens: usage.inputTokenDetails?.cacheReadTokens,
            },
            campaign_id: campaignId,
            user_id: user.id,
          });
          const posthog = getPostHogClient();
          posthog.capture({
            distinctId: user.id,
            event: "chat_completed",
            properties: {
              campaign_id: campaignId ?? null,
              tokens_input: usage.inputTokens ?? 0,
              tokens_output: usage.outputTokens ?? 0,
              estimated_cost_usd: estimateClaudeCostFromUsage("sonnet", usage),
            },
          });
        },
      });
      writer.merge(result.toUIMessageStream());
    },
    // Default masks every failure as "An error occurred" — surface the real
    // message (rate limit, overloaded, tool crash) so the banner is actionable.
    onError: (error) =>
      error instanceof Error ? error.message : "Stream failed",
  });

  return createUIMessageStreamResponse({ stream });
}
