"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useAuth } from "@clerk/nextjs";

import {
  clearRun,
  newRun,
  readActiveRun,
  readRun,
  saveRun,
  type RunDraft,
  type VoiceRun,
} from "@/lib/email-skills/swipe-run";
import { useCampaign } from "@/lib/campaign-context";

/**
 * Carries the voice-swipe run between the deck and the agent panel, which are
 * siblings under DashboardShell. The deck renders drafts and records swipes;
 * the panel is the conversation. The provider holds the run, hydrates it from
 * sessionStorage, and writes every change back.
 *
 * Drafts arrive from the voice tools as transient data parts on the message
 * stream; the panel forwards them here through `ingest`. Requests travel the
 * other way as auto-sent chat messages (openAgentWith), so the agent both
 * does the work and narrates it in the one thread the app already has.
 */

/** What the deck is waiting on, if anything. Drives its loading states. */
export type VoicePending = "opening" | "drafts" | "save" | null;

interface VoiceRunContextValue {
  run: VoiceRun | null;
  pending: VoicePending;
  /** Why the last request came back empty, shown on the deck with a retry. */
  error: string | null;
  /** Bumps whenever a skill save lands, so pages can refetch the profile. */
  savedTick: number;
  /** Create a run for a scope (replacing any active one) and ask the agent
   * for the opening batch. `samples` may be empty: that is a real answer. */
  beginRun: (campaignId: string | null, samples: string[]) => void;
  /** Rehydrate the run for a scope from sessionStorage, if one was saved. */
  resumeRun: (campaignId: string | null) => void;
  /** Apply a change (a swipe, usually) and persist it. */
  updateRun: (updater: (run: VoiceRun) => VoiceRun) => void;
  /** Ask the agent to top up the queue. */
  requestMoreDrafts: () => void;
  /** Send style feedback; the pending drafts get rewritten to follow it. */
  sendInstruction: (instruction: string) => void;
  /** Ask the agent to turn the run into the saved rule-set. */
  requestSave: () => void;
  /** Forget the run entirely (start over / leave). */
  endRun: () => void;
  /** Forget a specific scope's stored run without touching another scope's:
   * a rebuild must not resurrect the finished run it is replacing. */
  discardRun: (campaignId: string | null) => void;
  /** Called by the panel for every data-voice-* part on the stream. */
  ingest: (part: { type: string; data?: unknown }) => void;
  /** Called by the panel when a turn finishes, so a turn that produced no
   * drafts surfaces as a retryable error instead of an eternal spinner. */
  notifyTurnDone: () => void;
}

const VoiceRunContext = createContext<VoiceRunContextValue>({
  run: null,
  pending: null,
  error: null,
  savedTick: 0,
  beginRun: () => {},
  resumeRun: () => {},
  updateRun: () => {},
  requestMoreDrafts: () => {},
  sendInstruction: () => {},
  requestSave: () => {},
  endRun: () => {},
  discardRun: () => {},
  ingest: () => {},
  notifyTurnDone: () => {},
});

interface DraftsPart {
  mode: "opening" | "append" | "replace";
  drafts: Omit<RunDraft, "id" | "personaLabel">[];
  /** Who the batch is written to: a real campaign contact, or an invented
   * persona as the fallback. Rotates per batch. */
  persona: { label: string; real?: boolean } | null;
}

interface SkillPart {
  instructions: string;
  summary: string;
  campaignId: string | null;
}

