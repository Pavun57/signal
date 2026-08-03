"use client";

import { useState } from "react";
import { Loader2, Sparkles } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { apiFetch } from "@/lib/api-fetch";

interface BulkEnrichResponse {
  enriched?: number;
  failed?: number;
  attempted?: number;
  remaining?: number;
  alreadyEnriched?: number;
  summary?: string;
}

/**
 * "Enrich all" for one company's contacts.
 *
 * Confirms first, and the dialog leads with the count. Enrichment spends real
 * money per contact, so a mis-click on a large company is not something to
 * find out about afterwards.
 *
 * Deliberately no cost figure. Each enrichment fans out to LinkedIn, X and
 * three Exa searches and only one of those has a documented per-call price, so
 * any number here would be invented -- and an invented number in a spend
 * confirmation is worse than none, because it is the thing you would rely on.
 */
export function EnrichAllButton({
  campaignId,
  organizationId,
  unenrichedCount,
  onDone,
}: {
  campaignId: string;
  organizationId: string;
  unenrichedCount: number;
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [running, setRunning] = useState(false);

  if (unenrichedCount <= 0) return null;

  const run = async () => {
    setRunning(true);
    try {
      const res = await apiFetch("/api/enrich/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ campaignId, organizationId }),
      });
      // apiFetch returns the Response unchanged and never throws on a non-2xx,
      // so without this an error body reads as a run that enriched nobody.
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }
      const data = (await res
        .json()
        .catch(() => null)) as BulkEnrichResponse | null;

      // The route caps each batch and skips anyone already enriched, so its
      // own summary is the accurate sentence; the fallback only covers a
      // response that predates it.
      toast.success(
        data?.summary ?? `Enriched ${data?.enriched ?? 0} contacts.`,
      );
      setOpen(false);
      onDone();
    } catch (err) {
      console.error("[enrich/bulk] Failed:", err);
      toast.error(err instanceof Error ? err.message : "Failed to enrich");
    } finally {
      setRunning(false);
    }
  };

  const noun = unenrichedCount === 1 ? "contact" : "contacts";

  return (
    <>
      <Button
        size="xs"
        variant="outline"
        onClick={() => setOpen(true)}
        title={`Enrich ${unenrichedCount} ${noun} at this company`}
      >
        <Sparkles className="h-3 w-3" />
        Enrich all ({unenrichedCount})
      </Button>

      <Dialog open={open} onOpenChange={(v) => !running && setOpen(v)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              Enrich {unenrichedCount} {noun}?
            </DialogTitle>
            <DialogDescription>
              This spends enrichment credits, one charge per contact, and can
              take a couple of minutes. Contacts enriched in the last week are
              skipped.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setOpen(false)}
              disabled={running}
            >
              Cancel
            </Button>
            <Button size="sm" onClick={run} disabled={running}>
              {running ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Enriching
                </>
              ) : (
                `Enrich ${unenrichedCount}`
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
