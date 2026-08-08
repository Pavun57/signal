"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { apiFetch } from "@/lib/api-fetch";

interface LearningRow {
  id: string;
  category: "copy" | "timing" | "targeting";
  statement: string;
  confidence: "low" | "medium" | "high";
  status: "active" | "retired" | "user_dismissed";
  source: "analysis" | "user" | "agent";
  evidence: { note?: string } | null;
  created_at: string;
  last_evaluated_at: string | null;
}

interface TimingRow {
  weekday: number;
  day_part: string;
  sends: number;
  replies: number;
  positive: number;
}

interface SuppressionRow {
  id: string;
  email: string;
  reason: string;
  source: string;
  detail: string | null;
  created_at: string;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DAY_PARTS = [
  "early",
  "morning",
  "midday",
  "afternoon",
  "evening",
  "night",
];
const DAY_PART_HOURS: Record<string, string> = {
  early: "5-9",
  morning: "9-12",
  midday: "12-14",
  afternoon: "14-17",
  evening: "17-21",
  night: "21-5",
};

/**
 * What the outcome feedback loop has learned, rendered on /email-skills
 * beside the voice it composes with. Three parts: the learning rows the
 * weekly analysis maintains (edit / retire / dismiss), the send-time
 * performance grid behind any timing learnings, and the suppression list.
 */
export function LearningsSection() {
  const [learnings, setLearnings] = useState<LearningRow[]>([]);
  const [timing, setTiming] = useState<TimingRow[]>([]);
  const [suppressions, setSuppressions] = useState<SuppressionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const mountedRef = useRef(true);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch("/api/learnings");
      if (!mountedRef.current) return;
      // A failed load must not render as the "Nothing yet" empty state.
      if (!res.ok) {
        setLoadError(`HTTP ${res.status}`);
        return;
      }
      const data = await res.json();
      if (!mountedRef.current) return;
      setLoadError(null);
      setLearnings(data.learnings ?? []);
      setTiming(data.timing ?? []);
      setSuppressions(data.suppressions ?? []);
    } catch (err) {
      if (mountedRef.current) {
        setLoadError(err instanceof Error ? err.message : "load failed");
      }
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    // Same pattern as email-settings.tsx: the loader only touches state
    // after its awaits, so the sync-setState warning is a false positive.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
    return () => {
      mountedRef.current = false;
    };
  }, [load]);

  const patchLearning = async (
    id: string,
    body: { statement?: string; status?: string },
    successMessage: string,
  ) => {
    try {
      const res = await apiFetch(`/api/learnings/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? "Update failed");
        return;
      }
      toast.success(successMessage);
      setEditingId(null);
      await load();
    } catch {
      toast.error("Update failed");
    }
  };

  const removeSuppression = async (id: string, email: string) => {
    try {
      const res = await apiFetch(`/api/learnings/suppressions/${id}`, {
        method: "DELETE",
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? "Failed to remove");
        return;
      }
      toast.success(`${email} can be contacted again`);
      await load();
    } catch {
      toast.error("Failed to remove");
    }
  };

  if (loading) {
    return (
      <div className="border-border bg-card rounded-xl border px-5 py-6 md:px-6">
        <div className="text-muted-foreground flex items-center gap-2 text-sm">
          <Loader2 className="size-4 animate-spin" />
          Loading learnings...
        </div>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="border-border bg-card rounded-xl border px-5 py-6 md:px-6">
        <p role="alert" className="text-destructive text-sm">
          Could not load learnings: {loadError}. Reload to retry.
        </p>
      </div>
    );
  }

  const hasTiming = timing.some((t) => t.sends > 0);
  const visible = learnings.filter((l) => l.status !== "user_dismissed");

  return (
    <div className="border-border bg-card rounded-xl border">
      <div className="border-border border-b px-5 py-4 md:px-6">
        <h2 className="type-large text-foreground">Learnings</h2>
        <p className="text-muted-foreground text-sm">
          What the weekly analysis of your sends and replies has learned. Active
          copy and targeting learnings shape every future draft; you can edit,
          retire, or dismiss any of them.
        </p>
      </div>

      {visible.length === 0 ? (
        <p className="text-muted-foreground px-5 py-5 text-sm md:px-6">
          Nothing yet. Learnings appear once there are enough sends and
          classified replies for the weekly analysis to say something it can
          back with numbers.
        </p>
      ) : (
        <ul>
          {visible.map((l) => (
            <li
              key={l.id}
              className="border-border border-b px-5 py-3 last:border-b-0 md:px-6"
            >
              {editingId === l.id ? (
                <div className="space-y-2">
                  <textarea
                    className="border-border bg-background text-foreground w-full rounded-md border p-2 text-sm"
                    rows={2}
                    maxLength={500}
                    value={editText}
                    onChange={(e) => setEditText(e.target.value)}
                    aria-label="Edit learning statement"
                  />
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      onClick={() =>
                        patchLearning(
                          l.id,
                          { statement: editText },
                          "Learning updated",
                        )
                      }
                      disabled={!editText.trim()}
                    >
                      Save
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setEditingId(null)}
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 space-y-1">
                    <p
                      className={`text-sm ${
                        l.status === "retired"
                          ? "text-muted-foreground line-through"
                          : "text-foreground"
                      }`}
                    >
                      {l.statement}
                    </p>
                    <p className="text-muted-foreground text-xs">
                      {l.category} · {l.confidence} confidence ·{" "}
                      {l.source === "analysis"
                        ? "from your reply data"
                        : l.source === "agent"
                          ? "added by the agent"
                          : "added by you"}
                      {l.evidence?.note ? ` · ${l.evidence.note}` : ""}
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-1.5">
                    {l.status === "active" ? (
                      <>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            setEditingId(l.id);
                            setEditText(l.statement);
                          }}
                        >
                          Edit
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() =>
                            patchLearning(
                              l.id,
                              { status: "retired" },
                              "Learning retired: it no longer shapes drafts",
                            )
                          }
                        >
                          Retire
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() =>
                            patchLearning(
                              l.id,
                              { status: "user_dismissed" },
                              "Dismissed: the analysis will never propose this again",
                            )
                          }
                        >
                          Dismiss
                        </Button>
                      </>
                    ) : (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          patchLearning(
                            l.id,
                            { status: "active" },
                            "Learning reactivated",
                          )
                        }
                      >
                        Reactivate
                      </Button>
                    )}
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {hasTiming && (
        <div className="border-border border-t px-5 py-4 md:px-6">
          <p className="text-foreground text-sm font-medium">
            Replies by send time
          </p>
          <p className="text-muted-foreground mb-3 text-xs">
            Genuine replies per sends, by when the email went out (auto-replies
            and bounces excluded). Small numbers: read trends, not gospel.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[540px] text-xs">
              <thead>
                <tr className="text-muted-foreground">
                  <th className="py-1 pr-2 text-left font-medium">Hours</th>
                  {WEEKDAYS.map((d) => (
                    <th key={d} className="px-2 py-1 text-right font-medium">
                      {d}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {DAY_PARTS.map((part) => (
                  <tr key={part} className="border-border border-t">
                    <td className="text-muted-foreground py-1.5 pr-2">
                      {part} ({DAY_PART_HOURS[part]})
                    </td>
                    {WEEKDAYS.map((_, weekday) => {
                      const cell = timing.find(
                        (t) => t.weekday === weekday && t.day_part === part,
                      );
                      return (
                        <td
                          key={weekday}
                          className="text-foreground px-2 py-1.5 text-right tabular-nums"
                        >
                          {cell && cell.sends > 0
                            ? `${cell.replies}/${cell.sends}`
                            : "·"}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {suppressions.length > 0 && (
        <div className="border-border border-t px-5 py-4 md:px-6">
          <p className="text-foreground text-sm font-medium">Suppressed</p>
          <p className="text-muted-foreground mb-2 text-xs">
            Never contacted again: they unsubscribed, declined, or you asked.
          </p>
          <ul className="space-y-1.5">
            {suppressions.map((s) => (
              <li
                key={s.id}
                className="flex items-center justify-between gap-3"
              >
                <div className="min-w-0">
                  <p className="text-foreground truncate text-sm">{s.email}</p>
                  <p className="text-muted-foreground text-xs">
                    {s.reason === "unsubscribe"
                      ? "asked to stop being contacted"
                      : s.reason === "not_interested"
                        ? "declined earlier outreach"
                        : "suppressed by you"}
                    {s.detail ? ` · ${s.detail}` : ""}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => removeSuppression(s.id, s.email)}
                >
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
