"use client";

import { useState } from "react";
import { RotateCcw, Wand2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { RelativeTime } from "@/components/ui/relative-time";
import { Textarea } from "@/components/ui/textarea";
import { SettingsSection } from "@/components/settings/settings-section";
import { ConfirmDialog } from "@/components/email-skills/confirm-dialog";
import type { VoiceProfile } from "@/lib/types/email-voice";

interface VoiceProfileViewProps {
  /** Omit-friendly: this view renders rules and timestamps, never the transcript. */
  profile: Omit<VoiceProfile, "source_transcript">;
  /** A plain-English change; re-enters the interview rather than editing text. */
  onRefine: (instruction: string) => void;
  onRebuild: () => void;
}

/**
 * Read-only view of the accepted voice. There is deliberately no editor: the
 * agent is the only author, so the two ways forward are describing a change
 * (Refine) or starting the interview again (Rebuild).
 */
export function VoiceProfileView({
  profile,
  onRefine,
  onRebuild,
}: VoiceProfileViewProps) {
  const [refining, setRefining] = useState(false);
  const [instruction, setInstruction] = useState("");
  const [rebuildOpen, setRebuildOpen] = useState(false);

  const trimmed = instruction.trim();
  const submitRefinement = () => {
    if (!trimmed) return;
    onRefine(trimmed);
  };

  return (
    <SettingsSection
      title="Your email voice"
      description="Every cold email the agent drafts is written through these rules."
      actions={
        <>
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={() => setRefining((prev) => !prev)}
            aria-expanded={refining}
          >
            <Wand2 className="size-3.5" />
            Refine
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={() => setRebuildOpen(true)}
          >
            <RotateCcw className="size-3.5" />
            Rebuild
          </Button>
        </>
      }
    >
      <p className="text-muted-foreground text-xs">
        Last updated <RelativeTime iso={profile.updated_at} />
      </p>

      {refining && (
        <div className="border-border bg-card animate-in fade-in-0 space-y-3 rounded-xl border p-4 duration-200">
          <label
            htmlFor="refine-instruction"
            className="text-foreground block text-sm font-medium"
          >
            What should change?
          </label>
          <Textarea
            id="refine-instruction"
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submitRefinement();
              }
            }}
            rows={3}
            autoFocus
            placeholder="For example: be blunter in the opening line, and stop asking for a call in the first email."
          />
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-muted-foreground text-xs">
              The agent takes it from here. It may ask a question or two before
              rewriting the rules.
            </p>
            <div className="flex gap-2">
              <Button
                variant="ghost"
                onClick={() => {
                  setRefining(false);
                  setInstruction("");
                }}
              >
                Cancel
              </Button>
              <Button disabled={!trimmed} onClick={submitRefinement}>
                Send to the agent
              </Button>
            </div>
          </div>
        </div>
      )}

      <VoiceInstructionsPanel
        instructions={profile.instructions}
        summary={profile.summary}
      />

      <ConfirmDialog
        open={rebuildOpen}
        onOpenChange={setRebuildOpen}
        title="Rebuild your email voice?"
        description="This starts the interview from scratch. The current rules and the interview behind them are replaced as soon as the new voice is generated, and cannot be recovered. To make a smaller change, use Refine instead."
        confirmLabel="Start a new interview"
        variant="destructive"
        onConfirm={onRebuild}
      />
    </SettingsSection>
  );
}

/**
 * Shared between the review step at the end of the interview and the saved
 * profile — the user should recognise the thing they accepted, so both surfaces
 * render it identically. Mono for the instructions because they are literally
 * the text appended to the composer's prompt.
 */
export function VoiceInstructionsPanel({
  instructions,
  summary,
}: {
  instructions: string;
  summary: string | null;
}) {
  return (
    <div className="space-y-4">
      {summary && (
        <div className="bg-muted/40 ring-border rounded-lg p-4 ring-1">
          <PanelLabel>In short</PanelLabel>
          <p className="text-[13px] leading-relaxed">{summary}</p>
        </div>
      )}
      <div>
        <PanelLabel>Rules the composer follows</PanelLabel>
        <pre className="bg-muted/40 ring-border rounded-md p-3 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap ring-1">
          {instructions}
        </pre>
      </div>
    </div>
  );
}

function PanelLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-muted-foreground mb-1.5 text-[10px] font-semibold tracking-widest uppercase">
      {children}
    </p>
  );
}
