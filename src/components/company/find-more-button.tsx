"use client";

import { useState } from "react";
import { Loader2, Search } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { apiFetch } from "@/lib/api-fetch";

interface FindMoreButtonProps {
  companyId: string;
  onComplete?: () => void;
}

export function FindMoreButton({ companyId, onComplete }: FindMoreButtonProps) {
  const [busy, setBusy] = useState(false);

  async function run() {
    setBusy(true);
    try {
      const res = await apiFetch(
        `/api/companies/${companyId}/find-more-people`,
        {
          method: "POST",
        },
      );
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }
      const { added, found, uncertainCount, rejectedAsWrongCompany, error } =
        (await res.json()) as {
          added: number;
          found: number;
          uncertainCount?: number;
          rejectedAsWrongCompany?: number;
          error?: string;
        };

      // A refusal (e.g. the company has no domain on record, so contacts cannot
      // be told apart from another company of the same name) comes back 200
      // with an explanation. Dropping it left the user staring at "no new
      // people found" with no idea why or what would fix it.
      if (error) {
        toast.error(error);
      } else if (added === 0) {
        toast.info(`Searched ${found} results, no new people found.`);
      } else {
        const notes = [];
        if (uncertainCount)
          notes.push(`${uncertainCount} unconfirmed — blocked from outreach`);
        if (rejectedAsWrongCompany)
          notes.push(`${rejectedAsWrongCompany} work elsewhere`);
        toast.success(
          `Added ${added} new ${added === 1 ? "person" : "people"}.` +
            (notes.length ? ` ${notes.join(", ")}.` : ""),
        );
      }
      onComplete?.();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to find more people",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button onClick={run} disabled={busy} variant="outline" size="sm">
      {busy ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : (
        <Search className="h-3.5 w-3.5" />
      )}
      Find more people
    </Button>
  );
}
