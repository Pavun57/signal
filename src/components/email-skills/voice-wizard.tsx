"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ConfirmDialog } from "@/components/email-skills/confirm-dialog";
import {
  describeMove,
  InterviewMoveView,
} from "@/components/email-skills/interview-move";
import { VoiceInstructionsPanel } from "@/components/email-skills/voice-profile-view";
import { apiFetch } from "@/lib/api-fetch";
import {
  MAX_INTERVIEW_TURNS,
  type InterviewMove,
  type InterviewTurn,
  type VoiceProfile,
} from "@/lib/types/email-voice";

const STORAGE_PREFIX = "signal:voice-interview:";

/**
 * The typical length of an interview. The agent decides when it has enough
 * signal, so there is no real denominator — but an unbounded flow with no
 * sense of progress is one people abandon, so the range is stated up front and
 * the hard cap takes over if the agent runs long.
 */
/** Generous for an Opus turn (observed 4-13s) while still bounded. */
const TURN_TIMEOUT_MS = 75_000;

const TYPICAL_MIN_TURNS = 8;
const TYPICAL_MAX_TURNS = 14;

/**
 * The in-progress transcript lives in sessionStorage, not the database: an
 * unfinished interview is worth nothing to the composer, but losing eight
 * answers to an accidental reload is the fastest way to make someone give up.
 *
 * Keyed by user *and* scope. The user part stops a second account signing into
 * the same tab inheriting it; the scope part stops a campaign interview
 * resuming into the user-level default (or another campaign), which would save
 * one campaign's answers against a different one.
 */
function storageKey(userId: string, campaignId?: string | null) {
  return `${STORAGE_PREFIX}${userId}:${campaignId ?? "user"}`;
}

export function readSavedInterview(
  userId: string,
  campaignId?: string | null,
): InterviewTurn[] | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(storageKey(userId, campaignId));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length > 0
      ? (parsed as InterviewTurn[])
      : null;
  } catch {
    // A corrupt entry should cost the user a restart, not the whole page.
    return null;
  }
}

function saveInterview(
  userId: string,
  campaignId: string | null | undefined,
  transcript: InterviewTurn[],
) {
  try {
    window.sessionStorage.setItem(
      storageKey(userId, campaignId),
      JSON.stringify(transcript),
    );
  } catch {
    // Private-mode quota failures make the wizard non-resumable, not broken.
  }
}

export function clearSavedInterview(
  userId: string,
  campaignId?: string | null,
) {
  try {
    window.sessionStorage.removeItem(storageKey(userId, campaignId));
  } catch {
    // Nothing to do — the key is either gone or unreachable.
  }
}

/**
 * Seeds a refinement. The route stores the transcript that produced the
 * profile, which may or may not include the closing `complete` move; either
 * way the agent needs the rules it is being asked to change in front of it, so
 * answer the existing complete turn when there is one and synthesise it from
 * the saved profile when there isn't.
 */
export function buildRefinementTranscript(
  profile: VoiceProfile,
  instruction: string,
): InterviewTurn[] {
  const prior = profile.source_transcript ?? [];
  const last = prior[prior.length - 1];

  if (last && last.move.kind === "complete") {
    return [...prior.slice(0, -1), { move: last.move, answer: instruction }];
  }

  return [
    ...prior,
    {
      move: {
        kind: "complete",
        instructions: profile.instructions,
        summary: profile.summary ?? "",
      },
      answer: instruction,
    },
  ];
}

interface VoiceWizardProps {
  userId: string;
  /**
   * The campaign this voice is for, or null for the user-level default. Sent
   * with every turn so the agent grounds its sample emails in this campaign's
   * ICP and offering rather than whichever campaign was last touched.
   */
  campaignId?: string | null;
  /** Transcript to start from: `[]` for a fresh interview. */
  initialTranscript: InterviewTurn[];
  /** Leave the interview without accepting anything. */
  onExit: () => void;
  /** The route persisted the profile on `complete`; the page should re-read it. */
  onAccepted: () => void;
}

/**
 * Drives the interview. The transcript is the single piece of state that
 * matters: the last turn without an answer is the move on screen, and a last
 * turn *with* an answer means we owe the user the next move — which is also
 * exactly the state a restored-from-storage transcript can be in.
 */
