"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { AlertTriangle, Check, Loader2, Mic } from "lucide-react";
import { useAuth } from "@clerk/nextjs";

import { SafeLink } from "@/components/safe-link";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { VoiceProfileView } from "@/components/email-skills/voice-profile-view";
import {
  VoiceWizard,
  buildRefinementTranscript,
  clearSavedInterview,
  readSavedInterview,
} from "@/components/email-skills/voice-wizard";
import { createClient } from "@/lib/supabase/client";
import type { InterviewTurn, VoiceProfile } from "@/lib/types/email-voice";

interface CampaignRow {
  id: string;
  name: string;
}

/**
 * The list view's shape. `source_transcript` is deliberately absent: it holds
 * cold emails the user pasted, which are third-party correspondence, and
 * nothing on this page renders it. A refinement fetches the one row it needs.
 */
type VoiceSummary = Omit<VoiceProfile, "source_transcript">;

/**
 * Voice is per campaign, because which signal to open on and which credibility
 * framing lands differ by audience — a voice interviewed against a dev-tools
 * campaign tells the composer to reference release cadence, which is nonsense
 * for a beauty brand. A user-level default covers campaigns without their own.
 *
 * `?campaign=<id>` selects the scope. Without it the page shows the default plus
 * a row per campaign so the state of each is visible in one place.
 */
