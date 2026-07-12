"use client";

import { Activity } from "lucide-react";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";

import { EmptyState } from "@/components/ui/empty-state";

// Colors come from the theme tokens so the chart tracks light/dark, and match
// the accent on the matching stat card above it.
const series = [
  { key: "sent", name: "Sent", color: "var(--color-info)" },
  { key: "opened", name: "Opened", color: "var(--color-warn)" },
  { key: "replied", name: "Replied", color: "var(--color-success)" },
] as const;

interface TimeSeriesPoint {
  date: string;
  sent: number;
  opened: number;
  replied: number;
  bounced: number;
}

interface OutreachChartProps {
  timeSeries: TimeSeriesPoint[];
  range: string;
  onRangeChange: (range: string) => void;
}

const ranges = ["7d", "30d", "All"];

export function OutreachChart({
  timeSeries,
  range,
  onRangeChange,
}: OutreachChartProps) {
  return (
    <div className="border-border animate-rise rounded-lg border p-4 [--rise-delay:240ms]">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-sm font-semibold">Outreach Activity</h2>
        <div className="flex gap-1">
          {ranges.map((r) => (
            <button
              key={r}
              onClick={() => onRangeChange(r === "All" ? "all" : r)}
              className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                range === (r === "All" ? "all" : r)
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-muted"
              }`}
            >
              {r}
            </button>
          ))}
        </div>
      </div>

      {timeSeries.length === 0 ? (
        <EmptyState
          icon={Activity}
          accent="info"
          title="No outreach activity yet"
          description="Sends, opens, and replies will chart here once your first sequence goes out."
          className="h-[200px] py-0"
        />
      ) : (
        <ResponsiveContainer width="100%" height={240}>
          <AreaChart data={timeSeries}>
            <defs>
              {series.map(({ key, color }) => (
                <linearGradient
                  key={key}
                  id={`fill-${key}`}
                  x1="0"
                  y1="0"
                  x2="0"
                  y2="1"
                >
                  <stop offset="0%" stopColor={color} stopOpacity={0.28} />
                  <stop offset="100%" stopColor={color} stopOpacity={0.02} />
                </linearGradient>
              ))}
            </defs>
            <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
            <XAxis
              dataKey="date"
              tick={{ fontSize: 11 }}
              tickFormatter={(d: string) => {
                const date = new Date(d + "T00:00:00");
                return date.toLocaleDateString("en-US", {
                  month: "short",
                  day: "numeric",
                });
              }}
              className="text-muted-foreground"
            />
            <YAxis
              tick={{ fontSize: 11 }}
              allowDecimals={false}
              className="text-muted-foreground"
            />
            <Tooltip
              contentStyle={{
                borderRadius: "8px",
                fontSize: "12px",
                border: "1px solid var(--color-border)",
                backgroundColor: "var(--color-background)",
              }}
            />
            {series.map(({ key, name, color }) => (
              <Area
                key={key}
                type="monotone"
                dataKey={key}
                name={name}
                stroke={color}
                fill={`url(#fill-${key})`}
                strokeWidth={2}
                activeDot={{ r: 4, strokeWidth: 2 }}
              />
            ))}
          </AreaChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}
