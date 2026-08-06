"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { AlertTriangle, Check, Loader2, Layers } from "lucide-react";
import { toast } from "sonner";

import { SafeLink } from "@/components/safe-link";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { LearningsSection } from "@/components/email-skills/learnings-section";
import { VoiceProfileView } from "@/components/email-skills/voice-profile-view";
import { VoiceSwipe } from "@/components/email-skills/voice-swipe";
import { useCampaign } from "@/lib/campaign-context";
import { useVoiceRun } from "@/lib/voice-run-context";
import { createClient } from "@/lib/supabase/client";
import type { VoiceProfile } from "@/lib/types/email-voice";

interface CampaignRow {
  id: string;
  name: string;
}

/**
 * The list view's shape. `source_transcript` is deliberately absent: it holds
 * cold emails the user pasted, which are third-party correspondence, and
 * nothing on this page renders it.
 */
type VoiceSummary = Omit<VoiceProfile, "source_transcript">;

/**
 * Voice is per campaign, because which signal to open on and which credibility
 * framing lands differ by audience — a voice built against a dev-tools
 * campaign tells the composer to reference release cadence, which is nonsense
 * for a beauty brand. A user-level default covers campaigns without their own.
 *
 * `?campaign=<id>` selects the scope. Without it the page shows the default plus
 * a row per campaign so the state of each is visible in one place.
 *
 * Building a voice happens on the swipe deck: the agent writes drafts, the
 * user keeps or passes them, and the agent panel beside the deck carries the
 * conversation. Refining an existing voice goes through the agent too.
 */