export function VoiceRunProvider({ children }: { children: ReactNode }) {
  const { userId } = useAuth();
  const { openAgentWith } = useCampaign();

  const [run, setRun] = useState<VoiceRun | null>(null);
  const [pending, setPending] = useState<VoicePending>(null);
  const [error, setError] = useState<string | null>(null);
  const [savedTick, setSavedTick] = useState(0);

  // The authoritative copy of the run, mutated only inside callbacks. State
  // mirrors it for rendering. A ref rather than reading state back, because
  // two stream parts can land in the same tick (an instruction, then the
  // drafts) and the second must see the first's write, which state cannot
  // guarantee before a re-render.
  const runRef = useRef<VoiceRun | null>(null);
  const pendingRef = useRef<VoicePending>(null);

  const setPendingBoth = useCallback((next: VoicePending) => {
    pendingRef.current = next;
    setPending(next);
  }, []);

  const persist = useCallback(
    (next: VoiceRun | null) => {
      runRef.current = next;
      setRun(next);
      if (userId && next) saveRun(userId, next);
    },
    [userId],
  );

  // Rehydrate whichever scope was mid-run when the tab last navigated. Keyed
  // on userId: there is nothing to look up until Clerk says who this is.
  const hydratedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!userId || hydratedRef.current === userId) return;
    hydratedRef.current = userId;
    const saved = readActiveRun(userId);
    if (saved) {
      runRef.current = saved;
      // Hydration from an external store is what this effect is for.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setRun(saved);
    }
  }, [userId]);

  const updateRun = useCallback(
    (updater: (r: VoiceRun) => VoiceRun) => {
      const current = runRef.current;
      if (!current) return;
      persist(updater(current));
    },
    [persist],
  );

  const beginRun = useCallback(
    (campaignId: string | null, samples: string[]) => {
      persist(newRun(campaignId, samples));
      setError(null);
      setPendingBoth("opening");
      openAgentWith(
        samples.length
          ? "Voice run: I've pasted my own writing and I'm ready. Write my opening drafts."
          : "Voice run: I'm ready (nothing to paste). Write my opening drafts.",
      );
    },
    [openAgentWith, persist, setPendingBoth],
  );

  const resumeRun = useCallback(
    (campaignId: string | null) => {
      if (!userId) return;
      const current = runRef.current;
      if (current && (current.campaignId ?? null) === (campaignId ?? null)) {
        return;
      }
      const saved = readRun(userId, campaignId);
      // Never let a different scope's run leak into this one: no saved run
      // for this scope means the deck starts from the samples step.
      persist(saved);
      setError(null);
      setPendingBoth(null);
    },
    [persist, setPendingBoth, userId],
  );

  const requestMoreDrafts = useCallback(() => {
    if (pendingRef.current) return;
    setError(null);
    setPendingBoth("drafts");
    openAgentWith("Voice run: nearly out of drafts. Write the next batch.");
  }, [openAgentWith, setPendingBoth]);

  const sendInstruction = useCallback(
    (instruction: string) => {
      setError(null);
      setPendingBoth("drafts");
      openAgentWith(instruction);
    },
    [openAgentWith, setPendingBoth],
  );

  const requestSave = useCallback(() => {
    if (pendingRef.current === "save") return;
    setError(null);
    setPendingBoth("save");
    openAgentWith("Voice run: I'm done judging. Save my voice.");
  }, [openAgentWith, setPendingBoth]);

  const endRun = useCallback(() => {
    const current = runRef.current;
    if (userId && current) clearRun(userId, current.campaignId);
    persist(null);
    setPendingBoth(null);
    setError(null);
  }, [persist, setPendingBoth, userId]);

  const discardRun = useCallback(
    (campaignId: string | null) => {
      if (userId) clearRun(userId, campaignId);
      const current = runRef.current;
      if (current && (current.campaignId ?? null) === (campaignId ?? null)) {
        persist(null);
        setPendingBoth(null);
        setError(null);
      }
    },
    [persist, setPendingBoth, userId],
  );

  const ingest = useCallback(
    (part: { type: string; data?: unknown }) => {
      const current = runRef.current;

      if (part.type === "data-voice-instruction") {
        const { instruction } = (part.data ?? {}) as { instruction?: string };
        if (!current || !instruction) return;
        persist({
          ...current,
          instructions: [...current.instructions, instruction],
        });
        return;
      }

      if (part.type === "data-voice-drafts") {
        const data = part.data as DraftsPart | undefined;
        if (!current || !data?.drafts?.length) return;
        // Stamped per draft, not per run: the persona rotates every batch,
        // and a queue holding two batches must label each card with the
        // persona its drafts were actually written to.
        const label = data.persona?.label ?? null;
        const real = data.persona?.real ?? false;
        const withIds: RunDraft[] = data.drafts.map((d) => ({
          ...d,
          id: crypto.randomUUID(),
          personaLabel: label,
          personaReal: real,
        }));
        persist({
          ...current,
          queue:
            data.mode === "append" ? [...current.queue, ...withIds] : withIds,
        });
        setPendingBoth(null);
        setError(null);
        return;
      }

      if (part.type === "data-voice-skill") {
        const data = part.data as SkillPart | undefined;
        if (!data?.instructions) return;
        // A refine can land with no active run; the savedTick still tells
        // profile views to refetch.
        if (
          current &&
          (current.campaignId ?? null) === (data.campaignId ?? null)
        ) {
          persist({
            ...current,
            finished: true,
            skill: { instructions: data.instructions, summary: data.summary },
          });
        }
        setPendingBoth(null);
        setError(null);
        setSavedTick((t) => t + 1);
      }
    },
    [persist, setPendingBoth],
  );

  const notifyTurnDone = useCallback(() => {
    const was = pendingRef.current;
    if (!was) return;
    setPendingBoth(null);
    setError(
      was === "save"
        ? "The rules were not saved. Try again."
        : "The agent came back without drafts. Try again.",
    );
  }, [setPendingBoth]);

  const value = useMemo<VoiceRunContextValue>(
    () => ({
      run,
      pending,
      error,
      savedTick,
      beginRun,
      resumeRun,
      updateRun,
      requestMoreDrafts,
      sendInstruction,
      requestSave,
      endRun,
      discardRun,
      ingest,
      notifyTurnDone,
    }),
    [
      run,
      pending,
      error,
      savedTick,
      beginRun,
      resumeRun,
      updateRun,
      requestMoreDrafts,
      sendInstruction,
      requestSave,
      endRun,
      discardRun,
      ingest,
      notifyTurnDone,
    ],
  );

  return <VoiceRunContext value={value}>{children}</VoiceRunContext>;
}

export function useVoiceRun() {
  return useContext(VoiceRunContext);
}
