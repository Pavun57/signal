import { generateObject } from "ai";

import { getAdminClient } from "@/lib/supabase/admin";
import { apiSafeSchema } from "@/lib/ai/api-safe-schema";
import { AI_MODEL, getLLM } from "@/lib/ai/models";
import { generateWithRetry } from "@/lib/ai/salvage-object";
import { llmTimeout } from "@/lib/utils/timeout";
import {
  estimateLlmCostFromUsage,
  trackUsage,
} from "@/lib/services/cost-tracker";
import {
  buildAnalysisPrompt,
  chunk,
  computeAggregates,
  LearningAnalysisSchema,
  planLearningWrites,
  planWindowAdjustment,
  timingStatsRows,
  type EmailSample,
  type ExistingLearning,
  type SendOutcome,
} from "@/lib/services/outreach-learning";
import {
  intentRank,
  POSITIVE_INTENTS,
  type ReplyIntent,
} from "@/lib/services/reply-intent";

/** Trailing window the analysis reads. */
const WINDOW_DAYS = 90;
/** Rows loaded per user; at the 30/day cap 90 days is at most ~2700. */
const MAX_SENDS_PER_USER = 3000;
/** Guardrails: below these the numbers are pure noise. */
const MIN_SENDS = 50;
const MIN_CLASSIFIED_REPLIES = 5;
/** Winner/loser email bodies shown to the analysis. */
const MAX_SAMPLES = 5;
/**
 * A send younger than this with no reply is an unknown, not a loser: cold
 * replies land two to seven days out, and sampling yesterday's sends as
 * "got no reply" would teach the analysis from outcomes that don't exist yet.
 */
const REPLY_SETTLE_DAYS = 7;

export interface LearnPayload {
  /** Restrict to one user (testing / targeted rerun). */
  userId?: string;
  /** Bypass the minimum-data guardrails. */
  force?: boolean;
}

interface UserResult {
  userId: string;
  sends: number;
  replies: number;
  analyzed: boolean;
  writes: number;
  windowAdjusted?: boolean;
  skippedReason?: string;
}

/**
 * The weekly learning run (recurring job, 7 days).
 *
 * Per user with recent sends: joins sent_emails with classified reply
 * outcomes, rewrites outreach_timing_stats (always: the grid is visible
 * data even before any learning exists), and, when the guardrails are met,
 * has an LLM interpret the precomputed aggregates into merge operations on
 * email_learnings.
 *
 * Admin client: every read and write here MUST carry an explicit user_id
 * filter, the same discipline as email-track.ts.
 */
export async function runOutreachLearning(
  payload: LearnPayload = {},
): Promise<{ users: UserResult[] }> {
  const supabase = getAdminClient();
  const windowStart = new Date(
    Date.now() - WINDOW_DAYS * 86400_000,
  ).toISOString();

  let userIds: string[];
  if (payload.userId) {
    userIds = [payload.userId];
  } else {
    // Caps at 10000 raw rows, not distinct users: a very busy multi-tenant
    // install could miss the users past that. Same tradeoff as email-track's
    // MAX_OUTSTANDING; revisit with a distinct-users RPC if it ever bites.
    const { data, error } = await supabase
      .from("sent_emails")
      .select("user_id")
      .gte("sent_at", windowStart)
      .limit(10000);
    if (error) {
      console.error("[outreach-learn] user scan failed:", error);
      return { users: [] };
    }
    userIds = [...new Set((data ?? []).map((r) => r.user_id as string))];
  }

  const users: UserResult[] = [];
  for (const userId of userIds) {
    try {
      users.push(await learnForUser(supabase, userId, windowStart, payload));
    } catch (err) {
      // One user's failure must not break the whole run.
      console.error(`[outreach-learn] failed for user ${userId}:`, err);
      users.push({
        userId,
        sends: 0,
        replies: 0,
        analyzed: false,
        writes: 0,
        skippedReason: err instanceof Error ? err.message : "unknown error",
      });
    }
  }

  return { users };
}

