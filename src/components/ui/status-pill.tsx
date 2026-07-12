import { cn } from "@/lib/utils";
import {
  OUTREACH_STATUS,
  type OutreachStatus,
  type OutreachTone,
} from "@/lib/outreach/status";

const TONE_STYLES: Record<OutreachTone, string> = {
  primary: "bg-primary/10 text-primary",
  warn: "bg-warn/15 text-warn",
  muted: "bg-muted text-muted-foreground",
  success: "bg-success/10 text-success",
  neutral: "bg-muted text-muted-foreground",
};

interface StatusPillProps {
  status: OutreachStatus;
  children?: React.ReactNode;
  className?: string;
}

export function StatusPill({ status, children, className }: StatusPillProps) {
  const def = OUTREACH_STATUS[status];
  return (
    <span
      className={cn(
        "inline-flex min-w-[1.5rem] items-center justify-center rounded-full px-1.5 py-0.5 text-xs font-medium tabular-nums",
        TONE_STYLES[def.tone],
        className,
      )}
    >
      {children ?? def.label}
    </span>
  );
}

export { TONE_STYLES as statusToneStyles };
