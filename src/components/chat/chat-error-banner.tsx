"use client";

import Link from "next/link";
import { AlertCircle, RotateCw } from "lucide-react";

import { Button } from "@/components/ui/button";

/** Clerk rejects the request before the route runs, so the body is its own. */
function isAuthError(error: Error): boolean {
  const text = `${error.message}`.toLowerCase();
  return (
    text.includes("unauthorized") ||
    text.includes("401") ||
    text.includes("signed out")
  );
}

interface ChatErrorBannerProps {
  error: Error;
  onRetry: () => void;
}

export function ChatErrorBanner({ error, onRetry }: ChatErrorBannerProps) {
  const auth = isAuthError(error);

  return (
    <div
      role="alert"
      className="border-destructive/30 bg-destructive/5 mx-4 mb-2 flex items-start gap-2.5 rounded-lg border px-3 py-2.5"
    >
      <AlertCircle className="text-destructive mt-0.5 size-4 shrink-0" />

      <div className="min-w-0 flex-1">
        <p className="text-destructive text-sm font-medium">
          {auth ? "Your session expired" : "The agent stopped unexpectedly"}
        </p>
        <p className="text-muted-foreground mt-0.5 text-xs">
          {auth
            ? "Sign in again to pick up where you left off. Your messages are saved."
            : error.message}
        </p>
      </div>

      {auth ? (
        <Button
          size="sm"
          variant="outline"
          nativeButton={false}
          render={<Link href="/login" />}
        >
          Sign in
        </Button>
      ) : (
        <Button size="sm" variant="outline" onClick={onRetry}>
          <RotateCw />
          Retry
        </Button>
      )}
    </div>
  );
}
