"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import {
  ListRowsSkeleton,
  PageHeaderSkeleton,
} from "@/components/ui/skeleton-presets";
import { Textarea } from "@/components/ui/textarea";
import { createClient } from "@/lib/supabase/client";
import { useUser } from "@clerk/nextjs";
import { profileDisplayName } from "@/lib/types/profile";
import type { UserProfile, ProfileFormData } from "@/lib/types/profile";

const emptyForm: ProfileFormData = {
  label: "",
  name: "",
  email: "",
  role_title: "",
  company_name: "",
  company_url: "",
  personal_url: "",
  linkedin_url: "",
  twitter_url: "",
  offering_summary: "",
  notes: "",
};

/**
 * Edits one profile, mirroring how /campaigns/[id] is the detail view for the
 * /campaigns table. "/profile/new" lands here too — ids are UUIDs, so the
 * literal segment "new" can only mean create mode.
 */
export default function ProfileDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const isNew = params.id === "new";

  const { user: clerkUser } = useUser();
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [form, setForm] = useState<ProfileFormData>(emptyForm);
  const [loading, setLoading] = useState(!isNew);
  const [notFound, setNotFound] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (isNew) return;

    const load = async () => {
      const supabase = createClient();
      const { data } = await supabase
        .from("user_profile")
        .select("*")
        .eq("id", params.id)
        .maybeSingle();

      if (!data) {
        setNotFound(true);
        setLoading(false);
        return;
      }

      const p = data as UserProfile;
      setProfile(p);
      setForm({
        label: p.label ?? "",
        name: p.name ?? "",
        email: p.email ?? "",
        role_title: p.role_title ?? "",
        company_name: p.company_name ?? "",
        company_url: p.company_url ?? "",
        personal_url: p.personal_url ?? "",
        linkedin_url: p.linkedin_url ?? "",
        twitter_url: p.twitter_url ?? "",
        offering_summary: p.offering_summary ?? "",
        notes: p.notes ?? "",
      });
      setLoading(false);
    };
    void load();
  }, [isNew, params.id]);

  const update = (field: keyof ProfileFormData, value: string) => {
    setForm((prev) => ({ ...prev, [field]: value }));
  };

  const handleSave = async () => {
    setSaving(true);
    const supabase = createClient();

    const payload = Object.fromEntries(
      Object.entries(form).map(([k, v]) => [k, v === "" ? null : v]),
    );

    try {
      if (profile) {
        const { error } = await supabase
          .from("user_profile")
          .update(payload)
          .eq("id", profile.id);
        if (error) throw error;

        setProfile((prev) =>
          prev ? ({ ...prev, ...payload } as UserProfile) : prev,
        );
        toast.success("Profile saved");
      } else {
        if (!clerkUser?.id) {
          toast.error("Still signing in, try again in a moment");
          setSaving(false);
          return;
        }
        const { data, error } = await supabase
          .from("user_profile")
          .insert({ ...payload, user_id: clerkUser.id })
          .select("*")
          .single();
        if (error) throw error;

        const newProfile = data as UserProfile;
        setProfile(newProfile);
        toast.success("Profile created");
        // The URL still says /profile/new; point it at the row that now
        // exists so a reload edits instead of drafting a second copy.
        router.replace(`/profile/${newProfile.id}`);
      }
    } catch (err) {
      toast.error(
        `Failed to save: ${err instanceof Error ? err.message : "Unknown error"}`,
      );
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex-1 overflow-y-auto">
        <div className="space-y-8 p-4 md:p-6">
          <PageHeaderSkeleton />
          <ListRowsSkeleton count={4} />
        </div>
      </div>
    );
  }

  if (notFound) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-muted-foreground text-sm">Profile not found</p>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="space-y-8 p-4 md:p-6">
        <div>
          <h1 className="type-title">
            {profile ? profileDisplayName(profile) : "New Profile"}
          </h1>
          <p className="text-muted-foreground text-sm">
            A seller identity with its own company, offering, and links.
          </p>
          <Link
            href="/profile"
            className="text-muted-foreground hover:text-foreground mt-2 inline-block text-xs underline underline-offset-2"
          >
            All profiles
          </Link>
        </div>

        <Separator />

        {/* Profile Label */}
        <section className="space-y-4">
          <div className="space-y-2">
            <label htmlFor="label" className="text-sm font-medium leading-none">
              Profile Label
            </label>
            <Input
              id="label"
              value={form.label ?? ""}
              onChange={(e) => update("label", e.target.value)}
              placeholder="e.g. SaaS Sales, Consulting, Agency Work"
            />
            <p className="text-muted-foreground text-xs">
              A short name to identify this profile when linking it to
              campaigns.
            </p>
          </div>
        </section>

        <Separator />

        {/* Personal Info */}
        <section className="space-y-4">
          <h2 className="type-header">Personal Info</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <label
                htmlFor="name"
                className="text-sm font-medium leading-none"
              >
                Name
              </label>
              <Input
                id="name"
                value={form.name ?? ""}
                onChange={(e) => update("name", e.target.value)}
                placeholder="Your full name"
                required
                aria-required="true"
              />
            </div>
            <div className="space-y-2">
              <label
                htmlFor="email"
                className="text-sm font-medium leading-none"
              >
                Email
              </label>
              <Input
                id="email"
                type="email"
                value={form.email ?? ""}
                onChange={(e) => update("email", e.target.value)}
                placeholder="you@company.com"
                required
                aria-required="true"
              />
            </div>
          </div>
          <div className="space-y-2">
            <label
              htmlFor="role_title"
              className="text-sm font-medium leading-none"
            >
              Role / Title
            </label>
            <Input
              id="role_title"
              value={form.role_title ?? ""}
              onChange={(e) => update("role_title", e.target.value)}
              placeholder="e.g. Founder & CEO"
            />
          </div>
        </section>

        <Separator />

        {/* Company & Links */}
        <section className="space-y-4">
          <h2 className="type-header">Company & Links</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <label
                htmlFor="company_name"
                className="text-sm font-medium leading-none"
              >
                Company Name
              </label>
              <Input
                id="company_name"
                value={form.company_name ?? ""}
                onChange={(e) => update("company_name", e.target.value)}
                placeholder="Your company"
              />
            </div>
            <div className="space-y-2">
              <label
                htmlFor="company_url"
                className="text-sm font-medium leading-none"
              >
                Company Website
              </label>
              <Input
                id="company_url"
                type="url"
                value={form.company_url ?? ""}
                onChange={(e) => update("company_url", e.target.value)}
                placeholder="https://yourcompany.com"
              />
            </div>
          </div>
          <div className="space-y-2">
            <label
              htmlFor="personal_url"
              className="text-sm font-medium leading-none"
            >
              Personal Website
            </label>
            <Input
              id="personal_url"
              type="url"
              value={form.personal_url ?? ""}
              onChange={(e) => update("personal_url", e.target.value)}
              placeholder="https://yoursite.com"
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <label
                htmlFor="linkedin_url"
                className="text-sm font-medium leading-none"
              >
                LinkedIn
              </label>
              <Input
                id="linkedin_url"
                type="url"
                value={form.linkedin_url ?? ""}
                onChange={(e) => update("linkedin_url", e.target.value)}
                placeholder="https://linkedin.com/in/yourname"
              />
            </div>
            <div className="space-y-2">
              <label
                htmlFor="twitter_url"
                className="text-sm font-medium leading-none"
              >
                X / Twitter
              </label>
              <Input
                id="twitter_url"
                type="url"
                value={form.twitter_url ?? ""}
                onChange={(e) => update("twitter_url", e.target.value)}
                placeholder="https://x.com/yourhandle"
              />
            </div>
          </div>
        </section>

        <Separator />

        {/* About Your Offering */}
        <section className="space-y-4">
          <h2 className="type-header">About Your Offering</h2>
          <div className="space-y-2">
            <label
              htmlFor="offering_summary"
              className="text-sm font-medium leading-none"
            >
              What are you selling?
            </label>
            <Textarea
              id="offering_summary"
              value={form.offering_summary ?? ""}
              onChange={(e) => update("offering_summary", e.target.value)}
              placeholder="Describe your product or service in a few sentences. What problem does it solve? Who is it for?"
              rows={4}
            />
          </div>
          <div className="space-y-2">
            <label htmlFor="notes" className="text-sm font-medium leading-none">
              Additional Notes
            </label>
            <Textarea
              id="notes"
              value={form.notes ?? ""}
              onChange={(e) => update("notes", e.target.value)}
              placeholder="Anything else Signal should know -- target market, differentiators, constraints, tone preferences, etc."
              rows={4}
            />
          </div>
        </section>

        <div className="flex justify-end pb-2">
          <Button
            onClick={handleSave}
            disabled={saving || !form.name?.trim() || !form.email?.trim()}
          >
            {saving ? "Saving..." : profile ? "Save Profile" : "Create Profile"}
          </Button>
        </div>
      </div>
    </div>
  );
}