async function learnForUser(
  supabase: ReturnType<typeof getAdminClient>,
  userId: string,
  windowStart: string,
  payload: LearnPayload,
): Promise<UserResult> {
  // ── load sends + outcomes ────────────────────────────────────────────────
  const { data: sends, error: sendsError } = await supabase
    .from("sent_emails")
    .select(
      "id, draft_id, sent_at, sent_local_hour, sent_weekday, step_number, sequence_id, campaign_id, status, features",
    )
    .eq("user_id", userId)
    .gte("sent_at", windowStart)
    .order("sent_at", { ascending: false })
    .limit(MAX_SENDS_PER_USER);
  if (sendsError) throw new Error(`sent_emails load: ${sendsError.message}`);
  if (!sends || sends.length === 0) {
    return {
      userId,
      sends: 0,
      replies: 0,
      analyzed: false,
      writes: 0,
      skippedReason: "no sends in window",
    };
  }

  // Chunked: .in() lists ride in the URL, and thousands of UUIDs blow the
  // proxy limit for exactly the users who clear the guardrails below.
  const sentIds = sends.map((s) => s.id as string);
  const replies: Array<{
    sent_email_id: string;
    kind: string;
    intent: string | null;
  }> = [];
  for (const ids of chunk(sentIds)) {
    const { data, error: repliesError } = await supabase
      .from("email_replies")
      .select("sent_email_id, kind, intent")
      .eq("user_id", userId)
      .in("sent_email_id", ids);
    if (repliesError)
      throw new Error(`email_replies load: ${repliesError.message}`);
    replies.push(...((data ?? []) as typeof replies));
  }

  // Best intent per send: positive beats neutral beats ooo, so one thread
  // with an OOO and then a real answer counts as the real answer.
  const intentBySend = new Map<string, ReplyIntent>();
  const bouncedSends = new Set<string>();
  for (const r of replies) {
    const sendId = r.sent_email_id as string;
    if (r.kind === "bounce") {
      bouncedSends.add(sendId);
      continue;
    }
    const intent = r.intent as ReplyIntent | null;
    if (!intent) continue;
    const current = intentBySend.get(sendId);
    if (!current || intentRank(intent) > intentRank(current)) {
      intentBySend.set(sendId, intent);
    }
  }

  // Signal names for the by-signal aggregate (sequence → trigger signal).
  const sequenceIds = [
    ...new Set(
      sends.map((s) => s.sequence_id as string | null).filter(Boolean),
    ),
  ] as string[];
  const signalNameBySequence = new Map<string, string>();
  if (sequenceIds.length > 0) {
    const { data: seqs } = await supabase
      .from("sequences")
      .select("id, trigger_signal_id, signals(name)")
      .eq("user_id", userId)
      .in("id", sequenceIds);
    for (const seq of seqs ?? []) {
      const signal = Array.isArray(seq.signals) ? seq.signals[0] : seq.signals;
      if (signal?.name) {
        signalNameBySequence.set(seq.id as string, signal.name as string);
      }
    }
  }

  const outcomes: SendOutcome[] = sends.map((s) => {
    const features = (s.features ?? {}) as Record<string, unknown>;
    return {
      id: s.id as string,
      sentLocalHour: (s.sent_local_hour as number | null) ?? null,
      sentWeekday: (s.sent_weekday as number | null) ?? null,
      stepNumber: (s.step_number as number | null) ?? null,
      campaignId: (s.campaign_id as string | null) ?? null,
      signalName: s.sequence_id
        ? (signalNameBySequence.get(s.sequence_id as string) ?? null)
        : null,
      subjectLen:
        typeof features.subject_len === "number" ? features.subject_len : null,
      bodyWords:
        typeof features.body_words === "number" ? features.body_words : null,
      intent: intentBySend.get(s.id as string) ?? null,
      bounced: bouncedSends.has(s.id as string),
    };
  });

  const aggregates = computeAggregates(outcomes);

  // ── timing stats rewrite (always, guardrails or not) ─────────────────────
  // Upsert-then-prune, not delete-then-insert: the old order had a window
  // where the grid was empty, and an insert failure after a successful
  // delete wiped the user's timing data for a whole week while the run
  // reported clean success. Upserting keys on the table's primary key
  // (user_id, weekday, day_part), so a failure leaves last week's grid
  // intact; the prune then drops only buckets absent from this week's set.
  const statRows = timingStatsRows(userId, aggregates);
  const rewriteAt = new Date().toISOString();
  if (statRows.length > 0) {
    const { error: upsertError } = await supabase
      .from("outreach_timing_stats")
      .upsert(
        statRows.map((r) => ({ ...r, updated_at: rewriteAt })),
        { onConflict: "user_id,weekday,day_part" },
      );
    if (upsertError) {
      console.error(
        "[outreach-learn] timing stats upsert failed (previous grid kept):",
        upsertError,
      );
    } else {
      const { error: pruneError } = await supabase
        .from("outreach_timing_stats")
        .delete()
        .eq("user_id", userId)
        .lt("updated_at", rewriteAt);
      if (pruneError) {
        console.error(
          "[outreach-learn] timing stats prune failed:",
          pruneError,
        );
      }
    }
  } else {
    // No sends in the window at all: an empty grid is the truth.
    const { error: deleteError } = await supabase
      .from("outreach_timing_stats")
      .delete()
      .eq("user_id", userId);
    if (deleteError) {
      console.error(
        "[outreach-learn] timing stats delete failed:",
        deleteError,
      );
    }
  }

  // ── opt-in send-window auto-adjust ───────────────────────────────────────
  // Independent of the analysis guardrails below: it carries its own,
  // stricter ones inside planWindowAdjustment.
  const windowAdjusted = await maybeAdjustSendWindow(
    supabase,
    userId,
    outcomes,
  );

  // ── guardrails ───────────────────────────────────────────────────────────
  const classifiedReplies = aggregates.totals.replies;
  if (
    !payload.force &&
    (outcomes.length < MIN_SENDS || classifiedReplies < MIN_CLASSIFIED_REPLIES)
  ) {
    const reason = `below guardrails (${outcomes.length}/${MIN_SENDS} sends, ${classifiedReplies}/${MIN_CLASSIFIED_REPLIES} classified replies)`;
    console.log(`[outreach-learn] ${userId}: skipping analysis, ${reason}`);
    return {
      userId,
      sends: outcomes.length,
      replies: classifiedReplies,
      analyzed: false,
      writes: 0,
      windowAdjusted,
      skippedReason: reason,
    };
  }

  // ── winner / loser samples ───────────────────────────────────────────────
  const winners = await loadSamples(
    supabase,
    userId,
    outcomes.filter((o) => o.intent && POSITIVE_INTENTS.has(o.intent)),
    sends,
    (o) => `positive reply: ${o.intent}`,
  );
  const sentAtById = new Map(
    sends.map((s) => [s.id as string, s.sent_at as string]),
  );
  const settledBefore = Date.now() - REPLY_SETTLE_DAYS * 86400_000;
  const losers = await loadSamples(
    supabase,
    userId,
    outcomes.filter((o) => {
      if (o.intent || o.bounced) return false;
      const sentAt = sentAtById.get(o.id);
      return sentAt ? new Date(sentAt).getTime() < settledBefore : false;
    }),
    sends,
    () => "no reply",
  );

  // ── existing learnings ───────────────────────────────────────────────────
  const { data: learningRows, error: learningsError } = await supabase
    .from("email_learnings")
    .select("id, category, statement, confidence, status")
    .eq("user_id", userId);
  if (learningsError) {
    throw new Error(`email_learnings load: ${learningsError.message}`);
  }
  const existing = (learningRows ?? []) as ExistingLearning[];

  // ── analysis ─────────────────────────────────────────────────────────────
  // Timing rows are machine-written audit records (window moves); keeping
  // them out of the prompt means the analysis can never revise one and
  // destroy the old-window evidence it exists to preserve.
  const prompt = buildAnalysisPrompt({
    aggregates,
    winners,
    losers,
    existing: existing.filter(
      (l) => l.status === "active" && l.category !== "timing",
    ),
    dismissed: existing
      .filter((l) => l.status === "user_dismissed")
      .map((l) => l.statement),
  });

  const result = await generateWithRetry(
    async () => {
      const { object, usage } = await generateObject({
        abortSignal: llmTimeout(),
        model: getLLM(),
        schema: apiSafeSchema(LearningAnalysisSchema),
        prompt,
      });
      trackUsage({
        service: "llm",
        operation: "outreach-learn",
        tokens_input: usage.inputTokens ?? 0,
        tokens_output: usage.outputTokens ?? 0,
        estimated_cost_usd: estimateLlmCostFromUsage(usage),
        metadata: { model: AI_MODEL, userId },
      });
      return object;
    },
    LearningAnalysisSchema,
    3,
  );
  if (!result.ok) {
    throw new Error(`analysis generation failed: ${result.error}`);
  }

  // ── apply ────────────────────────────────────────────────────────────────
  const writes = planLearningWrites(result.value.operations, existing);
  const now = new Date().toISOString();
  const windowEvidence = {
    window: { from: windowStart, to: now },
    sends: aggregates.totals.sends,
    replies: aggregates.totals.replies,
    positive: aggregates.totals.positive,
  };

  let applied = 0;
  for (const write of writes) {
    if (write.kind === "insert") {
      const { error } = await supabase.from("email_learnings").insert({
        user_id: userId,
        campaign_id: null,
        category: write.category,
        statement: write.statement,
        confidence: write.confidence,
        evidence: { ...windowEvidence, note: write.evidenceNote },
        status: "active",
        source: "analysis",
        last_evaluated_at: now,
      });
      if (error) {
        console.error("[outreach-learn] learning insert failed:", error);
        continue;
      }
    } else {
      const { error } = await supabase
        .from("email_learnings")
        .update({
          ...(write.statement ? { statement: write.statement } : {}),
          ...(write.confidence ? { confidence: write.confidence } : {}),
          ...(write.status ? { status: write.status } : {}),
          evidence: { ...windowEvidence, note: write.evidenceNote },
          last_evaluated_at: now,
        })
        .eq("id", write.id)
        .eq("user_id", userId);
      if (error) {
        console.error("[outreach-learn] learning update failed:", error);
        continue;
      }
    }
    applied++;
  }

  return {
    userId,
    sends: outcomes.length,
    replies: classifiedReplies,
    analyzed: true,
    writes: applied,
    windowAdjusted,
  };
}

