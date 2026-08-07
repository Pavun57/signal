import { tool } from "ai";
import { z } from "zod";

import {
  completeVoiceRun,
  generateVoiceBatch,
  refineVoiceProfile as refineVoiceProfileService,
  type VoiceRunBody,
} from "@/lib/email-skills/swipe-service";
import type { SwipeTranscript } from "@/lib/email-skills/swipe-prompts";
import { getSupabaseAndUser } from "@/lib/supabase/server";

/**
 * The agent's side of voice-by-swiping.
 *
 * The deck at /email-skills renders the drafts and collects the judgements;
 * the conversation happens here, in the one chat the app already has. The run
 * itself (queue, judgements, samples) lives client-side and arrives in the
 * chat body as `voiceRun`, which the chat route validates and passes through
 * experimental_context.
 *
 * Drafts never enter the conversation. They ship to the deck through the
 * message stream as transient data parts, and the tool returns only counts to
 * the model. The system prompt forbids pasting email bodies into chat, and the
 * deck is where they belong.
 */

interface VoiceToolCtx {
  userId?: string;
  campaignId?: string | null;
  voiceRun?: VoiceRunBody | null;
  writer?: { write: (chunk: unknown) => void };
}

function ctxFrom(experimental_context: unknown): VoiceToolCtx {
  return (experimental_context as VoiceToolCtx | undefined) ?? {};
}

/**
 * The wire schema validates axes as bounded strings rather than re-declaring
 * the prompt enums; the prompts only ever stringify them. One widening cast,
 * here, instead of at every call site.
 */
function asTranscript(t: VoiceRunBody["transcript"]): SwipeTranscript {
  return t as unknown as SwipeTranscript;
}

const NO_RUN_ERROR =
  "No active voice run reached this turn. The run starts on the email voice page: " +
  "send the user to /email-skills (add ?campaign=<id> for a campaign voice), where " +
  "they answer the paste-your-writing step and the run begins.";

/** What the deck needs to render a batch; mirrored by the ingest logic in
 * voice-run-context. `mode` says what to do with the queue. `persona` is the
 * fictional person this batch is written to, stamped onto each card. */
function emitDrafts(
  writer: VoiceToolCtx["writer"],
  data: {
    mode: "opening" | "append" | "replace";
    drafts: unknown[];
    persona: { label: string; real?: boolean } | null;
    /** The run scope these drafts were generated for. The client refuses
     * parts whose scope doesn't match the active run, so an in-flight batch
     * can't append to a different scope's deck. */
    campaignId?: string | null;
  },
) {
  writer?.write({ type: "data-voice-drafts", data, transient: true });
}

/** Honest about which recipient mode the batch used. */
function personaNoteFor(
  persona: { label: string; real?: boolean } | null,
): string {
  return persona?.real
    ? "The recipient is a real contact from this campaign; drafts only reference enriched facts about them."
    : "The recipient is a fictional persona invented from the campaign ICP; a fresh one appears each batch.";
}

export const startVoiceRun = tool({
  description:
    "Write the opening batch of drafts for the user's email-voice run. Call this " +
    "when a voice-run message says the run is ready to start. The drafts appear " +
    "on the deck beside the chat, NOT here: never repeat their subjects or bodies " +
    "in your reply. Returns counts only.",
  inputSchema: z.object({
    count: z
      .number()
      .int()
      .min(2)
      .max(8)
      .optional()
      .describe("How many drafts to open with. Default 6."),
  }),
  execute: async (input, { experimental_context }) => {
    const ctx = ctxFrom(experimental_context);
    if (!ctx.voiceRun) return { error: NO_RUN_ERROR };

    const auth = await getSupabaseAndUser();
    if (!auth) return { error: "No authenticated session in tool context." };

    const result = await generateVoiceBatch(auth.supabase, {
      campaignId: ctx.voiceRun.campaignId ?? null,
      transcript: asTranscript(ctx.voiceRun.transcript),
      count: input.count ?? 6,
    });
    if (!result.ok) return { error: result.error };

    emitDrafts(ctx.writer, {
      mode: "opening",
      drafts: result.drafts,
      persona: result.persona,
      campaignId: ctx.voiceRun.campaignId ?? null,
    });
    return {
      ok: true,
      draftCount: result.drafts.length,
      writtenTo: result.persona?.label ?? null,
      personaNote: personaNoteFor(result.persona),
      samplesUsed: (ctx.voiceRun.transcript.samples ?? []).filter((s) =>
        s.trim(),
      ).length,
      note: "The drafts are on the deck. Tell the user to judge them there; do not quote them.",
    };
  },
});

