"use client";

import { useCallback, useEffect, useState } from "react";
import dynamic from "next/dynamic";

import { StatCards } from "@/components/dashboard/stat-cards";
import { CampaignTable } from "@/components/dashboard/campaign-table";
import {
  ListRowsSkeleton,
  PageHeaderSkeleton,
  StatsRowSkeleton,
} from "@/components/ui/skeleton-presets";
import { apiFetch } from "@/lib/api-fetch";

const OutreachChart = dynamic(
  () =>
    import("@/components/dashboard/outreach-chart").then(
      (m) => m.OutreachChart,
    ),
  {
    ssr: false,
    loading: () => (
      <div className="bg-muted/40 h-64 animate-pulse rounded-lg" />
    ),
  },
);

interface DashboardData {
  totals: {
    leads: number;
    sent: number;
    replied: number;
    bounced: number;
  };
  timeSeries: Array<{
    date: string;
    sent: number;
    replied: number;
    bounced: number;
  }>;
  campaigns: Array<{
    id: string;
    name: string;
    status: string;
    leads: number;
    sent: number;
    replied: number;
    replyRate: number;
  }>;
}

export default function DashboardPage() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [range, setRange] = useState("30d");
  // The range the rendered data actually belongs to. Kept separately from
  // `range` so a failed refetch cannot label stale 30d numbers as the 90d the
  // user just asked for.
  const [loadedRange, setLoadedRange] = useState("30d");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async (r: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/dashboard?range=${r}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setData(json);
      setLoadedRange(r);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      console.error("[dashboard] Failed to fetch:", err);
      setError(message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchData(range);
  }, [range, fetchData]);

  const handleRangeChange = (newRange: string) => {
    setRange(newRange);
  };

  if (loading && !data) {
    return (
      <div className="flex-1 overflow-y-auto">
        <div className="space-y-6 p-4 md:p-6">
          <PageHeaderSkeleton />
          <StatsRowSkeleton count={4} />
          <div className="bg-muted/40 h-64 animate-pulse rounded-lg" />
          <ListRowsSkeleton count={3} />
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <p className="text-muted-foreground text-sm">
            {error
              ? `Failed to load dashboard: ${error}`
              : "Failed to load dashboard"}
          </p>
          <button
            type="button"
            onClick={() => fetchData(range)}
            className="bg-foreground/10 hover:bg-foreground/15 rounded-md px-3 py-1.5 text-xs font-medium"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="space-y-6 p-4 md:p-6">
        <div>
          <h1 className="type-title">Overview</h1>
          <p className="text-muted-foreground text-sm">
            Cross-campaign performance at a glance.
          </p>
        </div>

        {/* A failed refetch used to render silently: the old numbers stayed
            up under the newly selected range's label, wrong data presented as
            the requested range with no way to tell. */}
        {error && (
          <p role="alert" className="text-destructive text-sm">
            Could not refresh the dashboard: {error}. Showing the last loaded
            data instead.
          </p>
        )}

        <StatCards totals={data.totals} />

        <OutreachChart
          timeSeries={data.timeSeries}
          range={loadedRange}
          onRangeChange={handleRangeChange}
        />

        <div className="animate-rise [--rise-delay:300ms]">
          <h2 className="mb-3 type-header">Campaigns</h2>
          <CampaignTable campaigns={data.campaigns} />
        </div>
      </div>
    </div>
  );
}
