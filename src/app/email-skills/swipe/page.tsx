"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Loader2 } from "lucide-react";

import { SafeLink } from "@/components/safe-link";
import { VoiceProfileView } from "@/components/email-skills/voice-profile-view";
import { VoiceSwipe } from "@/components/email-skills/voice-swipe";
import { createClient } from "@/lib/supabase/client";
import type { VoiceProfile } from "@/lib/types/email-voice";

/** Never the transcript: nothing here renders it, and it holds pasted mail. */
type VoiceSummary = Omit<VoiceProfile, "source_transcript">;

/**
 * Prototype route. The interview at /email-skills asks questions; this judges
 * drafts instead and derives the rules from what gets kept. Both exist side by
 * side until one is chosen.
 *
 * `?campaign=<id>` scopes the run, the same parameter and the same meaning as
 * /email-skills. Everything downstream of it is resolved server-side by the
 * route: the campaign's own linked profile if it has one, and one real contact
 * from that campaign for the drafts to be about. Without the parameter the run
 * is the user-level default and the drafts are generic, which is exactly what
 * a default voice should be interviewed against.
 */
function SwipeScope() {
  const searchParams = useSearchParams();
  const campaignId = searchParams.get("campaign");

  const [profile, setProfile] = useState<VoiceSummary | null>(null);
  const [loading, setLoading] = useState(true);
  /** Set once the user asks for a run, so a finished voice is not swiped over
   * by accident and a rebuild does not need a different URL. */
  const [running, setRunning] = useState(false);
  const [refining, setRefining] = useState(false);
  const [refineError, setRefineError] = useState<string | null>(null);

  const mountedRef = useRef(true);

  const load = useCallback(async () => {
    // RLS scopes the table to the signed-in user, so scope is the only filter.
    // `.is` rather than `.eq`, because the default voice's campaign_id is NULL.
    const query = createClient()
      .from("email_voice_profiles")
      .select(
        "id, user_id, campaign_id, instructions, summary, created_at, updated_at",
      );
    const { data } = await (
      campaignId
        ? query.eq("campaign_id", campaignId)
        : query.is("campaign_id", null)
    ).maybeSingle();

    if (!mountedRef.current) return;
    setProfile((data as VoiceSummary | null) ?? null);
    setLoading(false);
  }, [campaignId]);

  useEffect(() => {
    mountedRef.current = true;
    void load();
    return () => {
      mountedRef.current = false;
    };
  }, [load]);

  /**
   * "What should be different?" without swiping again. The saved rules and the
   * run behind them are replayed server-side, so a sentence narrows the voice
   * rather than replacing it with whatever one sentence implies.
   */
  const refine = async (instruction: string) => {
    setRefining(true);
    setRefineError(null);
    try {
      const res = await fetch("/api/email-skills/swipe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "refine", instruction, campaignId }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.instructions) {
        setRefineError(data?.error ?? "The rules could not be rewritten.");
        return;
      }
      await load();
    } catch {
      setRefineError("Could not reach the agent.");
    } finally {
      if (mountedRef.current) setRefining(false);
    }
  };

  if (loading) {
    return (
      <div className="text-muted-foreground flex items-center gap-2 py-8 text-sm">
        <Loader2 className="size-4 animate-spin" />
        Loading...
      </div>
    );
  }

  if (profile && !running) {
    return (
      <VoiceProfileView
        // Remounted when the rules change, which closes the refine box and
        // clears the instruction that has now been applied.
        key={profile.updated_at}
        profile={profile}
        busy={refining}
        error={refineError}
        copy={{
          refineNote:
            "The agent rewrites the rules from this and everything it already knows. No swiping.",
          rebuildDescription:
            "This starts a new run from nothing. The current rules are replaced as soon as the new voice is written, and cannot be recovered. To make a smaller change, use Refine instead.",
          rebuildConfirmLabel: "Start a new run",
        }}
        onRefine={(instruction) => void refine(instruction)}
        onRebuild={() => setRunning(true)}
      />
    );
  }

  return <VoiceSwipe campaignId={campaignId} />;
}

function PageShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex-1 overflow-y-auto">
      {/* `min-h-full` plus `justify-center` centres the whole thing on a tall
          screen instead of leaving it pinned to the top over a field of white,
          and still scrolls normally once the content outgrows the viewport.
          The email body carries its own max-width so widening the container
          grows the card without stretching the line length. */}
      <div className="mx-auto flex min-h-full max-w-[1200px] flex-col justify-center gap-6 px-6 py-9">
        <div>
          <h1 className="type-title">Email voice: swipe</h1>
          <p className="text-muted-foreground text-sm">
            Judge drafts instead of answering questions. It keeps writing until
            you&apos;re keeping four of every five, then writes the rules from
            what you kept.
          </p>
          <p className="text-muted-foreground mt-2 text-xs">
            Prototype ·{" "}
            <SafeLink
              href="/email-skills"
              className="hover:text-foreground underline underline-offset-2"
            >
              the current interview
            </SafeLink>
          </p>
        </div>
        {children}
      </div>
    </div>
  );
}

/**
 * `useSearchParams` opts a page out of prerendering unless it sits under a
 * Suspense boundary — without one `next build` fails on this route while
 * `next dev` renders it fine. The fallback is the page chrome the scoped view
 * would draw anyway, so the boundary costs nothing visually.
 */
export default function VoiceSwipePage() {
  return (
    <PageShell>
      <Suspense
        fallback={
          <div className="text-muted-foreground flex items-center gap-2 py-8 text-sm">
            <Loader2 className="size-4 animate-spin" />
            Loading...
          </div>
        }
      >
        <SwipeScope />
      </Suspense>
    </PageShell>
  );
}
