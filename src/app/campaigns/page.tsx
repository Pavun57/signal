"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Trash2 } from "lucide-react";
import posthog from "posthog-js";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { createClient } from "@/lib/supabase/client";

interface CampaignRow {
  id: string;
  name: string;
  status: string;
  created_at: string;
}

export default function CampaignsIndexPage() {
  const [campaigns, setCampaigns] = useState<CampaignRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;

    const fetchCampaigns = async () => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("campaigns")
        .select("id, name, status, created_at")
        .order("updated_at", { ascending: false });

      if (mountedRef.current) {
        // A failed load is not "No campaigns yet": that empty state invites
        // creating a duplicate.
        if (error) {
          setLoadError(error.message);
        } else {
          setLoadError(null);
          setCampaigns(data ?? []);
        }
        setLoading(false);
      }
    };

    fetchCampaigns();
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const handleDelete = async (campaign: CampaignRow) => {
    setDeletingId(campaign.id);
    const supabase = createClient();
    const { error } = await supabase
      .from("campaigns")
      .delete()
      .eq("id", campaign.id);

    if (error) {
      toast.error(`Failed to delete: ${error.message}`);
      setDeletingId(null);
      return;
    }

    posthog.capture("campaign_deleted", {
      campaign_id: campaign.id,
      campaign_status: campaign.status,
    });
    setCampaigns((prev) => prev.filter((c) => c.id !== campaign.id));
    toast.success(`Deleted "${campaign.name}"`);
    setDeletingId(null);
  };

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="space-y-6 p-4 md:p-6">
        <div>
          <h1 className="type-title">Campaigns</h1>
          <p className="text-muted-foreground text-sm">
            All campaigns in your workspace. Click a name to open it; delete
            ones you no longer need.
          </p>
        </div>

        {loading ? (
          <div className="space-y-2">
            <div className="bg-muted/40 h-9 w-full animate-pulse rounded" />
            <div className="bg-muted/40 h-9 w-full animate-pulse rounded" />
            <div className="bg-muted/40 h-9 w-full animate-pulse rounded" />
          </div>
        ) : loadError ? (
          <p role="alert" className="text-destructive text-sm">
            Could not load campaigns: {loadError}. Your campaigns are likely
            still there: reload rather than creating a new one.
          </p>
        ) : campaigns.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No campaigns yet. Start one from the chat or the Overview page.
          </p>
        ) : (
          <div className="border-border overflow-hidden rounded-lg border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-border bg-muted/50 border-b">
                  <th className="px-4 py-2.5 text-left font-medium">Name</th>
                  <th className="px-4 py-2.5 text-left font-medium">Status</th>
                  <th className="w-12 px-4 py-2.5" />
                </tr>
              </thead>
              <tbody>
                {campaigns.map((campaign) => (
                  <tr
                    key={campaign.id}
                    className="border-border border-b last:border-b-0"
                  >
                    <td className="px-4 py-2.5">
                      <Link
                        href={`/campaigns/${campaign.id}`}
                        className="focus-visible:ring-ring rounded-sm hover:underline focus-visible:outline-none focus-visible:ring-2"
                      >
                        {campaign.name}
                      </Link>
                    </td>
                    <td className="text-muted-foreground px-4 py-2.5 capitalize">
                      {campaign.status}
                    </td>
                    <td className="px-4 py-2.5">
                      <Dialog>
                        <DialogTrigger
                          render={
                            <Button
                              variant="ghost"
                              size="icon-xs"
                              aria-label="Delete campaign"
                              disabled={deletingId === campaign.id}
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          }
                        />
                        <DialogContent>
                          <DialogTitle>Delete campaign</DialogTitle>
                          {/*
                            The old copy had this backwards. Companies and
                            contacts live in a shared pool and survive; only
                            the campaign's links to them cascade. What does go,
                            and was never mentioned, is sent_emails -- the
                            record of every email this campaign actually sent.
                          */}
                          <DialogDescription>
                            This permanently deletes &quot;{campaign.name}&quot;
                            along with its sequences, drafts, and the record of
                            every email it sent. The companies and contacts
                            themselves are kept, but they will no longer be part
                            of this campaign. This cannot be undone.
                          </DialogDescription>
                          <DialogFooter>
                            <DialogClose render={<Button variant="outline" />}>
                              Cancel
                            </DialogClose>
                            <Button
                              variant="destructive"
                              onClick={() => handleDelete(campaign)}
                              disabled={deletingId === campaign.id}
                            >
                              {deletingId === campaign.id
                                ? "Deleting..."
                                : "Delete Campaign"}
                            </Button>
                          </DialogFooter>
                        </DialogContent>
                      </Dialog>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
