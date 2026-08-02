"use client";

import { useMemo, useState } from "react";
import { Loader2, RotateCw } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { AddPersonDialog } from "./add-person-dialog";
import { OrgChart, type OrgChartPerson } from "./org-chart";
import { PersonDrawer } from "./person-drawer";
import type { CampaignContact, Seniority } from "@/lib/types/campaign";
import { apiFetch } from "@/lib/api-fetch";

interface EmbeddedOrgChartProps {
  organizationId: string;
  campaignId?: string;
  contacts: CampaignContact[];
  onEnrich?: (contactId: string) => void | Promise<void>;
  onDataChanged?: () => void | Promise<void>;
}

export function EmbeddedOrgChart({
  organizationId,
  campaignId,
  contacts,
  onEnrich,
  onDataChanged,
}: EmbeddedOrgChartProps) {
  const [selectedPersonId, setSelectedPersonId] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const people: OrgChartPerson[] = useMemo(
    () =>
      contacts.map((c) => ({
        id: c.person_id,
        name: c.name,
        title: c.title,
        department: c.department,
        seniority: c.seniority,
        role_summary: c.role_summary,
        linkedin_url: c.linkedin_url,
        work_email: c.work_email,
        outreach_status: c.outreach_status,
        enrichment_status: c.enrichment_status,
      })),
    [contacts],
  );

  const selectedContact = useMemo(
    () => contacts.find((c) => c.person_id === selectedPersonId) ?? null,
    [contacts, selectedPersonId],
  );

  const uncategorizedCount = useMemo(
    () => contacts.filter((c) => !c.department).length,
    [contacts],
  );

  async function refresh() {
    setRefreshing(true);
    try {
      const res = await fetch(
        `/api/companies/${organizationId}/classify-departments`,
        { method: "POST" },
      );
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }
      const { classified } = (await res.json()) as { classified: number };
      if (classified === 0) {
        toast.info("Org chart is up to date.");
      } else {
        toast.success(
          `Classified ${classified} ${classified === 1 ? "person" : "people"}.`,
        );
      }
      await Promise.resolve(onDataChanged?.());
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Refresh failed");
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <div className="space-y-2 px-4 py-3">
      <div className="flex items-center justify-between">
        <span className="text-muted-foreground text-xs">
          {contacts.length} {contacts.length === 1 ? "person" : "people"}
          {uncategorizedCount > 0 && (
            <span className="text-muted-foreground/70 ml-1">
              · {uncategorizedCount} unclassified
            </span>
          )}
        </span>
        <div className="flex items-center gap-1">
          <AddPersonDialog
            organizationId={organizationId}
            campaignId={campaignId}
            onAdded={onDataChanged}
          />
          <Button
            variant="ghost"
            size="xs"
            onClick={refresh}
            disabled={refreshing}
          >
            {refreshing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RotateCw className="h-3.5 w-3.5" />
            )}
            Refresh org
          </Button>
        </div>
      </div>

      <div className="border-border relative h-[480px] w-full overflow-hidden rounded-md border">
        <OrgChart
          people={people}
          onPersonClick={(id) => setSelectedPersonId(id)}
          onPersonReclassify={async (personId, next) => {
            try {
              const res = await apiFetch(`/api/people/${personId}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  department: next.department,
                  seniority: (next.seniority ?? null) as Seniority | null,
                }),
              });
              if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(err.error ?? `HTTP ${res.status}`);
              }
              await Promise.resolve(onDataChanged?.());
            } catch (err) {
              toast.error(
                err instanceof Error ? err.message : "Failed to reclassify",
              );
              await Promise.resolve(onDataChanged?.());
            }
          }}
          onPersonRemove={async (personId) => {
            try {
              // Names the company this chart is drawn for, so a removal aimed
              // at a stale row is refused instead of detaching the person from
              // whichever company they are filed under now.
              const url = campaignId
                ? `/api/people/${personId}/from-company?campaignId=${campaignId}&organizationId=${organizationId}`
                : `/api/people/${personId}/from-company?organizationId=${organizationId}`;
              const res = await fetch(url, { method: "DELETE" });
              if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(err.error ?? `HTTP ${res.status}`);
              }
              toast.success("Removed from company.");
              await Promise.resolve(onDataChanged?.());
            } catch (err) {
              toast.error(
                err instanceof Error ? err.message : "Failed to remove",
              );
            }
          }}
          fullHeight={false}
        />
        {refreshing && (
          <div className="bg-background/70 supports-backdrop-filter:backdrop-blur-sm pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2">
            <Loader2 className="text-muted-foreground h-5 w-5 animate-spin" />
            <p className="text-foreground text-sm font-medium">
              Classifying
              {uncategorizedCount > 0 ? ` ${uncategorizedCount}` : ""}{" "}
              {uncategorizedCount === 1 ? "person" : "people"}…
            </p>
            <p className="text-muted-foreground text-xs">
              This usually takes 10–30 seconds.
            </p>
          </div>
        )}
      </div>

      <PersonDrawer
        contact={selectedContact}
        onClose={() => setSelectedPersonId(null)}
        onEnrich={onEnrich}
        onRemove={async (personId) => {
          try {
            const url = campaignId
              ? `/api/people/${personId}/from-company?campaignId=${campaignId}&organizationId=${organizationId}`
              : `/api/people/${personId}/from-company?organizationId=${organizationId}`;
            const res = await fetch(url, { method: "DELETE" });
            if (!res.ok) {
              const err = await res.json().catch(() => ({}));
              throw new Error(err.error ?? `HTTP ${res.status}`);
            }
            toast.success("Removed from company.");
            await Promise.resolve(onDataChanged?.());
          } catch (err) {
            toast.error(
              err instanceof Error ? err.message : "Failed to remove",
            );
          }
        }}
      />
    </div>
  );
}
