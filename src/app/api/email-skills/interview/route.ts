import { anthropic } from "@ai-sdk/anthropic";
import { generateObject } from "ai";
import { z } from "zod";

import { MODELS } from "@/lib/ai/models";
import { salvageObject } from "@/lib/ai/salvage-object";
import { UNTRUSTED_NOTICE, wrapUntrusted } from "@/lib/prompt-safety";
import { getSupabaseAndUser } from "@/lib/supabase/server";
import {
  MAX_INTERVIEW_TURNS,
  type InterviewMove,
  type InterviewTurn,
} from "@/lib/types/email-voice";
import { llmTimeout } from "@/lib/utils/timeout";

export const maxDuration = 60;

type RlsClient = NonNullable<
  Awaited<ReturnType<typeof getSupabaseAndUser>>
>["supabase"];

interface CampaignContext {
  name: string;
  icp: unknown;
  offering: unknown;
  positioning: unknown;
}

// ── Request / response shapes ──────────────────────────────────────────────

// Every string below is bounded. The wizard only ever echoes back moves this
// route authored, but nothing enforces that — the client controls the whole
// body, and the transcript is JSON.stringify'd straight into an Opus prompt.
// Unbounded fields would let one authenticated request push megabytes of
// attacker-chosen text through a 1M-token context window, which is a bill, not
// just a slow request. Limits are generous enough that a legitimate move can
// never hit them.
const MAX_SAMPLE_CHARS = 4_000;
const MAX_PROMPT_CHARS = 2_000;
const MAX_INSTRUCTIONS_CHARS = 8_000;

const EmailSampleSchema = z.object({
  subject: z.string().max(300).describe("Subject line."),
  body: z.string().max(MAX_SAMPLE_CHARS).describe("Plain-text body."),
});

/**
 * Mirrors InterviewMove from the shared contract, discriminated on `kind`.
 * The wizard renders one branch per kind, so a free-form response would let a
 * single bad generation produce something it has no way to display. Making the
 * union the response schema means the model physically cannot return that.
 */
const InterviewMoveSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("question"),
    prompt: z
      .string()
      .max(MAX_PROMPT_CHARS)
      .describe("A single question. Never bundle two."),
    inputType: z.enum(["text", "choice"]),
    choices: z
      .array(z.string().max(200))
      .max(5)
      .optional()
      .describe("2-5 options. Required when inputType is 'choice'."),
  }),
  z.object({
    kind: z.literal("compare"),
    dimension: z
      .string()
      .max(300)
      .describe(
        'The one axis a and b differ on, e.g. "story-led vs data-led opener".',
      ),
    a: EmailSampleSchema,
    b: EmailSampleSchema,
  }),
  z.object({
    kind: z.literal("request_samples"),
    prompt: z
      .string()
      .max(MAX_PROMPT_CHARS)
      .describe("Ask the user to paste cold emails they have actually sent."),
  }),
  z.object({
    kind: z.literal("complete"),
    instructions: z
      .string()
      .max(MAX_INSTRUCTIONS_CHARS)
      .describe("Imperative rules for the drafting model, one per line."),
    summary: z.string().max(500).describe("One sentence, shown in the UI."),
  }),
]);

/**
 * What the model is actually asked for. Anthropic requires a tool's
 * input_schema to be an object, so the union cannot be the schema root — see
 * the note at the generateObject call.
 */
const InterviewResponseSchema = z.object({
  move: InterviewMoveSchema.describe("The single next move in the interview."),
});

/**
 * The turn-cap path asks for the rules only — `kind` is deliberately not a
 * field the model can set there, because at the cap `complete` is the only
 * legal move.
 */
const CompletedProfileSchema = z.object({
  instructions: z.string().min(1),
  summary: z.string().min(1),
});

/**
 * Answers carry pasted real emails so they are legitimately long, but two or
 * three of them fit well inside this. Kept in sync with the textarea's
 * maxLength so an over-long paste is prevented rather than 400'd.
 */
const MAX_ANSWER_CHARS = 8_000;

/**
 * Ceiling on the whole serialized transcript, which is what actually reaches
 * the model.
 *
 * Per-field bounds alone are not enough: they multiply. Fifty turns each
 * carrying a max-length answer and a max-length `compare` move is ~1.4MB of
 * attacker-chosen text — roughly 390k tokens into a 1M-token Opus context, on
 * the operator's key, from one request. And the expensive branch needs no
 * interview at all: a first POST with a pre-filled transcript at the turn cap
 * goes straight to `synthesiseCompletion`. There is no rate limiter anywhere in
 * this app, so the bound has to be here.
 *
 * ~120k chars is ~30k tokens, comfortably above any real interview (a full one
 * runs a few thousand chars) and two orders of magnitude below the ceiling the
 * per-field bounds allow on their own.
 */
