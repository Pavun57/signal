import { SafeLink } from "@/components/safe-link";
import { VoiceSwipe } from "@/components/email-skills/voice-swipe";

/**
 * Prototype route. The interview at /email-skills asks questions; this judges
 * drafts instead and derives the rules from what gets kept. Both exist side by
 * side until one is chosen — nothing here writes to email_voice_profiles yet.
 */
export default function VoiceSwipePage() {
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
            Prototype · seeded drafts, nothing saved ·{" "}
            <SafeLink
              href="/email-skills"
              className="hover:text-foreground underline underline-offset-2"
            >
              the current interview
            </SafeLink>
          </p>
        </div>
        <VoiceSwipe />
      </div>
    </div>
  );
}
