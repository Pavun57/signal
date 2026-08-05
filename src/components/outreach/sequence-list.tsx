"use client";

import { useState } from "react";
import { toast } from "sonner";

import type { SequenceRow } from "@/app/outreach/page";
import { ReviewButton } from "@/components/outreach/review-button";
import { SequenceProgressBar } from "@/components/outreach/sequence-progress-bar";
import { StatusPill } from "@/components/ui/status-pill";
import { createClient } from "@/lib/supabase/client";
import type { OutreachStatus } from "@/lib/outreach/status";

interface SequenceListProps {
  sequences: SequenceRow[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

/**
 * Per-sequence send-window override. "" renders the inherit option; writes
 * go straight through the RLS-scoped client, same pattern as the tracking
 * table's pause toggle.
 */
function SendWindowScopeSelect({ seq }: { seq: SequenceRow }) {
  const [scope, setScope] = useState(seq.send_window_scope ?? "");

  const onChange = async (value: string) => {
    const previous = scope;
    setScope(value);
    const supabase = createClient();
    const { error } = await supabase
      .from("sequences")
      .update({ send_window_scope: value === "" ? null : value })
      .eq("id", seq.id);
    if (error) {
      toast.error("Failed to update send window scope");
      setScope(previous);
    } else {
      toast.success(
        value === "recipient"
          ? "Sends in each recipient's timezone"
          : value === "sender"
            ? "Sends in your timezone"
            : "Send window scope inherits your settings",
      );
    }
  };

  return (
    <select
      aria-label="Send window scope"
      className="border-border bg-background text-muted-foreground rounded border px-1.5 py-1 text-xs"
      value={scope}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => {
        e.stopPropagation();
        void onChange(e.target.value);
      }}
    >
      <option value="">Window: default</option>
      <option value="sender">Window: my timezone</option>
      <option value="recipient">Window: recipient&apos;s</option>
    </select>
  );
}

function mapSequenceStatus(status: string): OutreachStatus {
  switch (status) {
    case "draft":
      return "blocked";
    case "active":
      return "ready";
    case "paused":
      return "waiting";
    case "completed":
      return "replied";
    default:
      return "blocked";
  }
}

export function SequenceList({
  sequences,
  selectedId,
  onSelect,
}: SequenceListProps) {
  if (sequences.length === 0) {
    return (
      <section className="space-y-4">
        <h2 className="type-header">Sequences</h2>
        <p className="text-muted-foreground text-sm">
          No sequences yet. Ask the AI to set up outreach for a campaign.
        </p>
      </section>
    );
  }

  return (
    <section className="space-y-4">
      <h2 className="type-header">Sequences</h2>
      <div className="border-border overflow-hidden rounded-lg border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-border bg-muted/50 border-b">
              <th className="px-4 py-2.5 text-left font-medium">Sequence</th>
              <th className="px-4 py-2.5 text-left font-medium">Campaign</th>
              <th className="px-4 py-2.5 text-left font-medium">Progress</th>
              <th className="px-4 py-2.5 text-left font-medium">Status</th>
              <th className="px-4 py-2.5 text-left font-medium">Send window</th>
              <th className="w-24 px-4 py-2.5" />
            </tr>
          </thead>
          <tbody>
            {sequences.map((seq) => (
              <tr
                key={seq.id}
                className={`border-border cursor-pointer border-b last:border-b-0 transition-colors ${
                  selectedId === seq.id ? "bg-muted/30" : "hover:bg-muted/20"
                }`}
                onClick={() => onSelect(seq.id)}
              >
                <td className="px-4 py-2.5 font-medium">{seq.name}</td>
                <td className="text-muted-foreground px-4 py-2.5">
                  {seq.campaign_name}
                </td>
                <td className="px-4 py-2.5">
                  <SequenceProgressBar
                    enrolled={seq.enrolled}
                    waiting={seq.waiting}
                    sent={seq.sent}
                    replied={seq.replied}
                  />
                </td>
                <td className="px-4 py-2.5">
                  <StatusPill status={mapSequenceStatus(seq.status)}>
                    {seq.status}
                  </StatusPill>
                </td>
                <td className="px-4 py-2.5">
                  <SendWindowScopeSelect seq={seq} />
                </td>
                <td className="px-4 py-2.5">
                  {seq.status === "draft" && (
                    <ReviewButton sequenceId={seq.id} />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