const MAX_TRANSCRIPT_CHARS = 120_000;

/** Rejects an oversized body before it is parsed into memory at all. */
const MAX_BODY_BYTES = 256 * 1024;

// The wizard echoes back moves this route authored, so the turns are validated
// against the same union rather than waved through.
const BodySchema = z.object({
  transcript: z
    .array(
      z.object({
        move: InterviewMoveSchema,
        answer: z.string().max(MAX_ANSWER_CHARS).optional(),
      }),
    )
    // A real transcript never exceeds the cap plus the closing `complete` turn
    // and one refinement answer on top of it.
    .max(MAX_INTERVIEW_TURNS + 2),
  // Which voice is being built: a campaign's, or the user-level default when
  // absent. RLS makes an id belonging to another user resolve to no context.
  campaignId: z.string().uuid().optional(),
});

/**
 * Last resort when the forced completion comes back unusable. The cap exists
 * to guarantee the interview terminates, so this branch would rather store an
 * honest "nothing was captured" profile the user can rebuild from than keep
 * asking questions the wizard will answer and re-post forever.
 */
const CAP_FALLBACK = {
  instructions:
    "No user-specific voice rules were captured. Draft using the base rules alone.",
  summary:
    "The interview hit its turn limit before a voice emerged — rebuild to try again.",
};

// ── Prompts ────────────────────────────────────────────────────────────────

const INTERVIEW_SYSTEM_PROMPT = `You are interviewing a founder or salesperson to capture how THEY write cold emails.

What you produce is not advice for the user to read. It is a rule-set a second model will follow when it drafts their emails, so everything you learn has to end up as something another model can act on.

## Running the interview

- Ask ONE thing per move. Never bundle two questions into a single prompt.
- Adapt. Read the last answer before choosing the next move and follow up on whatever was specific or surprising in it, rather than marching through a script. When an answer is vague ("I keep it casual"), push for the concrete version: what they'd actually type.
- Use \`request_samples\` early — first or second move — whenever the user might have real emails they have sent. Their own writing is the highest-fidelity voice signal available; every question after that becomes a check on something you have already read instead of a guess.
- Prefer \`compare\` whenever a preference is easier to show than to describe. Self-reported style is unreliable: people describe how they wish they wrote, not how they write. A reaction to concrete copy can be trusted in a way that "I'm pretty direct" cannot.
- Aim to finish in 8-14 moves. Stop as soon as another question would not change the rules you are about to write — a longer interview spends the user's patience and buys nothing.

## \`compare\` moves

- The two samples must differ in EXACTLY ONE dimension, and \`dimension\` must name it: "story-led vs data-led opener", "warm vs blunt", "signal-first vs problem-first", "question close vs statement close". If they differ in two things, a pick tells you nothing about which one was picked.
- Both samples must be genuinely good. Never pair a strong email against a strawman — a user rejecting an obviously bad email teaches you nothing about their voice.
- Hold everything else steady: same rough length, same offer, same ask. Anything that varies by accident becomes a confound.
- Write them about the user's real campaign when one is given below. People react honestly to copy about their own product and politely to filler.

## The final \`complete\` move

\`instructions\` is the deliverable. Terse imperative rules, one per line, that a drafting model can follow:

- Rules about writing, not observations about the person. "Open on the signal, no greeting line" — not "she likes getting to the point".
- Only what is specific to THIS user: their register, phrasings they reuse, what they refuse to say, how they open, how they ask, how they sign off, what they are willing to admit.
- Do NOT restate generic cold-email best practice. A separate base prompt already covers body length, subject lines, one call to action, and avoiding AI tells. Repeating it wastes the drafting model's attention and buries the parts that are actually about this user.
- Quote the user's own wording wherever you have it. A rule carrying their phrases survives paraphrase better than one describing them.
- If the interview never established something, leave it out. An invented rule is worse than a missing one: it shows up in every email they send.

\`summary\` is one human-readable sentence for the UI, e.g. "Blunt and signal-first, no pleasantries, always names a number."`;

/**
 * Rules plus campaign context. Both halves are identical on every turn of an
 * interview, which is what makes the ephemeral cache worth setting: only the
 * transcript changes between moves.
 */
