"use client";

import { useState } from "react";
import { apiFetch } from "@/lib/api-fetch";
import {
  ChevronDown,
  ChevronRight,
  Pause,
  Play,
  RefreshCw,
} from "lucide-react";
import { toast } from "sonner";
import { ReadinessBadge } from "./readiness-badge";
import { TrackingTimeline } from "./tracking-timeline";
import { createClient } from "@/lib/supabase/client";
import type { TrackingChange, ReadinessTag } from "@/lib/types/tracking";

export type ViewMode = "by-signal" | "by-company";

export interface TrackingRow {
  id: string;
  organizationName: string;
  organizationDomain: string | null;
  signalName: string;
  signalCategory: string;
  schedule: string;
  status: string;
  intent: string | null;
  autoSend: boolean;
  lastRunAt: string | null;
  nextRunAt: string | null;
  readinessTag: ReadinessTag | null;
  latestChangeDescription: string | null;
  latestChangeDate: string | null;
}

export interface CompanyGroup {
  organizationName: string;
  organizationDomain: string | null;
  readinessTag: ReadinessTag | null;
  activeSignals: number;
  lastRunAt: string | null;
  latestChangeDescription: string | null;
  latestChangeDate: string | null;
  rows: TrackingRow[];
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return "--";
  return new Date(dateStr).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

function ExpandableSignalRow({ row }: { row: TrackingRow }) {
  const [expanded, setExpanded] = useState(false);
  const [changes, setChanges] = useState<TrackingChange[]>([]);
  const [changesError, setChangesError] = useState<string | null>(null);
  const [loadingChanges, setLoadingChanges] = useState(false);
  const [localStatus, setLocalStatus] = useState(row.status);
  const [running, setRunning] = useState(false);

  const toggleExpand = async () => {
    if (!expanded && changes.length === 0) {
      setLoadingChanges(true);
      const supabase = createClient();
      const { data, error } = await supabase
        .from("tracking_changes")
        .select("*")
        .eq("tracking_config_id", row.id)
        .order("detected_at", { ascending: false })
        .limit(20);
      // A failed load must not render as "No changes recorded yet."
      if (error) setChangesError(error.message);
      else setChangesError(null);
      setChanges((data as TrackingChange[]) ?? []);
      setLoadingChanges(false);
    }
    setExpanded(!expanded);
  };

  const togglePause = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const newStatus = localStatus === "active" ? "paused" : "active";
    setLocalStatus(newStatus);
    const supabase = createClient();
    const { error } = await supabase
      .from("tracking_configs")
      .update({ status: newStatus })
      .eq("id", row.id);
    if (error) {
      toast.error("Failed to update tracking status");
      setLocalStatus(localStatus); // revert on failure
    } else {
      toast.success(
        newStatus === "paused" ? "Tracking paused" : "Tracking resumed",
      );
    }
  };