function EmailVoiceScope() {
  const searchParams = useSearchParams();
  const campaignId = searchParams.get("campaign");
  const { openAgentWith } = useCampaign();
  const { run, savedTick, discardRun } = useVoiceRun();

  const [profiles, setProfiles] = useState<VoiceSummary[]>([]);
  const [campaigns, setCampaigns] = useState<CampaignRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** The deck is on screen, judging drafts for this scope. */
  const [running, setRunning] = useState(false);
  /** A refinement was handed to the agent; cleared when a save lands. */
  const [refineSent, setRefineSent] = useState(false);

  const mountedRef = useRef(true);

  const fetchAll = useCallback(async () => {
    const supabase = createClient();
    // RLS scopes both reads to the signed-in user, so no user filter is needed.
    const [voiceRes, campaignRes] = await Promise.all([
      supabase
        .from("email_voice_profiles")
        .select(
          "id, user_id, campaign_id, instructions, summary, created_at, updated_at",
        ),
      supabase.from("campaigns").select("id, name").order("updated_at", {
        ascending: false,
      }),
    ]);

    if (!mountedRef.current) return;
    setLoadError(voiceRes.error?.message ?? campaignRes.error?.message ?? null);
    setProfiles((voiceRes.data as VoiceSummary[] | null) ?? []);
    setCampaigns((campaignRes.data as CampaignRow[] | null) ?? []);
    setLoading(false);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    fetchAll();
    return () => {
      mountedRef.current = false;
    };
  }, [fetchAll]);

  // A save landed (run finished, or a refinement applied): the rules on this
  // page are stale the moment that happens.
  const lastTickRef = useRef(savedTick);
  useEffect(() => {
    if (savedTick === lastTickRef.current) return;
    lastTickRef.current = savedTick;
    setRefineSent(false);
    void fetchAll();
  }, [savedTick, fetchAll]);

  // A run for this scope survived a reload mid-swipe: put the deck back on
  // screen rather than showing an empty state over a half-finished run.
  useEffect(() => {
    if (
      run &&
      !run.finished &&
      (run.campaignId ?? null) === (campaignId ?? null)
    ) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setRunning(true);
    }
  }, [run, campaignId]);

  const scoped = profiles.find((p) => (p.campaign_id ?? null) === campaignId);
  const campaign = campaigns.find((c) => c.id === campaignId);
  const scopeLabel = campaignId ? (campaign?.name ?? "this campaign") : null;

  const deleteVoice = async () => {
    if (!scoped) return;
    const supabase = createClient();
    const { error } = await supabase
      .from("email_voice_profiles")
      .delete()
      .eq("id", scoped.id);
    if (error) {
      toast.error(`Failed to delete voice: ${error.message}`);
      return;
    }
    toast.success(
      scopeLabel
        ? `Deleted the voice for ${scopeLabel}`
        : "Default voice deleted",
    );
    setLoading(true);
    void fetchAll();
  };

  if (loading) {
    return (
      <PageShell scopeLabel={scopeLabel}>
        <p className="text-muted-foreground flex items-center gap-1.5 text-sm">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Loading...
        </p>
      </PageShell>
    );
  }

  if (loadError) {
    return (
      <PageShell scopeLabel={scopeLabel}>
        <div
          role="alert"
          className="border-destructive/30 bg-destructive/5 space-y-3 rounded-xl border p-5"
        >
          <div className="flex items-start gap-2.5">
            <AlertTriangle className="text-destructive mt-0.5 size-4 shrink-0" />
            <div className="space-y-1">
              <p className="text-destructive text-sm font-medium">
                Could not load your email voice
              </p>
              <p className="text-muted-foreground text-sm">{loadError}</p>
            </div>
          </div>
          <Button
            onClick={() => {
              setLoading(true);
              fetchAll();
            }}
          >
            Try again
          </Button>
        </div>
      </PageShell>
    );
  }

  if (running) {
    return (
      <PageShell scopeLabel={scopeLabel} wide>
        <VoiceSwipe
          campaignId={campaignId}
          onDone={() => {
            setRunning(false);
            setLoading(true);
            void fetchAll();
          }}
        />
      </PageShell>
    );
  }

  return (
    <PageShell scopeLabel={scopeLabel}>
      {scoped ? (
        <VoiceProfileView
          // Remounted when the rules change, which closes the refine box and
          // clears the instruction that has now been applied.
          key={scoped.updated_at}
          profile={scoped}
          busy={refineSent}
          copy={{
            refineNote: refineSent
              ? "Sent. The agent is rewriting the rules; they update here when it finishes."
              : "The agent rewrites the rules from this and everything it already knows. No swiping.",
            rebuildDescription:
              "This starts a new swipe run from nothing. The current rules are replaced as soon as the new voice is written, and cannot be recovered. To make a smaller change, use Refine instead.",
            rebuildConfirmLabel: "Start a new run",
            deleteDescription: campaignId
              ? profiles.some((p) => !p.campaign_id)
                ? `This permanently deletes the voice for ${scopeLabel}. Cold emails for this campaign will fall back to your default voice. This cannot be undone.`
                : `This permanently deletes the voice for ${scopeLabel}. Cold emails for this campaign will use generic best-practice rules instead. This cannot be undone.`
              : "This permanently deletes your default voice. Campaigns without their own voice will write to generic best-practice rules. This cannot be undone.",
          }}
          onRefine={(instruction) => {
            setRefineSent(true);
            openAgentWith(
              campaignId
                ? `Refine my email voice for campaign ${campaignId}: ${instruction}`
                : `Refine my default email voice: ${instruction}`,
            );
          }}
          onRebuild={() => {
            // From nothing: a finished run left in storage would resurrect
            // its result screen instead of starting the deck fresh.
            discardRun(campaignId);
            setRunning(true);
          }}
          onDelete={() => void deleteVoice()}
        />
      ) : (
        <BuildPrompt
          scopeLabel={scopeLabel}
          hasDefault={profiles.some((p) => !p.campaign_id)}
          onStart={() => {
            discardRun(campaignId);
            setRunning(true);
          }}
        />
      )}

      {/* Only on the overview — inside a campaign's own scope this list would
          just be a way to wander off mid-task. */}
      {!campaignId && campaigns.length > 0 && (
        <CampaignVoiceList campaigns={campaigns} profiles={profiles} />
      )}

      {/* Outcome learnings live beside the voice they compose with. Overview
          only, same reasoning as the campaign list above. */}
      {!campaignId && <LearningsSection />}
    </PageShell>
  );
}

