"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Plus, Trash2 } from "lucide-react";
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
import { profileDisplayName } from "@/lib/types/profile";
import type { UserProfile } from "@/lib/types/profile";

export default function ProfilesIndexPage() {
  const [profiles, setProfiles] = useState<UserProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;

    const fetchProfiles = async () => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("user_profile")
        .select("*")
        .order("created_at", { ascending: false });

      if (mountedRef.current) {
        // A failed load is not "No profiles yet": that empty state tells the
        // user to create one, and following it mints a duplicate seller
        // identity that compose then picks from ambiguously.
        if (error) {
          setLoadError(error.message);
        } else {
          setLoadError(null);
          setProfiles(Array.isArray(data) ? data : []);
        }
        setLoading(false);
      }
    };

    fetchProfiles();
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const handleDelete = async (profile: UserProfile) => {
    if (profiles.length <= 1) {
      toast.error("You need at least one profile");
      return;
    }

    setDeletingId(profile.id);
    const supabase = createClient();
    const { error } = await supabase
      .from("user_profile")
      .delete()
      .eq("id", profile.id);

    if (error) {
      toast.error(`Failed to delete: ${error.message}`);
      setDeletingId(null);
      return;
    }

    setProfiles((prev) => prev.filter((p) => p.id !== profile.id));
    toast.success(`Deleted "${profileDisplayName(profile)}"`);
    setDeletingId(null);
  };

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="space-y-6 p-4 md:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="type-title">Profiles</h1>
            <p className="text-muted-foreground text-sm">
              Each profile is a seller identity with its own company, offering,
              and links. Click a name to open it.
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            render={<Link href="/profile/new" />}
          >
            <Plus className="mr-1.5 h-4 w-4" />
            New Profile
          </Button>
        </div>

        {loading ? (
          <div className="space-y-2">
            <div className="bg-muted/40 h-9 w-full animate-pulse rounded" />
            <div className="bg-muted/40 h-9 w-full animate-pulse rounded" />
            <div className="bg-muted/40 h-9 w-full animate-pulse rounded" />
          </div>
        ) : loadError ? (
          <p role="alert" className="text-destructive text-sm">
            Could not load profiles: {loadError}. Your profiles are likely still
            there: reload rather than creating a new one.
          </p>
        ) : profiles.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No profiles yet. Create one so the agent knows who it is writing as.
          </p>
        ) : (
          <div className="border-border overflow-hidden rounded-lg border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-border bg-muted/50 border-b">
                  <th className="px-4 py-2.5 text-left font-medium">Name</th>
                  <th className="px-4 py-2.5 text-left font-medium">Company</th>
                  <th className="w-12 px-4 py-2.5" />
                </tr>
              </thead>
              <tbody>
                {profiles.map((profile) => (
                  <tr
                    key={profile.id}
                    className="border-border border-b last:border-b-0"
                  >
                    <td className="px-4 py-2.5">
                      <Link
                        href={`/profile/${profile.id}`}
                        className="focus-visible:ring-ring rounded-sm hover:underline focus-visible:outline-none focus-visible:ring-2"
                      >
                        {profileDisplayName(profile)}
                      </Link>
                    </td>
                    <td className="text-muted-foreground px-4 py-2.5">
                      {profile.company_name ?? ""}
                    </td>
                    <td className="px-4 py-2.5">
                      <Dialog>
                        <DialogTrigger
                          render={
                            <Button
                              variant="ghost"
                              size="icon-xs"
                              aria-label="Delete profile"
                              disabled={
                                deletingId === profile.id ||
                                profiles.length <= 1
                              }
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          }
                        />
                        <DialogContent>
                          <DialogTitle>Delete profile</DialogTitle>
                          <DialogDescription>
                            This will permanently delete &quot;
                            {profileDisplayName(profile)}&quot;. Campaigns
                            linked to it will be unlinked. This cannot be
                            undone.
                          </DialogDescription>
                          <DialogFooter>
                            <DialogClose render={<Button variant="outline" />}>
                              Cancel
                            </DialogClose>
                            <Button
                              variant="destructive"
                              onClick={() => handleDelete(profile)}
                              disabled={deletingId === profile.id}
                            >
                              {deletingId === profile.id
                                ? "Deleting..."
                                : "Delete Profile"}
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