  const runNow = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setRunning(true);
    const res = await apiFetch(`/api/tracking/${row.id}/run`, {
      method: "POST",
    });
    setRunning(false);
    if (res.ok) {
      toast.success("Check queued: results land within a minute or two");
    } else {
      const body = (await res.json().catch(() => null)) as {
        error?: string;
      } | null;
      toast.error(body?.error ?? "Failed to queue check");
    }
  };

  return (
    <>
      <tr
        className="hover:bg-muted/50 cursor-pointer border-b transition-colors"
        onClick={toggleExpand}
      >
        <td className="w-8 px-3 py-2.5">
          {expanded ? (
            <ChevronDown className="text-muted-foreground size-4" />
          ) : (
            <ChevronRight className="text-muted-foreground size-4" />
          )}
        </td>
        <td className="px-3 py-2.5 text-sm font-medium">
          {row.organizationName}
        </td>
        <td className="px-3 py-2.5 text-sm">
          {row.signalName}
          {row.autoSend && (
            <span
              className="text-muted-foreground ml-1.5 rounded border px-1 py-0.5 text-[10px]"
              title="High-confidence fires send without review"
            >
              auto-send
            </span>
          )}
        </td>
        <td className="text-muted-foreground px-3 py-2.5 text-sm capitalize">
          {row.schedule}
          {localStatus === "paused" ? " (paused)" : ""}
          {!row.intent?.trim() && (
            <span
              className="text-muted-foreground ml-1.5 rounded border px-1 py-0.5 text-[10px]"
              title="No intent configured: this config records changes but will never fire outreach. Update it in Chat."
            >
              observe only
            </span>
          )}
        </td>
        <td className="text-muted-foreground px-3 py-2.5 text-sm">
          {formatDate(row.lastRunAt)}
        </td>
        <td className="px-3 py-2.5 text-sm">
          {row.latestChangeDescription || (
            <span className="text-muted-foreground">No changes</span>
          )}
        </td>
        <td className="px-3 py-2.5">
          <ReadinessBadge tag={row.readinessTag} />
        </td>
        <td className="px-3 py-2.5">
          <div className="flex items-center">
            <button
              type="button"
              onClick={runNow}
              disabled={running || localStatus !== "active"}
              className="text-muted-foreground hover:text-foreground p-1 transition-colors disabled:opacity-40"
              title="Run this check now"
            >
              <RefreshCw
                className={`size-3.5 ${running ? "animate-spin" : ""}`}
              />
            </button>
            <button
              type="button"
              onClick={togglePause}
              className="text-muted-foreground hover:text-foreground p-1 transition-colors"
              title={
                localStatus === "active" ? "Pause tracking" : "Resume tracking"
              }
            >
              {localStatus === "active" ? (
                <Pause className="size-3.5" />
              ) : (
                <Play className="size-3.5" />
              )}
            </button>
          </div>
        </td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={8} className="bg-muted/30 border-b px-6 py-3">
            {changesError && (
              <p role="alert" className="text-destructive px-3 py-2 text-xs">
                Could not load changes: {changesError}
              </p>
            )}
            {loadingChanges ? (
              <p className="text-muted-foreground text-xs">Loading...</p>
            ) : (
              <TrackingTimeline changes={changes} />
            )}
          </td>
        </tr>
      )}
    </>
  );
}

