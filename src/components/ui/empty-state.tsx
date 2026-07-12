import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";

type EmptyAccent = "primary" | "info" | "warn" | "success" | "category";

const accentStyles: Record<EmptyAccent, string> = {
  primary: "bg-primary/10 text-primary",
  info: "bg-info/10 text-info",
  warn: "bg-warn/10 text-warn",
  success: "bg-success/10 text-success",
  category: "bg-category/10 text-category",
};

interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description?: string;
  accent?: EmptyAccent;
  action?: React.ReactNode;
  className?: string;
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  accent = "primary",
  action,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-3 px-6 py-10 text-center",
        className,
      )}
    >
      <span
        aria-hidden
        className={cn(
          "flex size-10 items-center justify-center rounded-full",
          accentStyles[accent],
        )}
      >
        <Icon className="size-5" />
      </span>

      <div className="space-y-1">
        <p className="text-foreground text-sm font-medium">{title}</p>
        {description && (
          <p className="text-muted-foreground max-w-xs text-xs">
            {description}
          </p>
        )}
      </div>

      {action}
    </div>
  );
}
