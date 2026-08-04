"use client";

import { useEffect } from "react";
import { RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";

/**
 * There was no error boundary anywhere in the app, and at least two components
 * were reachable ways to lose a whole route: activity-detail and cost-center
 * both did `.then(r => r.json())` with no `res.ok` check, so a 500 whose body
 * is `{error: ...}` set state to "loaded" with truthy data and the next field
 * read threw. The result was a blank page with nothing to click.
 *
 * A route-level boundary turns that into something recoverable, and `reset()`
 * retries the segment without a full reload.
 */
export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[route error]", error);
  }, [error]);

  return (
    <div className="flex flex-1 items-center justify-center p-8">
      <div className="max-w-md text-center">
        <h2 className="type-header">Something broke on this page</h2>
        <p className="text-muted-foreground mt-2 text-sm">
          The rest of the app is fine. This section failed to load, and nothing
          you had already saved is affected.
        </p>
        {error.digest ? (
          <p className="text-muted-foreground mt-2 font-mono text-xs">
            Reference: {error.digest}
          </p>
        ) : null}
        <Button className="mt-4" onClick={reset}>
          <RefreshCw className="h-4 w-4" />
          Try again
        </Button>
      </div>
    </div>
  );
}