function ExpandableCompanyRow({ group }: { group: CompanyGroup }) {
  const [expanded, setExpanded] = useState(false);
  const [changesError, setChangesError] = useState<string | null>(null);
  const [changesByConfig, setChangesByConfig] = useState<
    Record<string, TrackingChange[]>
  >({});
  const [loadingChanges, setLoadingChanges] = useState(false);

  const toggleExpand = async () => {
    if (!expanded && Object.keys(changesByConfig).length === 0) {
      setLoadingChanges(true);
      const supabase = createClient();
      const configIds = group.rows.map((r) => r.id);
      // A wider window with a per-config cap below: one global limit meant
      // a single chatty config could crowd every other config's timeline
      // out of the 50-row window entirely.
      const { data, error } = await supabase
        .from("tracking_changes")
        .select("*")
        .in("tracking_config_id", configIds)
        .order("detected_at", { ascending: false })
        .limit(200);
      if (error) setChangesError(error.message);
      else setChangesError(null);

      const PER_CONFIG_CAP = 20;
      const grouped: Record<string, TrackingChange[]> = {};
      for (const change of (data as TrackingChange[]) ?? []) {
        const cid = change.tracking_config_id;
        if (!grouped[cid]) grouped[cid] = [];
        if (grouped[cid].length < PER_CONFIG_CAP) grouped[cid].push(change);
      }
      setChangesByConfig(grouped);
      setLoadingChanges(false);
    }
    setExpanded(!expanded);
  };

  return (
    <>
      <tr
        className="hover:bg-muted/50 cursor-pointer border-b transition-colors"
        onClick={toggleExpand}
      >
        <td className="w-8 px-3 py-2.5">
          {expanded ? (
            <ChevronDown className="text-muted-foreground size-4" />
          ) : (
            <ChevronRight className="text-muted-foreground size-4" />
          )}
        </td>
        <td className="px-3 py-2.5 text-sm font-medium">
          {group.organizationName}
        </td>
        <td className="px-3 py-2.5 text-sm">{group.activeSignals} active</td>
        <td className="text-muted-foreground px-3 py-2.5 text-sm">
          {formatDate(group.lastRunAt)}
        </td>
        <td className="px-3 py-2.5 text-sm" colSpan={2}>
          {group.latestChangeDescription || (
            <span className="text-muted-foreground">No changes</span>
          )}
        </td>
        <td className="px-3 py-2.5">
          <ReadinessBadge tag={group.readinessTag} />
        </td>
        <td />
      </tr>
      {expanded && (
        <tr>
          <td colSpan={8} className="bg-muted/30 border-b px-6 py-3">
            {changesError && (
              <p role="alert" className="text-destructive px-3 py-2 text-xs">
                Could not load changes: {changesError}
              </p>
            )}
            {loadingChanges ? (
              <p className="text-muted-foreground text-xs">Loading...</p>
            ) : (
              <div className="space-y-3">
                {group.rows.map((row) => (
                  <div key={row.id}>
                    <p className="text-xs font-medium">{row.signalName}</p>
                    <TrackingTimeline changes={changesByConfig[row.id] ?? []} />
                  </div>
                ))}
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

export function TrackingTable({
  rows,
  viewMode,
}: {
  rows: TrackingRow[];
  viewMode: ViewMode;
}) {
  if (rows.length === 0) {
    return (
      <p className="text-muted-foreground py-12 text-center text-sm">
        No tracking configs found. Set up tracking in Chat to start monitoring
        companies.
      </p>
    );
  }

  if (viewMode === "by-company") {
    // Group rows by organization
    const groupMap = new Map<string, CompanyGroup>();
    for (const row of rows) {
      const key = row.organizationDomain || row.organizationName;
      if (!groupMap.has(key)) {
        groupMap.set(key, {
          organizationName: row.organizationName,
          organizationDomain: row.organizationDomain,
          readinessTag: row.readinessTag,
          activeSignals: 0,
          lastRunAt: null,
          latestChangeDescription: null,
          latestChangeDate: null,
          rows: [],
        });
      }
      const group = groupMap.get(key)!;
      group.rows.push(row);
      if (row.status === "active") group.activeSignals++;
      // Use most recent run/change
      if (
        !group.lastRunAt ||
        (row.lastRunAt && row.lastRunAt > group.lastRunAt)
      ) {
        group.lastRunAt = row.lastRunAt;
      }
      // Compared against the group's own latest CHANGE date: comparing to
      // lastRunAt (possibly overwritten this very iteration) let an older
      // change win over a newer one.
      if (
        row.latestChangeDate &&
        (!group.latestChangeDate ||
          row.latestChangeDate > group.latestChangeDate)
      ) {
        group.latestChangeDate = row.latestChangeDate;
        group.latestChangeDescription = row.latestChangeDescription;
      }
      // Promote readiness: ready > monitoring > not_ready
      if (row.readinessTag === "ready_to_contact") {
        group.readinessTag = "ready_to_contact";
      } else if (
        row.readinessTag === "monitoring" &&
        group.readinessTag !== "ready_to_contact"
      ) {
        group.readinessTag = "monitoring";
      }
    }

    const groups = Array.from(groupMap.values());

    return (
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-left">
          <thead>
            <tr className="bg-muted/50 border-b">
              <th className="w-8 px-3 py-2" />
              <th className="px-3 py-2 text-xs font-medium">Company</th>
              <th className="px-3 py-2 text-xs font-medium">Signals</th>
              <th className="px-3 py-2 text-xs font-medium">Last Check</th>
              <th className="px-3 py-2 text-xs font-medium" colSpan={2}>
                Latest Changes
              </th>
              <th className="px-3 py-2 text-xs font-medium">Status</th>
              <th className="w-10 px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {groups.map((group) => (
              <ExpandableCompanyRow
                key={group.organizationDomain || group.organizationName}
                group={group}
              />
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  // By signal (default)
  return (
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full text-left">
        <thead>
          <tr className="bg-muted/50 border-b">
            <th className="w-8 px-3 py-2" />
            <th className="px-3 py-2 text-xs font-medium">Company</th>
            <th className="px-3 py-2 text-xs font-medium">Signal</th>
            <th className="px-3 py-2 text-xs font-medium">Every</th>
            <th className="px-3 py-2 text-xs font-medium">Last Check</th>
            <th className="px-3 py-2 text-xs font-medium">Changes</th>
            <th className="px-3 py-2 text-xs font-medium">Status</th>
            <th className="w-16 px-3 py-2" />
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <ExpandableSignalRow key={row.id} row={row} />
          ))}
        </tbody>
      </table>
    </div>
  );
}
