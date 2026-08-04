"use client";

import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { useVoiceRun } from "@/lib/voice-run-context";
import type { RunDraft } from "@/lib/email-skills/swipe-run";
import {
  MAX_JUDGED,
  MIN_JUDGED,
  STALL_STREAK,
  STALL_TURNS,
  TARGET_RATE,
  WINDOW,
  converged,
  deriveRules,
  needed,
  readSeconds,
  rolling,
  streak,
  type SwipeEmail,
  type Verdict,
} from "@/lib/voice-swipe";

/**
 * The swipe deck. Renders drafts and records judgements; everything
 * conversational happens in the agent panel beside it, through the shared run
 * in voice-run-context. The deck asks for drafts by queueing chat messages
 * (the provider does the queueing) and the drafts come back down the message
 * stream, so there is exactly one chat in the app.
 */

interface Stall {
  reason: "streak" | "turns";
  n: number;
}

/**
 * Quick answers phrased as instructions rather than labels, so they run
 * through exactly the pipeline a typed message does. A prompt that asks what
 * is wrong and then changes nothing is worse than no prompt at all.
 */
const STALL_QUICK = [
  "They're all too long",
  "Too salesy",
  "Too formal",
  "Never open with a compliment",
  "None of them sound like me",
];

/**
 * Measurements ported verbatim from the published prototype rather than
 * re-approximated in Tailwind scale steps, which is where the drift came from:
 * p-5 for 22px, text-xs for 0.6875rem, and a /25 alpha border for a solid
 * #d8d3d4 all read as "close enough" in isolation and compound into a
 * different component. Arbitrary values here are deliberate.
 */
const PANE_DECK = "bg-card p-[26px]";
const CARD = "rounded-[calc(var(--radius)+2px)] p-[26px_26px_22px]";
/** The prototype's `--divider`, now a real token in globals.css. */
const BORDER_STRONG = "border-border-strong";

function toEmail(d: RunDraft): SwipeEmail {
  return {
    id: d.id,
    subject: d.subject,
    body: d.body,
    words: d.body.trim().split(/\s+/).filter(Boolean).length,
    attrs: d.axes,
  };
}

