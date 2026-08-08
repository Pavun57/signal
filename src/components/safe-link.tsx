"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";

import { useStreaming } from "@/lib/streaming-context";

/**
 * A Link wrapper that prompts the user before navigating away
 * if an agent chat is actively streaming.
 */
export function SafeLink({
  href,
  children,
  onClick,
  ...props
}: React.ComponentProps<typeof Link>) {
  const { isStreaming, confirmNavigation } = useStreaming();
  const router = useRouter();

  return (
    <Link
      href={href}
      onClick={(e) => {
        if (isStreaming) {
          e.preventDefault();
          if (confirmNavigation()) {
            // The caller's onClick still fires on this path: callers hang
            // state updates off it (sidebar-campaigns selects the campaign),
            // and skipping it desynced their state from the page navigated
            // to whenever a confirmation was involved.
            onClick?.(e);
            router.push(typeof href === "string" ? href : href.toString());
          }
          return;
        }
        onClick?.(e);
      }}
      {...props}
    >
      {children}
    </Link>
  );
}