export const rewriteVoiceDrafts = tool({
  description:
    "Write the next drafts for the active email-voice run. Call it (a) when a " +
    "voice-run message asks for the next batch, or (b) whenever the user gives " +
    "style feedback mid-run ('too salesy', 'never open with a compliment'): pass " +
    "their words as `instruction`, verbatim, and the pending drafts are replaced " +
    "with ones that follow it. The drafts appear on the deck, NOT here: never " +
    "repeat their subjects or bodies in your reply. Returns counts only.",
  inputSchema: z.object({
    instruction: z
      .string()
      .trim()
      .min(1)
      .max(2_000)
      .optional()
      .describe(
        "The user's style feedback, in their words. Omit when simply topping " +
          "up the queue.",
      ),
    count: z
      .number()
      .int()
      .min(2)
      .max(8)
      .optional()
      .describe("How many drafts to write. Defaults sensibly; usually omit."),
  }),
  execute: async (input, { experimental_context }) => {
    const ctx = ctxFrom(experimental_context);
    if (!ctx.voiceRun) return { error: NO_RUN_ERROR };

    const auth = await getSupabaseAndUser();
    if (!auth) return { error: "No authenticated session in tool context." };

    const instruction = input.instruction?.trim() || null;

    // Recorded into the run before generating, so a failed generation still
    // records what was asked and the next batch honours it.
    if (instruction) {
      ctx.writer?.write({
        type: "data-voice-instruction",
        data: { instruction },
        transient: true,
      });
    }

    // A rewrite replaces the whole queue, including the draft on screen:
    // "focus it on a discovery call" cannot be satisfied by removing cards,
    // only by writing new ones. A top-up just extends it.
    const queued = ctx.voiceRun.queued ?? 0;
    const count =
      input.count ?? (instruction ? Math.min(8, Math.max(queued, 3)) : 4);

    const result = await generateVoiceBatch(auth.supabase, {
      campaignId: ctx.voiceRun.campaignId ?? null,
      transcript: asTranscript(
        instruction
          ? {
              ...ctx.voiceRun.transcript,
              instructions: [
                ...ctx.voiceRun.transcript.instructions,
                instruction,
              ],
            }
          : ctx.voiceRun.transcript,
      ),
      count,
    });
    if (!result.ok) return { error: result.error };

    emitDrafts(ctx.writer, {
      mode: instruction ? "replace" : "append",
      drafts: result.drafts,
      persona: result.persona,
      campaignId: ctx.voiceRun.campaignId ?? null,
    });
    return {
      ok: true,
      draftCount: result.drafts.length,
      applied: instruction,
      writtenTo: result.persona?.label ?? null,
      personaNote: personaNoteFor(result.persona),
      note: "The drafts are on the deck. Do not quote them in your reply.",
    };
  },
});