export function VoiceWizard({
  userId,
  campaignId = null,
  initialTranscript,
  onExit,
  onAccepted,
}: VoiceWizardProps) {
  const [transcript, setTranscript] =
    useState<InterviewTurn[]>(initialTranscript);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [changeOpen, setChangeOpen] = useState(false);
  const [changeText, setChangeText] = useState("");
  const [exitOpen, setExitOpen] = useState(false);

  const mountedRef = useRef(true);
  // A ref, not the `pending` flag: state updates are async, so two fast clicks
  // can both pass a `pending === false` check before React re-renders.
  const inFlightRef = useRef(false);
  const startedRef = useRef(false);

  const currentTurn = transcript[transcript.length - 1];
  const awaitingMove = !currentTurn || currentTurn.answer !== undefined;

  const advance = useCallback(
    async (next: InterviewTurn[]) => {
      if (inFlightRef.current) return;
      inFlightRef.current = true;
      setPending(true);
      setError(null);
      // Persist the answer before the request, so a reload while the agent is
      // thinking resumes from the answered turn rather than re-asking it.
      setTranscript(next);
      saveInterview(userId, campaignId, next);

      try {
        const res = await apiFetch("/api/email-skills/interview", {
          method: "POST",
          // A turn is an LLM call, so it is slow by design — but without a
          // deadline a dropped connection leaves the spinner up forever, and
          // the only visible way out discards the interview. This lands in the
          // error card instead, which retries without losing the transcript.
          signal: AbortSignal.timeout(TURN_TIMEOUT_MS),
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            transcript: next,
            ...(campaignId ? { campaignId } : {}),
          }),
        });
        const data = await res.json().catch(() => null);
        if (!mountedRef.current) return;

        if (!res.ok || !data?.move) {
          setError(
            data?.error ??
              "The agent could not produce the next step. Nothing was lost.",
          );
          return;
        }

        const appended = [...next, { move: data.move as InterviewMove }];
        setTranscript(appended);
        saveInterview(userId, campaignId, appended);
      } catch (err) {
        if (mountedRef.current) {
          const timedOut =
            err instanceof Error &&
            (err.name === "TimeoutError" || err.name === "AbortError");
          setError(
            timedOut
              ? "That step took too long and was stopped. Nothing was lost."
              : "Could not reach the agent. Nothing was lost.",
          );
        }
      } finally {
        inFlightRef.current = false;
        if (mountedRef.current) setPending(false);
      }
    },
    [userId, campaignId],
  );

  useEffect(() => {
    mountedRef.current = true;

    // Fires once. A fresh interview has no move to render, and a restored
    // transcript whose final answer never got a reply is in the same position.
    if (!startedRef.current) {
      startedRef.current = true;
      // The first request has to fire without user input — there is nothing to
      // show until the agent hands over a move.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (awaitingMove) advance(transcript);
    }

    return () => {
      mountedRef.current = false;
    };
  }, [advance, awaitingMove, transcript]);

  const handleAnswer = (answer: string) => {
    if (pending || !currentTurn || currentTurn.answer !== undefined) return;
    advance([...transcript.slice(0, -1), { ...currentTurn, answer }]);
  };

  const handleAccept = () => {
    clearSavedInterview(userId, campaignId);
    toast.success("Your email voice is saved");
    onAccepted();
  };

  const handleChange = () => {
    const trimmed = changeText.trim();
    if (!trimmed) return;
    setChangeOpen(false);
    setChangeText("");
    handleAnswer(trimmed);
  };

  // Questions asked so far; the closing `complete` move isn't one of them.
  const askedCount = transcript.filter(
    (turn) => turn.move.kind !== "complete",
  ).length;
  // Only "complete" once the move is actually on screen unanswered. After
  // "Send change" the turn is answered and a request is in flight, and the
  // header would otherwise read "Done" over a spinner.
  const complete =
    currentTurn?.move.kind === "complete" && currentTurn.answer === undefined
      ? currentTurn.move
      : null;

  // Answering a move unmounts it and a different card mounts seconds later. A
  // screen reader is told nothing by that swap unless the region already exists
  // in the DOM, so this one is always mounted and only its text changes.
  const liveMessage = error
    ? `Something went wrong: ${error}`
    : pending
      ? "Working out the next step."
      : complete
        ? "Your email voice is ready to review."
        : currentTurn
          ? describeMove(currentTurn.move)
          : "";

  return (
    <div className="space-y-5">
      <div role="status" aria-live="polite" className="sr-only">
        {liveMessage}
      </div>
      <ProgressHeader
        askedCount={askedCount}
        complete={!!complete}
        onExit={() => setExitOpen(true)}
      />

      {error ? (
        <div
          role="alert"
          className="border-destructive/30 bg-destructive/5 space-y-3 rounded-xl border p-5"
        >
          <div className="flex items-start gap-2.5">
            <AlertTriangle className="text-destructive mt-0.5 size-4 shrink-0" />
            <div className="space-y-1">
              <p className="text-destructive text-sm font-medium">
                That step didn&apos;t go through
              </p>
              <p className="text-muted-foreground text-sm">{error}</p>
            </div>
          </div>
          <div className="flex gap-2">
            {/* Retrying re-posts the same transcript, so the answer the user
                already gave is not asked for a second time. */}
            <Button onClick={() => advance(transcript)}>Try again</Button>
            <Button variant="ghost" onClick={() => setExitOpen(true)}>
              Leave the interview
            </Button>
          </div>
        </div>
      ) : pending ? (
        <div
          aria-live="polite"
          className="border-border bg-card flex items-start gap-2.5 rounded-xl border p-5"
        >
          <Loader2 className="text-muted-foreground mt-0.5 size-4 shrink-0 animate-spin" />
          <div className="space-y-1">
            <p className="text-sm font-medium">
              {askedCount === 0
                ? "Getting the first question ready"
                : "Working out what to ask next"}
            </p>
            <p className="text-muted-foreground text-sm">
              The agent writes each step against your live campaign, so this
              takes a few seconds.
            </p>
          </div>
        </div>
      ) : complete ? (
        <div className="border-border bg-card space-y-5 rounded-xl border p-5">
          <div className="space-y-1">
            <p className="type-header">Here is your email voice</p>
            <p className="text-muted-foreground text-sm">
              Read it over. This is what every cold email the agent drafts gets
              written through.
            </p>
          </div>

          <VoiceInstructionsPanel
            instructions={complete.instructions}
            summary={complete.summary}
          />

          {changeOpen ? (
            <div className="border-border space-y-3 rounded-lg border p-4">
              <label
                htmlFor="voice-change"
                className="text-foreground block text-sm font-medium"
              >
                What should be different?
              </label>
              <Textarea
                id="voice-change"
                value={changeText}
                onChange={(e) => setChangeText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    handleChange();
                  }
                }}
                rows={3}
                autoFocus
                placeholder="For example: drop the compliment in the opener, and never use the word partner."
              />
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-muted-foreground text-xs">
                  Describe it in your own words — the agent rewrites the rules.
                </p>
                <div className="flex gap-2">
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setChangeOpen(false);
                      setChangeText("");
                    }}
                  >
                    Cancel
                  </Button>
                  <Button disabled={!changeText.trim()} onClick={handleChange}>
                    Send change
                  </Button>
                </div>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              <Button size="lg" onClick={handleAccept}>
                Accept
              </Button>
              <Button
                variant="outline"
                size="lg"
                onClick={() => setChangeOpen(true)}
              >
                Change something
              </Button>
            </div>
          )}
        </div>
      ) : currentTurn ? (
        // Keyed on the turn so each new move gets a fresh input rather than
        // inheriting the previous answer's draft text.
        <InterviewMoveView
          key={transcript.length}
          move={currentTurn.move}
          disabled={pending}
          onAnswer={handleAnswer}
        />
      ) : null}

      <ConfirmDialog
        open={exitOpen}
        onOpenChange={setExitOpen}
        title={complete ? "Close the review?" : "Leave the interview?"}
        description={
          complete
            ? // The route saves the profile the moment it generates one, so
              // leaving the review does not throw the voice away.
              "The generated voice is already saved, so this only closes the review. You can refine or rebuild it at any time."
            : "Your answers so far are discarded, and next time the interview starts from the first question again."
        }
        confirmLabel={complete ? "Close review" : "Discard and leave"}
        cancelLabel={complete ? "Keep reviewing" : "Keep going"}
        variant={complete ? "default" : "destructive"}
        onConfirm={() => {
          clearSavedInterview(userId, campaignId);
          onExit();
        }}
      />
    </div>
  );
}