/**
 * Shifts the user's send window toward the hours that earn replies, when
 * they opted in and planWindowAdjustment's guardrails clear. At most one
 * adjustment per run (the job is weekly, so per week). Requires an already
 * configured window: this shifts a schedule the user set, never invents one.
 *
 * Never touches send_timezone or send_window_scope. The inserted timing
 * learning row is the audit trail the change is judged by later.
 */
async function maybeAdjustSendWindow(
  supabase: ReturnType<typeof getAdminClient>,
  userId: string,
  outcomes: SendOutcome[],
): Promise<boolean> {
  const { data: settings, error } = await supabase
    .from("user_settings")
    .select(
      "auto_adjust_send_window, send_window_start, send_window_end, send_timezone",
    )
    .eq("user_id", userId)
    .maybeSingle();
  if (error || !settings?.auto_adjust_send_window) return false;
  if (
    settings.send_window_start === null ||
    settings.send_window_end === null ||
    !settings.send_timezone
  ) {
    return false;
  }

  const current = {
    start: settings.send_window_start as number,
    end: settings.send_window_end as number,
  };
  const adjustment = planWindowAdjustment(outcomes, current);
  if (!adjustment) return false;

  const { error: updateError } = await supabase
    .from("user_settings")
    .update({
      send_window_start: adjustment.start,
      send_window_end: adjustment.end,
    })
    .eq("user_id", userId);
  if (updateError) {
    console.error("[outreach-learn] window update failed:", updateError);
    return false;
  }

  const pct = (rate: number) => `${Math.round(rate * 1000) / 10}%`;
  const { error: auditError } = await supabase.from("email_learnings").insert({
    user_id: userId,
    campaign_id: null,
    category: "timing",
    statement: `Send window moved from ${current.start}:00-${current.end}:00 to ${adjustment.start}:00-${adjustment.end}:00: reply rate ${pct(adjustment.candidateRate)} in the new hours vs ${pct(adjustment.currentRate)} in the old window.`,
    evidence: {
      previous_window: current,
      new_window: { start: adjustment.start, end: adjustment.end },
      candidate_sends: adjustment.candidateSends,
      candidate_replies: adjustment.candidateReplies,
      candidate_rate: adjustment.candidateRate,
      previous_rate: adjustment.currentRate,
    },
    confidence: "medium",
    status: "active",
    source: "analysis",
    last_evaluated_at: new Date().toISOString(),
  });
  if (auditError) {
    console.error("[outreach-learn] window audit insert failed:", auditError);
  }
  return true;
}

