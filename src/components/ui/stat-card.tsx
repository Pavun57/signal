"use client";

import type { LucideIcon } from "lucide-react";

import { useCountUp } from "@/hooks/use-count-up";
import { cn } from "@/lib/utils";

export type StatAccent = "primary" | "info" | "warn" | "success" | "category";

// Tailwind can't build class names from a variable, so each accent spells its
// utilities out in full.
const accentStyles: Record<
  StatAccent | "neutral",
  { chip: string; rule: string }
> = {
  primary: { chip: "bg-primary/10 text-primary", rule: "bg-primary" },
  info: { chip: "bg-info/10 text-info", rule: "bg-info" },
  warn: { chip: "bg-warn/10 text-warn", rule: "bg-warn" },
  success: { chip: "bg-success/10 text-success", rule: "bg-success" },
  category: { chip: "bg-category/10 text-category", rule: "bg-category" },
  neutral: { chip: "bg-muted text-muted-foreground", rule: "bg-border" },
};

interface StatCardProps {
  label: string;
  value: string | number;
  sublabel?: string;
  size?: "default" | "sm";
  accent?: StatAccent;
  icon?: LucideIcon;
  className?: string;
}

export function StatCard({
  label,
  value,
  sublabel,
  size = "default",
  accent,
  icon: Icon,
  className,
}: StatCardProps) {
  const isNumeric = typeof value === "number";
  const counted = useCountUp(isNumeric ? value : 0);
  const display = isNumeric ? counted.toLocaleString() : value;

  // An icon with no accent still renders, in neutral — dropping it silently
  // because a sibling prop is missing is the more surprising behaviour.
  const styles = accentStyles[accent ?? "neutral"];
  const showRule = accent !== undefined;

  return (
    <div
      className={cn(
        "border-border lift relative overflow-hidden rounded-lg border px-3 py-2.5",
        className,
      )}
    >
      {showRule && (
        <span
          aria-hidden
          className={cn("absolute inset-x-0 top-0 h-0.5", styles.rule)}
        />
      )}

      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-baseline gap-1.5">
            <span
              className={cn(
                "font-semibold tabular-nums",
                size === "sm" ? "text-xl" : "text-2xl",
              )}
            >
              {display}
            </span>
            {sublabel && (
              <span className="text-muted-foreground text-xs tabular-nums">
                {sublabel}
              </span>
            )}
          </div>
          <span className="text-muted-foreground text-xs">{label}</span>
        </div>

        {Icon && (
          <span
            aria-hidden
            className={cn(
              "flex size-7 shrink-0 items-center justify-center rounded-md",
              styles.chip,
            )}
          >
            <Icon className="size-3.5" />
          </span>
        )}
      </div>
    </div>
  );
}