function EmailVoiceScope() {
  const { userId, isLoaded } = useAuth();
  const searchParams = useSearchParams();
  const campaignId = searchParams.get("campaign");

  const [profiles, setProfiles] = useState<VoiceSummary[]>([]);
  const [campaigns, setCampaigns] = useState<CampaignRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** Non-null means the interview is on screen; the value seeds the wizard. */
  const [interview, setInterview] = useState<InterviewTurn[] | null>(null);

  const mountedRef = useRef(true);
  /** Which scope has already been restored — not a boolean, or a soft
   * navigation into a campaign never looks for that campaign's transcript. */
  const restoredScopeRef = useRef<string | null | undefined>(undefined);

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

  useEffect(() => {
    // Restore an interview interrupted by a reload. Keyed per user and scope,
    // so there is nothing to look up until Clerk tells us who this is — and a
    // campaign's interview must not resurrect on the default's page.
    if (!userId || restoredScopeRef.current === campaignId) return;
    restoredScopeRef.current = campaignId;
    const saved = readSavedInterview(userId, campaignId);
    setInterview(saved ?? null);
  }, [userId, campaignId]);

  /**
   * Both accepting and exiting have to refetch. The interview route saves the
   * profile the moment it returns a `complete` move, so the row already exists
   * by the time the review screen appears — without a refetch, closing it drops
   * back to stale state that reads as lost work.
   */
  const startRefinement = async (
    profile: VoiceSummary,
    instruction: string,
  ) => {
    const { data } = await createClient()
      .from("email_voice_profiles")
      .select("source_transcript")
      .eq("id", profile.id)
      .maybeSingle();

    setInterview(
      buildRefinementTranscript(
        {
          ...profile,
          source_transcript:
            (data as Pick<VoiceProfile, "source_transcript"> | null)
              ?.source_transcript ?? null,
        },
        instruction,
      ),
    );
  };

  const closeInterview = () => {
    setInterview(null);
    setLoading(true);
    fetchAll();
  };

  const scoped = profiles.find((p) => (p.campaign_id ?? null) === campaignId);
  const campaign = campaigns.find((c) => c.id === campaignId);
  const scopeLabel = campaignId ? (campaign?.name ?? "this campaign") : null;

  if (loading || !isLoaded) {
    return (
      <PageShell scopeLabel={scopeLabel}>
        <p className="text-muted-foreground flex items-center gap-1.5 text-sm">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Loading...
        </p>
      </PageShell>
    );
  }

  if (interview && userId) {
    return (
      <PageShell scopeLabel={scopeLabel}>
        <VoiceWizard
          // Keyed on scope so switching campaigns (a soft navigation, which
          // re-renders rather than remounting) rebuilds the wizard instead of
          // carrying one campaign's transcript into another scope and saving it
          // there. The transcript survives in sessionStorage under its own key,
          // so the remount resumes the correct interview rather than losing work.
          key={campaignId ?? "user"}
          userId={userId}
          campaignId={campaignId}
          initialTranscript={interview}
          onExit={closeInterview}
          onAccepted={closeInterview}
        />
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

  return (
    <PageShell scopeLabel={scopeLabel}>
      {scoped ? (
        <VoiceProfileView
          profile={scoped}
          onRefine={(instruction) => {
            void startRefinement(scoped, instruction);
          }}
          onRebuild={() => {
            // Start from an empty transcript: rebuild means the agent asks
            // again from scratch rather than replaying the old answers.
            if (userId) clearSavedInterview(userId, campaignId);
            setInterview([]);
          }}
        />
      ) : (
        <BuildPrompt
          scopeLabel={scopeLabel}
          disabled={!userId}
          hasDefault={profiles.some((p) => !p.campaign_id)}
          onStart={() => setInterview([])}
        />
      )}

      {/* Only on the overview — inside a campaign's own scope this list would
          just be a way to wander off mid-task. */}
      {!campaignId && campaigns.length > 0 && (
        <CampaignVoiceList campaigns={campaigns} profiles={profiles} />
      )}
    </PageShell>
  );
}

function BuildPrompt({
  scopeLabel,
  disabled,
  hasDefault,
  onStart,
}: {
  scopeLabel: string | null;
  disabled: boolean;
  hasDefault: boolean;
  onStart: () => void;
}) {
  return (
    <div className="border-border bg-card overflow-hidden rounded-xl border">
      <EmptyState
        icon={Mic}
        title={
          scopeLabel ? `No voice for ${scopeLabel} yet` : "No default voice yet"
        }
        description={
          scopeLabel
            ? hasDefault
              ? "This campaign will use your default voice, which was interviewed against a different audience, so it may reach for the wrong kind of signal."
              : "Until you build one, the agent writes to generic best-practice rules: correct, and identical to everybody else's."
            : "The fallback for any campaign without its own voice. Until you build one, those campaigns write to generic best-practice rules."
        }
        action={
          <Button size="lg" disabled={disabled} onClick={onStart}>
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
              The agent interviews you.
            </span>{" "}
            Short questions about how you actually write, not a form to fill in.
          </li>
          <li>
            <span className="text-foreground font-medium">
              You react to real emails.
            </span>{" "}
            It drafts pairs{" "}
            {scopeLabel
              ? `about ${scopeLabel}'s offer`
              : "against a live campaign"}{" "}
            that differ in exactly one thing, and you pick the one that sounds
            like you. What people choose is a better signal than what they say
            about their style.
          </li>
          <li>
            <span className="text-foreground font-medium">
              You review the result.
            </span>{" "}
            The agent writes the rules; you read them and accept, or say what
            should change.
          </li>
        </ol>
        <p className="text-muted-foreground mt-3 text-xs">
          Usually 8 to 14 questions, and a reload does not lose your place.
        </p>
      </div>
    </div>
  );
}

/** Which campaigns have their own voice, and a way into each one's interview. */
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
          Each campaign can have its own, interviewed against that audience.
          Campaigns without one fall back to your default.
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

/**
 * Wider than /settings on purpose: the two comparison emails have to sit side
 * by side at a measure you can actually read.
 */
function PageShell({
  scopeLabel,
  children,
}: {
  scopeLabel: string | null;
  children: React.ReactNode;
}) {
  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-4xl space-y-6 p-4 md:p-6">
        <div>
          <h1 className="type-title">
            {scopeLabel ? `Email voice: ${scopeLabel}` : "Email voice"}
          </h1>
          <p className="text-muted-foreground text-sm">
            {scopeLabel
              ? "How this campaign's cold emails sound. Written by the agent after it interviews you about this audience."
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
