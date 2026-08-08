"use client";

import { useEffect, useRef, useState } from "react";
import { Linkedin, Loader2, Mail, Plus, Search, UserPlus } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { apiFetch } from "@/lib/api-fetch";

interface OrphanRow {
  id: string;
  name: string;
  title: string | null;
  linkedin_url: string | null;
  work_email: string | null;
}

interface AddPersonDialogProps {
  organizationId: string;
  campaignId?: string;
  onAdded?: () => void | Promise<void>;
}

export function AddPersonDialog({
  organizationId,
  campaignId,
  onAdded,
}: AddPersonDialogProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<OrphanRow[]>([]);
  const [searching, setSearching] = useState(false);
  const [addingId, setAddingId] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Monotonic request sequence. The debounce only clears the pending timer,
  // not a fetch already in flight, so a slow earlier query could resolve
  // after a newer one and paint stale results under the newer query text.
  const searchSeqRef = useRef(0);

  // Debounced search whenever the dialog is open and query changes.
  useEffect(() => {
    if (!open) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);

    debounceRef.current = setTimeout(async () => {
      const seq = ++searchSeqRef.current;
      setSearching(true);
      try {
        const url = `/api/people/orphans${query ? `?q=${encodeURIComponent(query)}` : ""}`;
        const res = await apiFetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const { people } = (await res.json()) as { people: OrphanRow[] };
        if (seq !== searchSeqRef.current) return;
        setResults(people);
      } catch (err) {
        console.error("[orphans-search] failed:", err);
        if (seq === searchSeqRef.current) setResults([]);
      } finally {
        if (seq === searchSeqRef.current) setSearching(false);
      }
    }, 200);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, open]);

  // Reset state on open.
  useEffect(() => {
    if (!open) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setQuery("");
  }, [open]);

  async function add(personId: string) {
    setAddingId(personId);
    try {
      const res = await apiFetch(`/api/people/${personId}/to-company`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          organizationId,
          campaignId,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }
      toast.success("Added to company.");
      setResults((prev) => prev.filter((p) => p.id !== personId));
      await Promise.resolve(onAdded?.());
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to add");
    } finally {
      setAddingId(null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button
        variant="ghost"
        size="xs"
        onClick={() => setOpen(true)}
        title="Add an unassigned person to this company"
      >
        <UserPlus className="h-3.5 w-3.5" />
        Add person
      </Button>

      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add unassigned person</DialogTitle>
        </DialogHeader>

        <div className="relative">
          <Search className="text-muted-foreground absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search name, title, email, or LinkedIn URL"
            className="pl-8"
            autoFocus
          />
        </div>

        <div className="-mx-4 max-h-[50vh] overflow-y-auto px-4">
          {searching && results.length === 0 ? (
            <div className="text-muted-foreground flex items-center justify-center gap-2 py-6 text-xs">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Searching…
            </div>
          ) : results.length === 0 ? (
            <p className="text-muted-foreground py-6 text-center text-xs">
              {query
                ? `No unassigned people match "${query}".`
                : "No unassigned people in your knowledge base."}
            </p>
          ) : (
            <ul className="divide-border divide-y">
              {results.map((p) => (
                <li
                  key={p.id}
                  className="flex items-center justify-between gap-3 py-2"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{p.name}</div>
                    {p.title && (
                      <div className="text-muted-foreground truncate text-xs">
                        {p.title}
                      </div>
                    )}
                    <div className="text-muted-foreground/80 mt-0.5 flex items-center gap-2 text-xs">
                      {p.linkedin_url && (
                        <span className="inline-flex items-center gap-1">
                          <Linkedin className="h-3 w-3" />
                          LinkedIn
                        </span>
                      )}
                      {p.work_email && (
                        <span className="inline-flex items-center gap-1 truncate">
                          <Mail className="h-3 w-3" />
                          {p.work_email}
                        </span>
                      )}
                    </div>
                  </div>
                  <Button
                    variant="outline"
                    size="xs"
                    onClick={() => add(p.id)}
                    disabled={addingId === p.id}
                  >
                    {addingId === p.id ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <Plus className="h-3 w-3" />
                    )}
                    Add
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="flex justify-end pt-1">
          <DialogClose
            render={
              <Button variant="ghost" size="sm">
                Done
              </Button>
            }
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