function buildInterviewSystemPrompt(campaign: CampaignContext | null): string {
  const context = campaign
    ? `THE USER'S CAMPAIGN — write \`compare\` samples about this offer:\n${wrapUntrusted(
        `Name: ${campaign.name}\nICP: ${JSON.stringify(campaign.icp ?? {})}\nOffering: ${JSON.stringify(campaign.offering ?? {})}\nPositioning: ${JSON.stringify(campaign.positioning ?? {})}`,
      )}`
    : `The user has no campaign yet, so you have no real offer to write about: keep \`compare\` samples plausible but generic. Do not interview them about their ICP or offering — that is captured elsewhere, and this interview is only about voice.`;

  return `${INTERVIEW_SYSTEM_PROMPT}\n\n---\n${UNTRUSTED_NOTICE}\n\n${context}`;
}

/**
 * The varying half of the prompt. Answers are wrapped as untrusted because
 * pasted "real emails" are third-party text the user never wrote, and a
 * request_samples move is an open invitation to paste anything at all.
 */
function buildTranscriptPrompt(transcript: InterviewTurn[]): string {
  if (transcript.length === 0) {
    return "The interview has not started. Return your opening move.";
  }
  return `INTERVIEW SO FAR — move ${transcript.length + 1} of at most ${MAX_INTERVIEW_TURNS}:\n${wrapUntrusted(
    JSON.stringify(transcript, null, 2),
  )}\n\nReturn your next move.`;
}

// ── Handler ────────────────────────────────────────────────────────────────

/**
 * The campaign the samples should be written about.
 *
 * With a campaignId this is the campaign the voice is being built for. Without
 * one — the user-level default voice — it falls back to the most recently
 * touched campaign purely so the samples aren't abstract, and the system prompt
 * tells the model to keep them generic in that case.
 *
 * Getting this wrong is what made a global profile learn one campaign's angle:
 * the interview grounded its samples in whichever campaign was open, then saved
 * rules like "fall back to release/changelog cadence" as the user's only voice.
 *
 * RLS scopes `campaigns` to the signed-in user, so a campaignId belonging to
 * someone else returns nothing rather than their data — no ownership check
 * needed, provided this stays on the RLS-scoped client.
 */
async function loadCampaignContext(
  supabase: RlsClient,
  campaignId?: string | null,
): Promise<CampaignContext | null> {
  const base = supabase
    .from("campaigns")
    .select("name, icp, offering, positioning");

  const { data } = campaignId
    ? await base.eq("id", campaignId).maybeSingle()
    : await base
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle();

  return (data as CampaignContext | null) ?? null;
}

/**
 * Terminal move for the turn cap — a runaway interview must still hand the
 * user a profile. The result is re-validated rather than trusted wholesale:
 * this branch is the only thing standing between a looping model and an
 * interview with no exit, so it has to yield `complete` even when the call
 * comes back shaped like something else entirely.
 */
async function synthesiseCompletion(
  transcript: InterviewTurn[],
): Promise<{ move: InterviewMove; degraded: boolean }> {
  try {
    const { object } = await generateObject({
      abortSignal: llmTimeout(),
      model: anthropic(MODELS.EMAIL),
      schema: CompletedProfileSchema,
      // UNTRUSTED_NOTICE belongs here too: buildTranscriptPrompt wraps the
      // transcript in <untrusted> tags, and without the notice explaining what
      // they mean the fencing is decoration. The transcript can contain email
      // text the user pasted from third parties.
      system: `${INTERVIEW_SYSTEM_PROMPT}\n\n${UNTRUSTED_NOTICE}\n\n---\nThe interview has hit its turn limit. Write the profile from what you already have and ask nothing further.`,
      prompt: buildTranscriptPrompt(transcript),
      providerOptions: { anthropic: { effort: "medium" } },
      // Opus 5 thinks by default and maxOutputTokens caps thinking + visible
      // output together, so a budget sized for the text alone truncates.
      maxOutputTokens: 4000,
    });
    const profile = CompletedProfileSchema.safeParse(object);
    if (profile.success) {
      return { move: { kind: "complete", ...profile.data }, degraded: false };
    }
    return { move: { kind: "complete", ...CAP_FALLBACK }, degraded: true };
  } catch (err) {
    // The same `value`-wrapper quirk the other calls hit — recover the payload
    // before writing anybody off as degraded.
    const salvaged = salvageObject(err, CompletedProfileSchema);
    if (salvaged) {
      return { move: { kind: "complete", ...salvaged }, degraded: false };
    }
    return { move: { kind: "complete", ...CAP_FALLBACK }, degraded: true };
  }
}

