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
  buildRefinementTranscript,
  buildSkillPrompt,
  buildSkillSystem,
  normaliseInstructions,
  recipientLabel,
  type SavedVoice,
  type SwipeCampaign,
  type SwipePersona,
  type SwipeTranscript,
} from "@/lib/email-skills/swipe-prompts";
import { resolveRecipient } from "@/lib/email-skills/swipe-recipient";
import { getProfileForPrompt } from "@/lib/profile";
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
  // `prior` is deliberately absent. It is built server-side from the saved row
  // on a refinement; accepting it here would let a request assert that any
  // rules it liked had already been accepted.
});

/**
 * `prior` on a refinement carries a whole rule-set, so the instruction itself
 * only ever needs to be a sentence.
 */
const MAX_REFINE_INSTRUCTION_CHARS = 2_000;

const ScopeSchema = z.object({ campaignId: z.string().uuid().nullish() });

const BodySchema = z.discriminatedUnion("action", [
  ScopeSchema.extend({
    action: z.literal("next"),
    transcript: TranscriptSchema,
    count: z.number().int().min(2).max(8).optional(),
    // The person the whole run is written about, pinned by the client after the
    // opening batch resolved them. An id, never the contact's details: the
    // client may say *which* of its own contacts, and the server re-reads the
    // facts. See resolveRecipient.
    recipientPersonId: z.string().uuid().nullish(),
  }),
  ScopeSchema.extend({
    action: z.literal("complete"),
    transcript: TranscriptSchema,
    recipientPersonId: z.string().uuid().nullish(),
  }),
  ScopeSchema.extend({
    action: z.literal("refine"),
    instruction: z.string().trim().min(1).max(MAX_REFINE_INSTRUCTION_CHARS),
  }),
]);

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
  const body = parsed.data;
  const campaignId = body.campaignId ?? null;

  if (
    body.action !== "refine" &&
    JSON.stringify(body.transcript).length > MAX_TRANSCRIPT_CHARS
  ) {
    return Response.json({ error: "Transcript too large" }, { status: 413 });
  }

  // Each of these three is optional and independently absent-able. A user with
  // no profile, no campaign, or a campaign with no enriched contacts still gets
  // drafts — the prompt has a fallback for each — because being unable to write
  // anything is a worse failure than writing something generic.
  //
  // RLS scopes campaigns to the signed-in user, so an id belonging to someone
  // else resolves to nothing rather than to their data.
  const [campaignRes, profile, resolved] = await Promise.all([
    campaignId
      ? supabase
          .from("campaigns")
          .select("name, icp, offering, positioning")
          .eq("id", campaignId)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    // Same resolution the chat route uses, so a campaign with its own linked
    // profile writes as that persona rather than as the most recent one.
    getProfileForPrompt(campaignId),
    // A refinement writes no drafts, so it needs no prospect to write them
    // about, and the lookup is two queries deep.
    body.action === "refine"
      ? Promise.resolve(null)
      : resolveRecipient(supabase, campaignId, body.recipientPersonId),
  ]);

  const campaign = (campaignRes.data as SwipeCampaign | null) ?? null;
  const persona: SwipePersona = {
    sender: profile
      ? {
          name: profile.name,
          roleTitle: profile.role_title,
          companyName: profile.company_name,
          offeringSummary: profile.offering_summary,
        }
      : null,
    recipient: resolved?.recipient ?? null,
  };
  // Echoed back so the client can pin it for the rest of the run and show the
  // card's "To" line honestly.
  const recipientOut = resolved
    ? { personId: resolved.personId, label: recipientLabel(resolved.recipient) }
    : null;

  if (body.action === "next") {
    try {
      const { object } = await generateObject({
        abortSignal: llmTimeout(),
        model: anthropic(MODELS.EMAIL),
        schema: BatchSchema,
        system: buildBatchSystem(campaign, persona),
        prompt: buildBatchPrompt(body.transcript as never, body.count ?? 6),
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
      return Response.json({
        drafts: object.drafts,
        recipient: recipientOut,
      });
    } catch (err) {
      const salvaged = salvageObject(err, BatchSchema);
      if (salvaged)
        return Response.json({
          drafts: salvaged.drafts,
          recipient: recipientOut,
        });
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

  // ── complete and refine ───────────────────────────────────────────────────
  // Both write the same row from the same prompt, and differ only in where the
  // transcript comes from: a finished run, or the saved voice plus the sentence
  // saying what should be different about it.
  let transcript: SwipeTranscript;
  if (body.action === "refine") {
    const saved = supabase
      .from("email_voice_profiles")
      .select("instructions, summary, source_transcript");
    // RLS scopes the table to the signed-in user, so scope is the only filter
    // needed. `.is` rather than `.eq`, because the default voice's campaign_id
    // is NULL and `eq(null)` matches nothing.
    const { data } = await (
      campaignId
        ? saved.eq("campaign_id", campaignId)
        : saved.is("campaign_id", null)
    ).maybeSingle();

    const existing = data as SavedVoice | null;
    if (!existing?.instructions?.trim()) {
      return Response.json(
        { error: "There is no saved voice in this scope to refine." },
        { status: 404 },
      );
    }
    transcript = buildRefinementTranscript(existing, body.instruction);
    if (JSON.stringify(transcript).length > MAX_TRANSCRIPT_CHARS) {
      // The replayed drafts are history and the change request is the point, so
      // an over-long run drops its drafts rather than refusing a refinement the
      // user has no way to make smaller.
      transcript = { ...transcript, judged: [] };
    }
  } else {
    transcript = body.transcript as unknown as SwipeTranscript;
  }

  let skill: { instructions: string; summary: string };
  try {
    const { object } = await generateObject({
      abortSignal: llmTimeout(),
      model: anthropic(MODELS.EMAIL),
      schema: SkillSchema,
      system: buildSkillSystem(campaign, persona),
      prompt: buildSkillPrompt(transcript),
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
      { error: "No usable rules came back. Nothing was saved. Try again." },
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
