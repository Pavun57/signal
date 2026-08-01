"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { Loader2 } from "lucide-react";

import { SafeLink } from "@/components/safe-link";
import { VoiceSwipe } from "@/components/email-skills/voice-swipe";

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
  return <VoiceSwipe campaignId={searchParams.get("campaign")} />;
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