export async function POST(request: Request) {
  const ctx = await getSupabaseAndUser();
  if (!ctx) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { supabase, user } = ctx;

  // Checked before parsing: Route Handlers have no default body-size limit, so
  // without this a multi-megabyte POST is fully buffered into memory only to be
  // rejected by zod afterwards.
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (declaredLength > MAX_BODY_BYTES) {
    return Response.json({ error: "Request body too large" }, { status: 413 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: parsed.error.issues.map((i) => i.message).join("; ") },
      { status: 400 },
    );
  }
  const transcript: InterviewTurn[] = parsed.data.transcript;
  const campaignId = parsed.data.campaignId ?? null;

  // The per-field bounds above multiply: max-length answers and max-length
  // compare moves across every allowed turn still add up to far more prompt
  // than any real interview. This bounds what actually reaches the model.
  if (JSON.stringify(transcript).length > MAX_TRANSCRIPT_CHARS) {
    return Response.json(
      { error: "Interview transcript too large" },
      { status: 413 },
    );
  }

  let move: InterviewMove;
  // A degraded completion carries no voice rules. Persisting it would overwrite
  // a good profile with a placeholder and leave the gate reporting a voice that
  // does not exist, with the old rules and transcript unrecoverable.
  let degraded = false;
  if (transcript.length >= MAX_INTERVIEW_TURNS) {
    const synthesised = await synthesiseCompletion(transcript);
    move = synthesised.move;
    degraded = synthesised.degraded;
  } else {
    const campaign = await loadCampaignContext(supabase, campaignId);
    try {
      const { object } = await generateObject({
        abortSignal: llmTimeout(),
        model: anthropic(MODELS.EMAIL),
        // Wrapped in an object, not passed as the bare union. A discriminated
        // union at the schema root converts to a top-level `anyOf`, which has
        // no `type` — and Anthropic requires a tool's input_schema to be an
        // object, rejecting it with
        // "tools.0.custom.input_schema.type: Field required". Nesting the union
        // under a property is legal and keeps the same guarantee that the model
        // cannot return a shape the wizard can't render.
        schema: InterviewResponseSchema,
        system: buildInterviewSystemPrompt(campaign),
        prompt: buildTranscriptPrompt(transcript),
        providerOptions: {
          anthropic: {
            // Only the transcript changes between moves, so every turn after
            // the first reads the rules and campaign context from cache.
            cacheControl: { type: "ephemeral" },
            // Opus 5 thinks by default (unlike the Opus 4.6 this replaced) and
            // maxOutputTokens is a combined cap on thinking plus visible
            // output — budgets sized for the text alone now truncate, which
            // fails generateObject outright. Medium effort keeps the reasoning
            // proportionate to writing two short emails.
            effort: "medium",
          },
        },
        // A `compare` move carries two full emails; the rest are far smaller.
        // The headroom above that is for thinking.
        // generateWithRetry owns retrying. Leaving the SDK default of 2 in place
        // would stack to 12 upstream requests per email under a 429 storm.
        maxRetries: 0,
        maxOutputTokens: 6000,
      });
      move = object.move;
    } catch (err) {
      // Same `value`-wrapper quirk the composer hits — recover the payload
      // rather than dead-ending an interview the user is 8 questions into.
      const salvaged = salvageObject(err, InterviewResponseSchema);
      if (salvaged) {
        move = salvaged.move;
      } else {
        return Response.json(
          {
            error:
              err instanceof Error ? err.message : "Unknown interview error",
          },
          { status: 500 },
        );
      }
    }
  }

  if (move.kind === "complete" && degraded) {
    // Report the failure instead of saving a placeholder over a real profile.
    // The wizard keeps the transcript, so the user can retry rather than losing
    // the interview and their previous voice in one step.
    return Response.json(
      {
        error:
          "The interview ran long and the final summary could not be written. Nothing was saved — try again, or exit and rebuild.",
      },
      { status: 503 },
    );
  }

  if (move.kind === "complete") {
    // The conflict target is (user_id, campaign_key), not campaign_id:
    // campaign_key is a generated column that collapses a NULL campaign onto a
    // sentinel uuid, so one plain unique constraint covers both scopes. A
    // partial index would not work here — ON CONFLICT can't match one without
    // repeating its predicate, which this client cannot express. Either way
    // rebuilding overwrites rather than adding a row. The transcript goes in so
    // a later "make it blunter" replays the interview instead of restarting it.
    const { error } = await supabase.from("email_voice_profiles").upsert(
      {
        user_id: user.id,
        campaign_id: campaignId ?? null,
        instructions: move.instructions,
        summary: move.summary,
        source_transcript: transcript,
      },
      { onConflict: "user_id,campaign_key" },
    );
    if (error) {
      // The wizard treats a `complete` move as "saved". Returning one after a
      // failed write would tell the user their voice profile exists when it
      // does not, and the transcript is gone the moment they close the tab.
      return Response.json({ error: error.message }, { status: 500 });
    }
  }

  return Response.json({ move });
}
