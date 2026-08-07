import Link from "next/link";

import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface ReviewButtonProps {
  /** Without a sequence, links to the ad-hoc review queue. */
  sequenceId?: string | null;
  variant?: "default" | "outline" | "ghost";
  size?: "sm" | "default";
  label?: string;
  className?: string;
}

export function ReviewButton({
  sequenceId,
  variant = "outline",
  size = "sm",
  label = "Review",
  className,
}: ReviewButtonProps) {
  return (
    <Link
      href={
        sequenceId
          ? `/outreach/review?sequence=${sequenceId}`
          : "/outreach/review"
      }
      className={cn(buttonVariants({ variant, size }), className)}
    >
      {label}
    </Link>
  );
}
