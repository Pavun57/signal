"use client";

import { useEffect, useState } from "react";
import { Mic } from "lucide-react";

import { SafeLink } from "@/components/safe-link";
import { createClient } from "@/lib/supabase/client";

/**
 * Whether this campaign has its own email voice, and a way into the interview.
 *
 * The gate that actually enforces this lives in `draftEmailsForSequence`, which
 * refuses to draft until the user has chosen. This is the UI counterpart: the
 * state is visible on the page outreach is launched from, so the choice isn't
 * sprung on someone mid-conversation with the agent.
 */
export function CampaignVoiceLink({ campaignId }: { campaignId: string }) {
  const [state, setState] = useState<"loading" | "own" | "fallback">("loading");

  useEffect(() => {
    let cancelled = false;
    const supabase = createClient();

    // RLS scopes this to the signed-in user. A read failure is indistinguishable
    // from "no voice" here, which is the safe direction: it prompts rather than
    // claiming a voice exists.
    // Wrapped in try/catch rather than chained: the query builder is a bare
    // PromiseLike with no `.catch`, so a rejection (network drop, auth failure)
    // would otherwise leave this stuck on "loading" forever — silently removing
    // the indicator from the header — plus an unhandled rejection.
    void (async () => {
      try {
        const { data } = await supabase
          .from("email_voice_profiles")
          .select("id")
          .eq("campaign_id", campaignId)
          .maybeSingle();
        if (!cancelled) setState(data ? "own" : "fallback");
      } catch {
        if (!cancelled) setState("fallback");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [campaignId]);

  if (state === "loading") return null;

  return (
    <>
      {/* The separator lives here so it can't be left dangling while this is
          still loading. */}
      <span className="text-muted-foreground/40">·</span>
      <SafeLink
        href={`/email-skills?campaign=${campaignId}`}
        className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-sm transition-colors"
      >
        <Mic className="size-3.5 shrink-0" aria-hidden />
        {state === "own" ? "Email voice set" : "No email voice"}
      </SafeLink>
    </>
  );
}