function ProgressHeader({
  askedCount,
  complete,
  onExit,
}: {
  askedCount: number;
  complete: boolean;
  onExit: () => void;
}) {
  const label = complete
    ? "Done — review your voice below"
    : askedCount === 0
      ? `Starting — usually ${TYPICAL_MIN_TURNS} to ${TYPICAL_MAX_TURNS} questions`
      : askedCount > TYPICAL_MAX_TURNS
        ? `Question ${askedCount} of at most ${MAX_INTERVIEW_TURNS}`
        : `Question ${askedCount} — usually ${TYPICAL_MIN_TURNS} to ${TYPICAL_MAX_TURNS} in total`;

  // Held short of full until the agent actually finishes, so the bar never
  // claims to be done while another question is coming.
  const percent = complete
    ? 100
    : Math.min(92, Math.round((askedCount / TYPICAL_MAX_TURNS) * 100));

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <p className="text-muted-foreground text-xs font-medium">{label}</p>
        <Button variant="ghost" size="sm" onClick={onExit}>
          Exit
        </Button>
      </div>
      <div
        role="progressbar"
        aria-label="Interview progress"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        className="bg-muted h-1 w-full overflow-hidden rounded-full"
      >
        <div
          className="bg-primary h-full rounded-full transition-[width] duration-300"
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}
