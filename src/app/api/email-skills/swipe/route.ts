import { anthropic } from "@ai-sdk/anthropic";
import { generateObject } from "ai";
import { z } from "zod";

import { MODELS } from "@/lib/ai/models";
import { salvageObject } from "@/lib/ai/salvage-object";
import {
  BatchSchema,
  MAX_INSTRUCTIONS_IN_PROMPT,
  MAX_JUDGED_IN_PROMPT,
  SkillSchema,
  buildBatchPrompt,
  buildBatchSystem,
  buildSkillPrompt,
  buildSkillSystem,
  normaliseInstructions,
  type SwipeCampaign,
} from "@/lib/email-skills/swipe-prompts";
import { getSupabaseAndUser } from "@/lib/supabase/server";
import { llmTimeout } from "@/lib/utils/timeout";

export const maxDuration = 120;

/**
 * Generates the next batch of drafts, and writes the finished voice profile.
 *
 * The instructions the user types are never parsed here. They ride in the
 * transcript and are honoured by the model on the next generation, which is the
 * only way an instruction like "make it warmer" or "focus it on a 15 minute
 * discovery call" can be satisfied at all — the previous string-matching
 * attempt could only delete and reorder, so anything it didn't recognise
 * silently did nothing.
 */

// Every string is bounded. The client controls the whole body and the
// transcript is stringified straight into an Opus prompt, so unbounded fields
// would let one authenticated request push megabytes of attacker-chosen text
// through a 1M-token context window on the operator's key.
const AxesSchema = z.object({
  opener: z.string().max(20),
  tone: z.string().max(20),
  close: z.string().max(20),
  greeting: z.string().max(20),
  signoff: z.string().max(20),
});

const JudgedSchema = z.object({
  subject: z.string().max(300),
  body: z.string().max(4_000),
  axes: AxesSchema,
  kept: z.boolean(),
  notes: z
    .array(
      z.object({ phrase: z.string().max(400), note: z.string().max(1_000) }),
    )
    .max(20)
    .optional(),
});

const TranscriptSchema = z.object({
  judged: z.array(JudgedSchema).max(MAX_JUDGED_IN_PROMPT + 10),
  instructions: z
    .array(z.string().max(2_000))
    .max(MAX_INSTRUCTIONS_IN_PROMPT + 10),
});

const BodySchema = z.object({
  action: z.enum(["next", "complete"]),
  transcript: TranscriptSchema,
  campaignId: z.string().uuid().nullish(),
  count: z.number().int().min(2).max(8).optional(),
  senderName: z.string().max(120).nullish(),
  recipient: z.string().max(200).nullish(),
});

/** Ceiling on the serialised transcript, which is what actually reaches the model. */
const MAX_TRANSCRIPT_CHARS = 120_000;
const MAX_BODY_BYTES = 512 * 1024;

export async function POST(request: Request) {
  const ctx = await getSupabaseAndUser();
  if (!ctx) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { supabase, user } = ctx;

  // Checked before parsing: Route Handlers have no default body-size limit, so
  // without this a multi-megabyte POST is buffered fully into memory only to be
  // rejected by zod afterwards.
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) {
    return Response.json({ error: "Request body too large" }, { status: 413 });
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) {
    return Response.json(
      { error: parsed.error.issues.map((i) => i.message).join("; ") },
      { status: 400 },
    );
  }
  const { action, transcript, campaignId, count, senderName, recipient } =
    parsed.data;

  if (JSON.stringify(transcript).length > MAX_TRANSCRIPT_CHARS) {
    return Response.json({ error: "Transcript too large" }, { status: 413 });
  }

  // RLS scopes campaigns to the signed-in user, so an id belonging to someone
  // else resolves to nothing rather than to their data.
  let campaign: SwipeCampaign | null = null;
  if (campaignId) {
    const { data } = await supabase
      .from("campaigns")
      .select("name, icp, offering, positioning")
      .eq("id", campaignId)
      .maybeSingle();
    campaign = (data as SwipeCampaign | null) ?? null;
  }
  const persona = { senderName, recipient };

  if (action === "next") {
    try {
      const { object } = await generateObject({
        abortSignal: llmTimeout(),
        model: anthropic(MODELS.EMAIL),
        schema: BatchSchema,
        system: buildBatchSystem(campaign, persona),
        prompt: buildBatchPrompt(transcript as never, count ?? 6),
        providerOptions: {
          anthropic: {
            // Only the transcript changes between batches, so the rules and
            // campaign context read from cache after the first call.
            cacheControl: { type: "ephemeral" },
            effort: "medium",
          },
        },
        // generateWithRetry owns retrying elsewhere; leaving the SDK default of
        // 2 would stack upstream requests under a 429 storm.
        maxRetries: 0,
        // Opus 5 thinks by default and maxOutputTokens caps thinking plus
        // visible output together, so a budget sized for the text alone
        // truncates and fails generateObject outright.
        maxOutputTokens: 9_000,
      });
      return Response.json({ drafts: object.drafts });
    } catch (err) {
      const salvaged = salvageObject(err, BatchSchema);
      if (salvaged) return Response.json({ drafts: salvaged.drafts });
      return Response.json(
        {
          error:
            err instanceof Error
              ? err.message
              : "Could not write the next drafts",
        },
        { status: 500 },
      );
    }
  }

  // ── complete ──────────────────────────────────────────────────────────────
  let skill: { instructions: string; summary: string };
  try {
    const { object } = await generateObject({
      abortSignal: llmTimeout(),
      model: anthropic(MODELS.EMAIL),
      schema: SkillSchema,
      system: buildSkillSystem(campaign, persona),
      prompt: buildSkillPrompt(transcript as never),
      providerOptions: { anthropic: { effort: "medium" } },
      maxRetries: 0,
      maxOutputTokens: 5_000,
    });
    skill = object;
  } catch (err) {
    const salvaged = salvageObject(err, SkillSchema);
    if (!salvaged) {
      return Response.json(
        {
          error:
            err instanceof Error
              ? err.message
              : "Could not write the voice rules",
        },
        { status: 500 },
      );
    }
    skill = salvaged;
  }

  const instructions = normaliseInstructions(skill.instructions);
  if (!instructions) {
    // Saving an empty rule-set would overwrite a good profile with nothing and
    // leave the composer reporting a voice that does not exist.
    return Response.json(
      { error: "No usable rules came back. Nothing was saved — try again." },
      { status: 503 },
    );
  }

  // Same conflict target as the interview route: campaign_key is a generated
  // column collapsing a NULL campaign onto a sentinel uuid, so one unique
  // constraint covers both scopes and rebuilding overwrites rather than adding.
  const { error } = await supabase.from("email_voice_profiles").upsert(
    {
      user_id: user.id,
      campaign_id: campaignId ?? null,
      instructions,
      summary: skill.summary,
      source_transcript: transcript,
    },
    { onConflict: "user_id,campaign_key" },
  );
  if (error) {
    // The client treats a returned skill as saved; returning one after a failed
    // write would claim a profile exists when it does not.
    return Response.json({ error: error.message }, { status: 500 });
  }

  return Response.json({ instructions, summary: skill.summary });
}