export function VoiceSwipe({
  campaignId = null,
  onDone,
}: {
  campaignId?: string | null;
  /** Called when the user leaves a finished run (the voice is saved). */
  onDone?: () => void;
}) {
  const {
    run,
    pending,
    error,
    beginRun,
    resumeRun,
    updateRun,
    requestMoreDrafts,
    sendInstruction,
    requestSave,
    endRun,
  } = useVoiceRun();

  const [leaving, setLeaving] = useState<"left" | "right" | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [stall, setStall] = useState<Stall | null>(null);
  const [stallAt, setStallAt] = useState(0);
  const [turnCheck, setTurnCheck] = useState(STALL_TURNS);
  /** "Finish with what you have" from the stall prompt. */
  const [finished, setFinished] = useState(false);
  const busy = useRef(false);
  const saveAskedRef = useRef(false);

  // Pick up (only) this scope's run after a reload. A campaign run must never
  // resume into the user-level default; the provider enforces the scope.
  useEffect(() => {
    resumeRun(campaignId);
  }, [campaignId, resumeRun]);

  const queue = (run?.queue ?? []).map(toEmail);
  const judgedEmails: SwipeEmail[] = (run?.judged ?? []).map((d, i) => ({
    id: `j${i}`,
    subject: d.subject,
    body: d.body,
    words: d.body.trim().split(/\s+/).filter(Boolean).length,
    attrs: d.axes,
  }));
  const verdicts: Verdict[] = (run?.judged ?? []).map((d, i) => ({
    id: `j${i}`,
    liked: d.kept,
  }));
  const kept = judgedEmails.filter((_, i) => verdicts[i]?.liked);
  const passed = judgedEmails.filter((_, i) => !verdicts[i]?.liked);
  const roll = rolling(verdicts);
  const hasOpened = judgedEmails.length > 0 || queue.length > 0;

  const nowConverged = converged(verdicts);
  const outOfRoad =
    hasOpened &&
    queue.length === 0 &&
    !pending &&
    !error &&
    judgedEmails.length >= MAX_JUDGED;
  const done =
    finished || nowConverged || outOfRoad || Boolean(run?.skill) || false;

  /**
   * Top-up. Fires at 1 card remaining rather than 0, so the next batch is
   * usually warm by the time it is reached. The provider ignores the request
   * if one is already in flight.
   */
  useEffect(() => {
    if (!run || pending || stall || error || done) return;
    if (queue.length > 1) return;
    if (judgedEmails.length === 0 || judgedEmails.length >= MAX_JUDGED) return;
    requestMoreDrafts();
  }, [
    run,
    queue.length,
    judgedEmails.length,
    pending,
    stall,
    error,
    done,
    requestMoreDrafts,
  ]);

  /**
   * The point of the whole run: turn it into a skill the composer applies to
   * every future email. Asked for once; a failed save surfaces on the result
   * screen with a retry rather than re-firing forever.
   */
  useEffect(() => {
    if (!run || !done || run.skill || saveAskedRef.current) return;
    if (judgedEmails.length === 0) return;
    saveAskedRef.current = true;
    requestSave();
  }, [run, done, judgedEmails.length, requestSave]);

  // Memoized by the React Compiler; a manual useCallback here could not be
  // preserved by it and blocked the whole file from compiling.
  const commit = (liked: boolean) => {
    if (busy.current || done || stall || pending || !run?.queue.length) {
      return;
    }
    busy.current = true;
    setHelpOpen(false);
    setLeaving(liked ? "right" : "left");

    const card = run.queue[0];
    const nextJudgedCount = run.judged.length + 1;
    const nextVerdicts: Verdict[] = [
      ...run.judged.map((d, i) => ({ id: `j${i}`, liked: d.kept })),
      { id: card.id, liked },
    ];

    window.setTimeout(() => {
      updateRun((r) => ({
        ...r,
        judged: [
          ...r.judged,
          {
            subject: card.subject,
            body: card.body,
            axes: card.axes,
            kept: liked,
          },
        ],
        queue: r.queue.filter((d) => d.id !== card.id),
      }));
      setLeaving(null);

      // Stall checks. Re-arm rather than re-fire: the streak is still long
      // right after the prompt is answered.
      if (!converged(nextVerdicts)) {
        const s = streak(nextVerdicts);
        if (s >= STALL_STREAK && nextJudgedCount - stallAt >= STALL_STREAK) {
          setStall({ reason: "streak", n: s });
          setStallAt(nextJudgedCount);
        } else if (nextJudgedCount >= turnCheck) {
          setStall({ reason: "turns", n: nextJudgedCount });
          setStallAt(nextJudgedCount);
          setTurnCheck((t) => t + STALL_TURNS);
        }
      }

      busy.current = false;
    }, 300);
  };

  // ── Keyboard ──────────────────────────────────────────────────────────────
  // The listener reads `commit` through a ref so the subscription survives
  // re-renders instead of tearing down on every swipe.
  const commitRef = useRef(commit);
  useEffect(() => {
    commitRef.current = commit;
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setHelpOpen(false);
        setStall(null);
        return;
      }
      const t = e.target as HTMLElement | null;
      if (t?.tagName === "TEXTAREA" || t?.tagName === "INPUT") return;
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        commitRef.current(false);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        commitRef.current(true);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  if (!run) {
    return (
      <SamplesStep
        onUse={(text) => beginRun(campaignId, [text])}
        onSkip={() => beginRun(campaignId, [])}
      />
    );
  }

  if (done && judgedEmails.length > 0) {
    return (
      <Result
        converged={nowConverged}
        roll={roll}
        judged={judgedEmails.length}
        kept={kept}
        passed={passed}
        comments={run.instructions}
        skill={run.skill}
        saving={pending === "save"}
        saveError={run.skill ? null : error}
        onRetrySave={() => requestSave()}
        onDone={
          onDone
            ? () => {
                endRun();
                onDone();
              }
            : undefined
        }
        onStartOver={() => {
          saveAskedRef.current = false;
          setFinished(false);
          endRun();
        }}
      />
    );
  }

  const card: SwipeEmail | undefined = queue[0];
  const behind = queue.slice(1, 3);
  const tallest = queue.length
    ? queue.reduce((a, b) => (b.body.length > a.body.length ? b : a), queue[0])
    : undefined;

  return (
    <div className={cn("overflow-hidden rounded-xl border", BORDER_STRONG)}>
      <div className={PANE_DECK}>
        {/* Deck-level states are shown in place of the cards rather than
            behind them: a stale draft under a spinner invites judging the
            old one. */}
        {pending || error || !card ? (
          <DeckState
            mode={
              pending === "opening"
                ? "opening"
                : pending
                  ? "rewriting"
                  : "error"
            }
            error={error}
            onRetry={() => {
              if (judgedEmails.length === 0 && queue.length === 0) {
                // Nothing to lose: restart the run with the same samples.
                beginRun(campaignId, run.samples);
              } else {
                requestMoreDrafts();
              }
            }}
          />
        ) : (
          <>
            <Progress
              index={judgedEmails.length + 1}
              roll={roll}
              judged={judgedEmails.length}
              helpOpen={helpOpen}
              onToggleHelp={() => setHelpOpen((v) => !v)}
            />

            {/* Announced on every card change: swapping one card for another
                announces nothing on its own. */}
            <p aria-live="polite" className="sr-only">
              Email {judgedEmails.length + 1}: {card.subject}. {card.words}{" "}
              words.
            </p>

            <div className="mt-5 grid">
              {/* Hidden sizer pins the deck to the tallest draft, so it
                  doesn't resize under you when a long email follows a short
                  one. */}
              {tallest && (
                <Card
                  email={tallest}
                  to={run.recipientLabel}
                  className="invisible"
                  aria-hidden
                />
              )}
              {behind
                .slice()
                .reverse()
                .map((e, i) => (
                  <Card
                    key={e.id}
                    email={e}
                    to={run.recipientLabel}
                    aria-hidden
                    className={
                      behind.length - i === 1
                        ? "z-[1] scale-[0.965] translate-y-3"
                        : "z-0 scale-[0.93] translate-y-6"
                    }
                  />
                ))}
              <Card
                // Without a key React reuses this node for the incoming
                // draft, so it inherits the outgoing card's transform and
                // slides back in from off-screen carrying the NEW content.
                // That is what made the swipe feel wrong.
                key={card.id}
                email={card}
                to={run.recipientLabel}
                className={cn(
                  // transition-all, not transition-transform: the opacity in
                  // the leaving classes was never animated, so the card
                  // vanished at full opacity mid-flight.
                  "z-[2] transition-all duration-300 ease-out",
                  leaving === "right" &&
                    "translate-x-[125%] rotate-[11deg] opacity-0",
                  leaving === "left" &&
                    "-translate-x-[125%] -rotate-[11deg] opacity-0",
                )}
              />
            </div>

            {stall ? (
              <StallPrompt
                stall={stall}
                onSend={(text) => {
                  setStall(null);
                  sendInstruction(text);
                }}
                onSkip={() => setStall(null)}
                onFinish={() => {
                  setStall(null);
                  setFinished(true);
                }}
              />
            ) : (
              <>
                <div className="mt-5 flex gap-2.5">
                  <Button
                    variant="outline"
                    className="flex-1"
                    onClick={() => commit(false)}
                  >
                    Not me
                  </Button>
                  <Button
                    variant="outline"
                    className="flex-1"
                    onClick={() => commit(true)}
                  >
                    Sounds like me
                  </Button>
                </div>
                <p className="text-muted-foreground mt-3 text-center text-[0.75rem]">
                  Use ← → , or tell the agent what&apos;s off and it rewrites
                  the rest.
                </p>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Before the first batch, not after: their own writing is the highest-fidelity
 * voice signal there is, and every draft written before it lands is written
 * blind. Skipping is stated as a normal path rather than buried as a way out:
 * most people have nothing to hand, and a step that reads as a requirement is
 * a step people abandon the whole flow at.
 */
function SamplesStep({
  onUse,
  onSkip,
}: {
  onUse: (text: string) => void;
  onSkip: () => void;
}) {
  const [value, setValue] = useState("");
  const trimmed = value.trim();

  return (
    <div
      className={cn(
        "mx-auto flex w-full max-w-2xl flex-col gap-4 rounded-xl border",
        PANE_DECK,
        BORDER_STRONG,
      )}
    >
      <div className="flex flex-col gap-1.5">
        <label
          htmlFor="swipe-samples"
          className="block text-[1.0625rem] leading-snug font-medium tracking-tight"
        >
          Have you got a cold email you have actually sent?
        </label>
        <p className="text-muted-foreground text-sm leading-relaxed">
          Your own writing tells me more than any number of swipes can, so the
          first drafts come back sounding close to you instead of starting from
          nothing.
        </p>
      </div>
      <Textarea
        id="swipe-samples"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        rows={10}
        autoFocus
        // The transcript schema rejects a sample over 20k chars. Capping here
        // stops a long paste from dying as a validation error later.
        maxLength={20_000}
        placeholder="Paste one or more emails you have actually sent. Subject lines help too."
      />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-muted-foreground text-xs">
          Nothing to paste? Skip it. The swipes on their own are enough.
        </p>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={onSkip}>
            Skip this step
          </Button>
          <Button disabled={!trimmed} onClick={() => onUse(trimmed)}>
            Use these samples
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * What the deck shows when there is no card: the model writing, or the
 * failure that stopped it.
 */
function DeckState({
  mode,
  error,
  onRetry,
}: {
  mode: "opening" | "rewriting" | "error";
  error: string | null;
  onRetry: () => void;
}) {
  if (mode === "error") {
    return (
      <div
        role="alert"
        className="flex min-h-[420px] flex-col items-start justify-center gap-3"
      >
        <p className="text-sm font-medium">That didn&apos;t go through</p>
        <p className="text-muted-foreground max-w-[52ch] text-sm">
          {error ?? "The agent could not write the next drafts."}
        </p>
        <Button size="sm" onClick={onRetry}>
          Try again
        </Button>
      </div>
    );
  }

  return (
    <div
      role="status"
      aria-live="polite"
      className="flex min-h-[420px] flex-col items-start justify-center gap-4"
    >
      <div className="flex items-center gap-2.5">
        <span
          aria-hidden
          className="border-muted-foreground/30 border-t-foreground size-4 animate-spin rounded-full border-2"
        />
        <p className="text-sm font-medium">
          {mode === "opening"
            ? "The agent is writing your first drafts"
            : "Rewriting to match what you said"}
        </p>
      </div>
      <p className="text-muted-foreground max-w-[52ch] text-sm leading-relaxed">
        {mode === "opening"
          ? "Six emails, deliberately different from each other, so that keeping one tells me something. The agent narrates in the panel."
          : "Applying it to this draft and the ones behind it. Takes a few seconds."}
      </p>
      {/* Skeleton at the measure the real card uses, so the swap doesn't jump. */}
      <div className="flex w-full max-w-[64ch] flex-col gap-2.5 pt-1">
        {[92, 78, 96, 61, 84, 44].map((w, i) => (
          <span
            key={i}
            className="bg-muted h-3 animate-pulse rounded"
            style={{ width: `${w}%`, animationDelay: `${i * 90}ms` }}
          />
        ))}
      </div>
    </div>
  );
}

function Progress({
  index,
  roll,
  judged,
  helpOpen,
  onToggleHelp,
}: {
  index: number;
  roll: { kept: number; of: number };
  judged: number;
  helpOpen: boolean;
  onToggleHelp: () => void;
}) {
  const need = needed();
  const line =
    judged < MIN_JUDGED
      ? `Ends when you keep ${need} of any ${WINDOW} in a row, ${MIN_JUDGED - judged} more before that can happen.`
      : roll.of < WINDOW
        ? `Ends when you keep ${need} of any ${WINDOW} in a row.`
        : roll.kept >= need
          ? `That's it: ${roll.kept} of ${WINDOW}.`
          : need - roll.kept === 1
            ? `Keeping ${roll.kept} of the last ${WINDOW}. One more and it's done.`
            : `Keeping ${roll.kept} of the last ${WINDOW}. ${need - roll.kept} more to go.`;

  const pct = Math.min(
    100,
    Math.round((roll.kept / WINDOW / TARGET_RATE) * 100),
  );

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3">
        <span className="text-muted-foreground text-xs tabular-nums">
          Email {index}
        </span>
        <div className="flex items-center gap-2.5">
          <span className="text-muted-foreground text-xs tabular-nums">
            {roll.kept} of last {roll.of} kept
          </span>
          <div className="relative flex">
            <button
              type="button"
              aria-expanded={helpOpen}
              aria-label="How this works"
              onClick={onToggleHelp}
              className="border-muted-foreground/40 text-muted-foreground hover:text-foreground grid size-[18px] place-items-center rounded-full border text-[0.6875rem] font-medium"
            >
              ?
            </button>
            {helpOpen && (
              <div
                role="tooltip"
                className={cn(
                  "bg-card absolute top-[calc(100%+7px)] right-0 z-20 flex w-60 flex-col gap-2 rounded-md border p-3 shadow-lg",
                  BORDER_STRONG,
                )}
              >
                <p className="text-muted-foreground text-xs leading-snug">
                  <b className="text-foreground font-medium">Keep</b> the ones
                  that sound like something you&apos;d have written.{" "}
                  <b className="text-foreground font-medium">Pass</b> on the
                  rest.
                </p>
                <p className="text-muted-foreground text-xs leading-snug">
                  Tell the agent anything a swipe can&apos;t, like “never open
                  with a compliment”, and it rewrites what&apos;s still to come.
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
      <div
        role="progressbar"
        aria-label="Progress toward a settled voice"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        className="bg-muted h-[3px] overflow-hidden rounded-full"
      >
        <div
          className="bg-primary h-full rounded-full transition-[width] duration-300"
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className="text-muted-foreground text-[0.6875rem] leading-snug">
        {line}
      </p>
    </div>
  );
}

function Card({
  email,
  to,
  className,
  ...rest
}: {
  email: SwipeEmail;
  /** The run's real prospect. Null when there was nobody to write about. */
  to?: string | null;
} & React.HTMLAttributes<HTMLElement>) {
  return (
    <article
      {...rest}
      className={cn(
        "bg-card col-start-1 row-start-1 flex flex-col overflow-hidden border",
        CARD,
        BORDER_STRONG,
        className,
      )}
    >
      <span className="text-muted-foreground mb-3.5 text-[0.8125rem]">
        To {to ?? "a prospect in this campaign"}
      </span>
      <h3 className="mb-3.5 text-[1.1875rem] leading-[1.35] font-medium tracking-tight text-balance">
        {email.subject}
      </h3>
      <p className="max-w-[64ch] flex-1 text-[1rem] leading-[1.75] whitespace-pre-wrap">
        {email.body}
      </p>
      <p className="border-border text-muted-foreground mt-4 border-t pt-3 text-[0.75rem] tabular-nums">
        {email.words} words · {readSeconds(email.words)} sec read
      </p>
    </article>
  );
}

/**
 * Inline rather than a modal: the old aria-modal overlay trapped nothing and
 * hid the deck. This sits where the swipe buttons were, so it interrupts the
 * loop without hijacking the page, and the quick answers go through exactly
 * the pipeline a typed agent message does.
 */
function StallPrompt({
  stall,
  onSend,
  onSkip,
  onFinish,
}: {
  stall: Stall;
  onSend: (text: string) => void;
  onSkip: () => void;
  onFinish: () => void;
}) {
  const head =
    stall.reason === "streak"
      ? `You've passed on the last ${stall.n}.`
      : `${stall.n} emails in and none of this is landing.`;
  const sub =
    stall.reason === "streak"
      ? "I'm missing something. Pick what's wrong, or tell the agent in your own words. It's faster than swiping through more of the same."
      : "You're keeping some, but not enough to trust the pattern. What would make these right?";

  return (
    <div
      role="group"
      aria-label="The run has stalled"
      className={cn(
        "bg-background mt-5 flex flex-col gap-3 rounded-lg border p-4",
        BORDER_STRONG,
      )}
    >
      <p className="text-[0.9375rem] leading-snug font-medium">{head}</p>
      <p className="text-muted-foreground text-[0.8125rem] leading-relaxed">
        {sub}
      </p>
      <div className="flex flex-wrap gap-1.5">
        {STALL_QUICK.map((q) => (
          <button
            key={q}
            type="button"
            onClick={() => onSend(q)}
            className="border-muted-foreground/30 hover:border-muted-foreground rounded-full border px-3 py-1 text-xs"
          >
            {q}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <button
          type="button"
          onClick={onFinish}
          className="text-muted-foreground hover:text-foreground text-xs underline underline-offset-2"
        >
          Finish with what you have
        </button>
        <Button size="sm" variant="outline" onClick={onSkip}>
          Keep swiping
        </Button>
      </div>
    </div>
  );
}

function Result({
  converged: didConverge,
  roll,
  judged,
  kept,
  passed,
  comments,
  skill,
  saving,
  saveError,
  onRetrySave,
  onDone,
  onStartOver,
}: {
  converged: boolean;
  roll: { kept: number; of: number };
  judged: number;
  kept: SwipeEmail[];
  passed: SwipeEmail[];
  comments: string[];
  skill: { instructions: string; summary: string } | null;
  saving: boolean;
  saveError: string | null;
  onRetrySave: () => void;
  onDone?: () => void;
  onStartOver: () => void;
}) {
  // The model's rules are the deliverable. deriveRules is a local fallback so
  // the run still shows something if the save failed, but it is derived from
  // attribute counts, not from anything the user said, so it must never be
  // presented as the saved skill.
  const rules = skill
    ? skill.instructions.split("\n").filter((l) => l.trim())
    : deriveRules(kept, passed);
  const failed = !skill && !saving;

  return (
    <div className="max-w-2xl">
      {/* h2: the page above this already renders the h1. */}
      <h2 className="mb-2 text-[1.375rem] font-medium tracking-tight">
        {saving
          ? "Writing your voice…"
          : didConverge
            ? "That's your voice."
            : "Ran out of drafts."}
      </h2>
      {skill?.summary && (
        <p className="mb-4 text-[0.9375rem] leading-relaxed">{skill.summary}</p>
      )}
      <p
        aria-live="polite"
        className="text-muted-foreground mb-6 text-[0.9375rem] leading-relaxed"
      >
        {skill
          ? "Saved. Every cold email the agent writes from now on goes through these rules. "
          : saving
            ? "Turning the run into rules the agent will follow. "
            : failed
              ? `${saveError ? `${saveError} ` : ""}The rules have not been saved yet, so what's below is a local summary of the run, not your saved voice. `
              : didConverge
                ? `You kept ${roll.kept} of the last ${roll.of}, it's writing emails you'd send. `
                : `It didn't reach ${Math.round(TARGET_RATE * 100)}% before the drafts ran out. `}
        Built from {judged} judgement{judged === 1 ? "" : "s"}
        {comments.length
          ? ` and ${comments.length} comment${comments.length > 1 ? "s" : ""}`
          : ""}
        .
      </p>

      <div className="border-border mb-6 flex gap-6 border-y py-3.5">
        {[
          ["kept", kept.length],
          ["passed", passed.length],
          ["comments", comments.length],
        ].map(([label, n]) => (
          <div key={label as string} className="flex flex-col">
            <span className="text-xl font-medium tabular-nums">{n}</span>
            <span className="text-muted-foreground text-xs">{label}</span>
          </div>
        ))}
      </div>

      {rules.length ? (
        <ul className="mb-6 flex flex-col gap-3">
          {rules.map((r) => (
            <li key={r} className="flex gap-3 text-[0.9375rem] leading-snug">
              <span className="text-success shrink-0">✓</span>
              <span>{r}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-muted-foreground mb-6 text-[0.9375rem]">
          Too few kept to draw a pattern from. Run it again and keep at least
          two.
        </p>
      )}

      {comments.length > 0 && (
        <div className="mb-6 flex flex-col gap-2.5">
          {comments.map((c, i) => (
            <p
              key={i}
              className="border-border text-muted-foreground border-l-2 pl-3 text-[0.8125rem] leading-relaxed"
            >
              “{c}”
            </p>
          ))}
        </div>
      )}

      <div className="flex gap-2">
        {failed && (
          <Button onClick={onRetrySave} disabled={saving}>
            Try saving again
          </Button>
        )}
        {skill && onDone && <Button onClick={onDone}>Done</Button>}
        <Button
          variant={failed || (skill && onDone) ? "outline" : "default"}
          onClick={onStartOver}
          disabled={saving}
        >
          Start over
        </Button>
      </div>
    </div>
  );
}
