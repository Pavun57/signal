"use client";

import { useState } from "react";
import { Loader2, Send } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/email-skills/confirm-dialog";
import type { DraftRow } from "@/components/outreach/outreach-drafts-panel";
import { apiFetch } from "@/lib/api-fetch";

interface ReadyToSendHeroProps {
  drafts: DraftRow[];
  onRefresh: () => void;
}

export function ReadyToSendHero({ drafts, onRefresh }: ReadyToSendHeroProps) {
  const [sendingAll, setSendingAll] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  if (drafts.length === 0) {
    return (
      <section className="border-border bg-muted/20 rounded-lg border border-dashed px-6 py-8 text-center">
        <p className="text-sm font-medium">All clear</p>
        <p className="text-muted-foreground mt-1 text-xs">
          Nothing is waiting on you right now.
        </p>
      </section>
    );
  }

  const sendAll = async () => {
    setConfirmOpen(false);
    setSendingAll(true);
    try {
      // Sequential, and each result is read.
      //
      // This used to be Promise.allSettled over every draft, counting only
      // whether the HTTP call resolved. Two things followed. N simultaneous
      // sends went at one Gmail account at once; and a draft that is not its
      // enrollment's current step comes back 409 with a reason, which was
      // discarded -- so a three-step sequence reported "20 failed to send"
      // with no names, no reasons, and no mention that the other 10 had
      // actually gone out.
      let sent = 0;
      let deferred = 0;
      const failures: string[] = [];

      // Earliest steps first, so a later step never even reaches the server
      // ahead of its predecessor in this pass. The server holds the real
      // guard (ignoreSchedule:false below); this ordering keeps the pass
      // productive instead of deferring drafts the guard would have allowed
      // a moment later.
      const ordered = [...drafts].sort(
        (a, b) => (a.step_number ?? 1) - (b.step_number ?? 1),
      );

      for (const draft of ordered) {
        try {
          const res = await apiFetch("/api/outreach/send-now", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            // Bulk send is not a per-draft human override: steps that are
            // not due yet stay on their schedule instead of arriving
            // seconds after the email they follow up on.
            body: JSON.stringify({ draftId: draft.id, ignoreSchedule: false }),
          });
          if (res.ok) {
            sent++;
            continue;
          }
          const body = (await res.json().catch(() => null)) as {
            blocker?: string;
            error?: string;
          } | null;
          if (body?.blocker === "step_mismatch" || body?.blocker === "not_due")
            deferred++;
          else failures.push(body?.error ?? `HTTP ${res.status}`);
        } catch {
          failures.push("could not reach the server");
        }
      }

      if (sent > 0) {
        toast.success(`Sent ${sent} email${sent === 1 ? "" : "s"}`);
      }
      if (deferred > 0) {
        toast.info(
          `${deferred} ${deferred === 1 ? "is" : "are"} not due yet and will send on schedule.`,
        );
      }
      if (failures.length > 0) {
        toast.error(
          `${failures.length} failed to send: ${failures.slice(0, 3).join("; ")}`,
        );
      }
      onRefresh();
    } finally {
      setSendingAll(false);
    }
  };

  return (
    <section className="border-primary/20 bg-primary/5 rounded-lg border p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="type-header">
            {drafts.length} email{drafts.length === 1 ? "" : "s"} ready to send
          </h2>
          <p className="text-muted-foreground mt-0.5 text-sm">
            Approved and past the scheduled delay.
          </p>
        </div>
        <Button onClick={() => setConfirmOpen(true)} disabled={sendingAll}>
          {sendingAll ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Send className="h-4 w-4" />
          )}
          {sendingAll ? "Sending…" : "Send all"}
        </Button>
      </div>

      {/*
        The app confirms enrichment, which costs money but is reversible, and
        confirms publishing a signal. This is the one action that cannot be
        taken back, and it went straight from click to N real emails.
      */}
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={`Send ${drafts.length} email${drafts.length === 1 ? "" : "s"}?`}
        description={`This sends ${drafts.length === 1 ? "this email" : `all ${drafts.length} emails`} from your connected mailbox now. Sent email cannot be recalled.`}
        confirmLabel={`Send ${drafts.length === 1 ? "it" : "them"}`}
        onConfirm={sendAll}
      />
    </section>
  );
}
