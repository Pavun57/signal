"use client";

import { useState } from "react";
import { Handle, Position, type NodeProps } from "reactflow";
import { Linkedin, Loader2, Mail, Trash2 } from "lucide-react";

import { outreachStatusStyles, type OutreachStatus } from "@/lib/status-styles";
import { cn } from "@/lib/utils";

// Pill colors and labels come from the shared map, so a contact can't show one
// status colour in the outreach table and a different one in the org chart.
// Only the ring — which the table has no equivalent of — lives here.
const STATUS_RINGS: Record<OutreachStatus, string> = {
  queued: "ring-border",
  sent: "ring-info/30",
  delivered: "ring-info/30",
  opened: "ring-warn/30",
  clicked: "ring-category/30",
  replied: "ring-success/40",
  bounced: "ring-destructive/30",
  complained: "ring-destructive/30",
};

const NOT_CONTACTED = {
  bg: "bg-muted text-muted-foreground",
  ring: "ring-border",
  label: "Not contacted",
};

function statusStyle(status: string) {
  const shared = outreachStatusStyles[status as OutreachStatus];
  if (!shared) return NOT_CONTACTED;

  return {
    bg: shared.className,
    ring: STATUS_RINGS[status as OutreachStatus],
    label: shared.label,
  };
}

export interface PersonNodeData {
  personId: string;
  name: string;
  title: string | null;
  department: string | null;
  seniority: string | null;
  linkedin_url: string | null;
  work_email: string | null;
  outreach_status: string | null;
  role_summary: string | null;
  enrichment_status: string | null;
  onRemove?: (personId: string) => void | Promise<void>;
}

function EnrichmentLabel({ status }: { status: string | null }) {
  if (status === "enriched") {
    return (
      <span className="text-[10px] font-medium text-success">Enriched</span>
    );
  }
  if (status === "in_progress") {
    return (
      <span className="text-[10px] font-medium text-warn">Enriching…</span>
    );
  }
  if (status === "failed") {
    return (
      <span className="text-[10px] font-medium text-destructive">
        Enrichment failed
      </span>
    );
  }
  return (
    <span className="text-muted-foreground text-[10px]">Not enriched</span>
  );
}

export function PersonNode({ data, selected }: NodeProps<PersonNodeData>) {
  const status = data.outreach_status ?? "not_contacted";
  const style = statusStyle(status);

  const [confirming, setConfirming] = useState(false);
  const [removing, setRemoving] = useState(false);

  async function handleRemove(e: React.MouseEvent) {
    e.stopPropagation();
    if (!data.onRemove || removing) return;
    setRemoving(true);
    try {
      await data.onRemove(data.personId);
    } finally {
      setRemoving(false);
      setConfirming(false);
    }
  }

  return (
    <div
      className={cn(
        "group border-border bg-card relative w-[240px] cursor-pointer rounded-md border p-2.5 shadow-sm ring-1 transition-all hover:shadow-md",
        style.ring,
        selected && "ring-2 ring-primary",
      )}
    >
      <Handle type="target" position={Position.Top} className="!opacity-0" />
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{data.name}</div>
          {data.title && (
            <div className="text-muted-foreground truncate text-xs">
              {data.title}
            </div>
          )}
          <div className="mt-1">
            <EnrichmentLabel status={data.enrichment_status} />
          </div>
        </div>
        <span
          className={cn(
            "shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium",
            style.bg,
          )}
        >
          {style.label}
        </span>
      </div>

      {data.role_summary && (
        <div className="text-muted-foreground mt-1.5 line-clamp-1 text-[11px]">
          {data.role_summary}
        </div>
      )}

      <div className="mt-2 flex items-center gap-2">
        {data.linkedin_url && (
          <a
            href={data.linkedin_url}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="text-muted-foreground hover:text-foreground"
            aria-label="LinkedIn"
          >
            <Linkedin className="h-3.5 w-3.5" />
          </a>
        )}
        {data.work_email && (
          <a
            href={`mailto:${data.work_email}`}
            onClick={(e) => e.stopPropagation()}
            className="text-muted-foreground hover:text-foreground"
            aria-label="Email"
          >
            <Mail className="h-3.5 w-3.5" />
          </a>
        )}
        {data.onRemove && (
          <button
            type="button"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              setConfirming(true);
            }}
            className="text-muted-foreground hover:text-destructive ml-auto opacity-0 transition-opacity group-hover:opacity-100"
            aria-label="Remove from company"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {confirming && data.onRemove && (
        <div
          className="bg-card/95 absolute inset-0 flex flex-col items-center justify-center gap-2 rounded-md p-2 text-center"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        >
          <p className="text-xs font-medium">Remove from company?</p>
          <p className="text-muted-foreground text-[10px] leading-tight">
            Person record stays in your knowledge base.
          </p>
          <div className="flex gap-1.5">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setConfirming(false);
              }}
              disabled={removing}
              className="border-border hover:bg-muted rounded border px-2 py-0.5 text-[11px]"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleRemove}
              disabled={removing}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90 inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px]"
            >
              {removing ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Trash2 className="h-3 w-3" />
              )}
              {removing ? "Removing…" : "Remove"}
            </button>
          </div>
        </div>
      )}
      <Handle type="source" position={Position.Bottom} className="!opacity-0" />
    </div>
  );
}
