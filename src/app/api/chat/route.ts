import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  streamText,
  stepCountIs,
  type UIMessage,
} from "ai";

import { AI_MODEL, getLLM } from "@/lib/ai/models";
import { VoiceRunBodySchema } from "@/lib/email-skills/swipe-service";
import { getProfileForPrompt } from "@/lib/profile";
import { getActiveSignals } from "@/lib/signals";
import {
  estimateLlmCostFromUsage,
  trackUsage,
} from "@/lib/services/cost-tracker";
import { getPostHogClient } from "@/lib/posthog-server";
import { buildSystemPrompt } from "@/lib/system-prompt";
import { allTools } from "@/lib/tools";
import { saveChat } from "@/lib/services/chat-history";
import { getSupabaseAndUser } from "@/lib/supabase/server";
import { trimMessages } from "@/lib/chat/trim-messages";

// Full-pipeline agent runs (enrich → score → find contacts) regularly exceed
// two minutes; at 120 and again at 300 the platform killed the function
// mid-stream, silently — no error event reaches the stream, onFinish never
// runs, and the whole turn (and its chat history) is lost. 800 is the Vercel
// Pro/Enterprise ceiling (GA). Hobby caps at 300 and fails the build above
// it — self-hosters on Hobby should drop this to 300; the turn time budget
// below keeps things working either way, just with more continuation turns.
export const maxDuration = 800;

// Stop the agent loop well before maxDuration so the turn ends CLEANLY:
// the model's progress streams out, onFinish runs, and the chat is saved.
// The gap covers the longest single step still in flight when the budget
// trips (a 150s enrichment chunk plus model latency). When a turn is cut
// short, the client sees a `data-turn-paused` part and auto-continues in a
// fresh request, so long pipelines span windows instead of dying silently.
const TURN_TIME_BUDGET_MS = 600_000;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Token budget: history is trimmed via lib/chat/trim-messages (capped
// aggressively; ~50k tokens is plenty for a sales-research sidekick, and
// the trim repairs tool-call boundaries so the suffix stays API-valid).

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

  // The active email-voice run, when the deck has one. Fully validated and
  // bounded before any tool sees it: the transcript is client-controlled text
  // that ends up inside an LLM prompt on the operator's key. Invalid or
  // over-long payloads drop to null rather than failing the chat, because a
  // broken run must not take the whole agent down with it.
  let voiceRun = null;
  if (body.voiceRun) {
    const parsedRun = VoiceRunBodySchema.safeParse(body.voiceRun);
    if (
      parsedRun.success &&
      JSON.stringify(parsedRun.data.transcript).length <= 120_000
    ) {
      voiceRun = parsedRun.data;
    }
  }
  const modelMessages = trimMessages(await convertToModelMessages(uiMessages));

  const deadlineAt = Date.now() + TURN_TIME_BUDGET_MS;

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
        model: getLLM(),
        system: systemPrompt,
        messages: modelMessages,
        tools: allTools,
        maxOutputTokens: 8192,
        // Full-pipeline agent runs (enrich → score → find contacts → draft)
        // routinely take 20+ steps; at 15 the loop halted silently mid-batch
        // and the UI just looked stuck. 40 covers the longest observed runs.
        // The time condition ends the turn before the platform would kill
        // the function; the client auto-continues (see data-turn-paused).
        stopWhen: [stepCountIs(40), () => Date.now() >= deadlineAt],
        // Without this, Stop / closing the tab leaves the server running the
        // whole remaining pipeline (and paying for it) invisibly.
        abortSignal: request.signal,
        experimental_context: {
          writer,
          userId: user.id,
          campaignId: campaignId ?? null,
          // Batch tools (enrichCompanies/enrichContacts) check this before
          // starting a chunk they can't finish inside the turn budget.
          deadlineAt,
          // The voice tools read the run from here; drafts go back to the
          // deck through `writer` as transient data parts, never as text.
          voiceRun,
        },
        onFinish(event) {
          const { usage, finishReason, steps } = event;
          // "tool-calls" as the FINAL finish reason means the model still
          // wanted to work but stopWhen ended the loop — tell the client so
          // it can continue the pipeline in a fresh request. Transient: the
          // part reaches onData but is never persisted into the message.
          //
          // Guard on actual tool calls: some OpenAI-compatible gateways
          // (Nebius serving GLM-5.1, observed 2026-08) report
          // finish_reason "tool_calls" while streaming ZERO tool-call
          // deltas. Without the check, the client auto-continues into the
          // same dead turn until MAX_AUTO_CONTINUES — the chat looks stuck
          // and fills with "Continue exactly where you left off." messages.
          const lastStep = steps[steps.length - 1];
          if (finishReason === "tool-calls" && lastStep?.toolCalls.length) {
            writer.write({
              type: "data-turn-paused",
              data: {
                reason: Date.now() >= deadlineAt ? "time-budget" : "step-limit",
              },
              transient: true,
            });
          }
          trackUsage({
            service: "llm",
            operation: "chat",
            tokens_input: usage.inputTokens ?? 0,
            tokens_output: usage.outputTokens ?? 0,
            estimated_cost_usd: estimateLlmCostFromUsage(usage),
            metadata: {
              model: AI_MODEL,
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
              estimated_cost_usd: estimateLlmCostFromUsage(usage),
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