/** Subject + body samples via the draft the send left from. */
async function loadSamples(
  supabase: ReturnType<typeof getAdminClient>,
  userId: string,
  candidates: SendOutcome[],
  sends: Array<Record<string, unknown>>,
  outcomeLabel: (o: SendOutcome) => string,
): Promise<EmailSample[]> {
  const draftIdBySend = new Map<string, string>();
  for (const s of sends) {
    if (s.draft_id) draftIdBySend.set(s.id as string, s.draft_id as string);
  }
  const picked = candidates
    .filter((o) => draftIdBySend.has(o.id))
    .slice(0, MAX_SAMPLES);
  if (picked.length === 0) return [];

  const { data: drafts } = await supabase
    .from("email_drafts")
    .select("id, subject, body_text")
    .eq("user_id", userId)
    .in(
      "id",
      picked.map((o) => draftIdBySend.get(o.id) as string),
    );

  const draftById = new Map((drafts ?? []).map((d) => [d.id as string, d]));
  const samples: EmailSample[] = [];
  for (const o of picked) {
    const draft = draftById.get(draftIdBySend.get(o.id) as string);
    if (!draft?.body_text) continue;
    samples.push({
      subject: (draft.subject as string) ?? "",
      bodyText: draft.body_text as string,
      outcome: outcomeLabel(o),
    });
  }
  return samples;
}