export const saveVoiceProfile = tool({
  description:
    "Finish the active email-voice run: turn the judged drafts, typed feedback " +
    "and pasted samples into the rule-set every future cold email is written " +
    "with, and save it. Call when a voice-run message says the run converged or " +
    "the user asks to finish. Returns the one-line summary; the full rules " +
    "appear on the page.",
  inputSchema: z.object({}),
  execute: async (_input, { experimental_context }) => {
    const ctx = ctxFrom(experimental_context);
    if (!ctx.voiceRun) return { error: NO_RUN_ERROR };

    const auth = await getSupabaseAndUser();
    if (!auth) return { error: "No authenticated session in tool context." };

    const result = await completeVoiceRun(auth.supabase, {
      userId: auth.user.id,
      campaignId: ctx.voiceRun.campaignId ?? null,
      transcript: asTranscript(ctx.voiceRun.transcript),
    });
    if (!result.ok) return { error: result.error };

    ctx.writer?.write({
      type: "data-voice-skill",
      data: {
        instructions: result.instructions,
        summary: result.summary,
        campaignId: ctx.voiceRun.campaignId ?? null,
      },
      transient: true,
    });
    return {
      ok: true,
      saved: true,
      summary: result.summary,
      scope: ctx.voiceRun.campaignId
        ? `campaign ${ctx.voiceRun.campaignId}`
        : "user default",
    };
  },
});

export const refineEmailVoice = tool({
  description:
    "Rewrite the user's SAVED email voice from one plain-English change " +
    "('be blunter', 'stop asking for a call'), without a new swipe run. The " +
    "saved rules and the run behind them are replayed server-side, so the " +
    "sentence narrows the voice rather than replacing it. Use for an existing " +
    "voice; to build one from scratch, send the user to /email-skills.",
  inputSchema: z.object({
    instruction: z
      .string()
      .trim()
      .min(1)
      .max(2_000)
      .describe("What should change, in the user's words."),
    campaignId: z
      .string()
      .uuid()
      .nullish()
      .describe(
        "The campaign whose voice to refine. Omit for the user-level default.",
      ),
  }),
  execute: async (input, { experimental_context }) => {
    const ctx = ctxFrom(experimental_context);
    const auth = await getSupabaseAndUser();
    if (!auth) return { error: "No authenticated session in tool context." };

    const campaignId = input.campaignId ?? ctx.campaignId ?? null;
    const result = await refineVoiceProfileService(auth.supabase, {
      userId: auth.user.id,
      campaignId,
      instruction: input.instruction,
    });
    if (!result.ok) return { error: result.error };

    ctx.writer?.write({
      type: "data-voice-skill",
      data: {
        instructions: result.instructions,
        summary: result.summary,
        campaignId,
      },
      transient: true,
    });
    return {
      ok: true,
      saved: true,
      summary: result.summary,
      scope: campaignId ? `campaign ${campaignId}` : "user default",
    };
  },
});

export const getEmailVoices = tool({
  description:
    "List the user's saved email voice profiles: campaign-scoped voices and " +
    "the user-level default. ALWAYS call this before claiming a voice does or " +
    "does not exist (e.g. before sending the user to /email-skills to build " +
    "one). A campaign without its own voice falls back to the default; drafts " +
    "use generic base rules only when neither exists.",
  inputSchema: z.object({}),
  execute: async () => {
    const auth = await getSupabaseAndUser();
    if (!auth) return { error: "No authenticated session in tool context." };

    // RLS scopes rows to the signed-in user; campaign name rides along so the
    // model can answer "which campaigns have a voice" without a second call.
    const { data, error } = await auth.supabase
      .from("email_voice_profiles")
      .select("campaign_id, summary, updated_at, campaign:campaigns(name)")
      .order("updated_at", { ascending: false });
    if (error) return { error: error.message };

    const voices = (data ?? []).map((v) => ({
      scope: v.campaign_id ? "campaign" : "default",
      campaignId: (v.campaign_id as string | null) ?? null,
      campaignName:
        ((v.campaign as { name?: string } | null)?.name as string | null) ??
        null,
      summary: (v.summary as string | null) ?? null,
      updatedAt: v.updated_at as string,
    }));
    return {
      voices,
      note:
        voices.length === 0
          ? "No email voices saved yet, at any scope."
          : "A campaign without its own voice falls back to the default (scope: default).",
    };
  },
});