function BuildPrompt({
  scopeLabel,
  hasDefault,
  onStart,
}: {
  scopeLabel: string | null;
  hasDefault: boolean;
  onStart: () => void;
}) {
  return (
    <div className="border-border bg-card overflow-hidden rounded-xl border">
      <EmptyState
        icon={Layers}
        title={
          scopeLabel ? `No voice for ${scopeLabel} yet` : "No default voice yet"
        }
        description={
          scopeLabel
            ? hasDefault
              ? "This campaign will use your default voice, which was built against a different audience, so it may reach for the wrong kind of signal."
              : "Until you build one, the agent writes to generic best-practice rules: correct, and identical to everybody else's."
            : "The fallback for any campaign without its own voice. Until you build one, those campaigns write to generic best-practice rules."
        }
        action={
          <Button size="lg" onClick={onStart}>
            {scopeLabel
              ? `Build the voice for ${scopeLabel}`
              : "Build my default voice"}
          </Button>
        }
      />

      <div className="border-border border-t px-5 py-5 md:px-6">
        <p className="text-muted-foreground text-[10px] font-semibold tracking-widest uppercase">
          How it works
        </p>
        <ol className="text-muted-foreground marker:text-muted-foreground mt-3 list-decimal space-y-2 pl-5 text-sm">
          <li>
            <span className="text-foreground font-medium">
              Paste something you have sent, if you have it.
            </span>{" "}
            Your own writing beats any amount of reacting to ours. Skipping is
            fine too.
          </li>
          <li>
            <span className="text-foreground font-medium">
              You judge real drafts.
            </span>{" "}
            The agent writes emails{" "}
            {scopeLabel
              ? `about ${scopeLabel}'s offer`
              : "against a live campaign"}
            , deliberately different from each other, and you keep the ones that
            sound like you. What people choose is a better signal than what they
            say about their style.
          </li>
          <li>
            <span className="text-foreground font-medium">
              It converges on your voice.
            </span>{" "}
            Once you&apos;re keeping four of every five, the agent writes the
            rules from what you kept and saves them. Every future cold email
            goes through them.
          </li>
        </ol>
        <p className="text-muted-foreground mt-3 text-xs">
          Usually a couple of minutes, and a reload does not lose your place.
        </p>
      </div>
    </div>
  );
}

/** Which campaigns have their own voice, and a way into each one's deck. */
function CampaignVoiceList({
  campaigns,
  profiles,
}: {
  campaigns: CampaignRow[];
  profiles: VoiceSummary[];
}) {
  const byCampaign = new Set(
    profiles.map((p) => p.campaign_id).filter(Boolean) as string[],
  );

  return (
    <div className="border-border bg-card rounded-xl border">
      <div className="border-border border-b px-5 py-4 md:px-6">
        <h2 className="type-large text-foreground">Per-campaign voices</h2>
        <p className="text-muted-foreground text-sm">
          Each campaign can have its own, built against that audience. Campaigns
          without one fall back to your default.
        </p>
      </div>
      <ul>
        {campaigns.map((c) => {
          const has = byCampaign.has(c.id);
          return (
            <li
              key={c.id}
              className="border-border flex items-center justify-between gap-3 border-b px-5 py-3 last:border-b-0 md:px-6"
            >
              <div className="min-w-0">
                <p className="text-foreground truncate text-sm font-medium">
                  {c.name}
                </p>
                <p className="text-muted-foreground flex items-center gap-1 text-xs">
                  {has ? (
                    <>
                      <Check className="size-3" aria-hidden />
                      Has its own voice
                    </>
                  ) : (
                    "Using your default"
                  )}
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                render={<SafeLink href={`/email-skills?campaign=${c.id}`} />}
              >
                {has ? "View" : "Build"}
              </Button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function PageShell({
  scopeLabel,
  wide = false,
  children,
}: {
  scopeLabel: string | null;
  /** The deck wants room for a full email card; the list views do not. */
  wide?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="flex-1 overflow-y-auto">
      <div
        className={
          wide
            ? "mx-auto max-w-5xl space-y-6 p-4 md:p-6"
            : "mx-auto max-w-4xl space-y-6 p-4 md:p-6"
        }
      >
        <div>
          <h1 className="type-title">
            {scopeLabel ? `Email voice: ${scopeLabel}` : "Email voice"}
          </h1>
          <p className="text-muted-foreground text-sm">
            {scopeLabel
              ? "How this campaign's cold emails sound. The agent writes drafts about this audience; you keep the ones that sound like you."
              : "How your cold emails sound. Each campaign can have its own voice; this default covers the rest."}
          </p>
          {scopeLabel && (
            <SafeLink
              href="/email-skills"
              className="text-muted-foreground hover:text-foreground mt-2 inline-block text-xs underline underline-offset-2"
            >
              All email voices
            </SafeLink>
          )}
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
export default function EmailVoicePage() {
  return (
    <Suspense
      fallback={
        <PageShell scopeLabel={null}>
          <div className="text-muted-foreground flex items-center gap-2 py-8 text-sm">
            <Loader2 className="size-4 animate-spin" />
            Loading your email voice...
          </div>
        </PageShell>
      }
    >
      <EmailVoiceScope />
    </Suspense>
  );
}
