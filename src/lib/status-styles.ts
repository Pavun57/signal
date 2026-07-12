/**
 * Centralized status-style maps used across the UI for rendering
 * colored labels/pills/badges. Each entry pairs a human-readable `label`
 * with a Tailwind `className` (bg + text utilities combined).
 *
 * Keep keys in sync with the underlying DB enum values (campaigns.status,
 * campaign_people.outreach_status, campaign_organizations.readiness_tag).
 */

import type { ReadinessTag } from "@/lib/types/tracking";

export type StatusStyle = {
  label: string;
  className: string;
};

/**
 * Campaign lifecycle status. Keys match `campaigns.status` values.
 * Labels preserve the prior behavior of rendering the raw DB value
 * (lowercase) inside the pill.
 */
export type CampaignStatus =
  | "discovery"
  | "researching"
  | "active"
  | "paused"
  | "completed";

export const campaignStatusStyles: Record<CampaignStatus, StatusStyle> = {
  discovery: {
    label: "discovery",
    className: "bg-info/15 text-info",
  },
  researching: {
    label: "researching",
    className: "bg-warn/15 text-warn",
  },
  active: {
    label: "active",
    className: "bg-success/15 text-success",
  },
  paused: {
    label: "paused",
    className: "bg-muted text-muted-foreground",
  },
  completed: {
    label: "completed",
    className: "bg-muted text-muted-foreground",
  },
};

// Solid bg color used for the small dot indicator in the sidebar nav (no text).
export const campaignStatusDotStyles: Record<CampaignStatus, string> = {
  discovery: "bg-info",
  researching: "bg-warn",
  active: "bg-success",
  paused: "bg-muted-foreground/60",
  completed: "bg-muted-foreground/40",
};

/**
 * Outreach status for a contact in a campaign. Keys match
 * `campaign_people.outreach_status` values (minus `not_contacted`, which
 * renders nothing in the UI).
 */
export type OutreachStatus =
  | "queued"
  | "sent"
  | "delivered"
  | "opened"
  | "clicked"
  | "replied"
  | "bounced"
  | "complained";

// Colors track the funnel, not the individual state: pending (muted), in
// flight (info), engaged (warn -> category), won (success), failed
// (destructive). Adjacent states share a hue; the label disambiguates.
export const outreachStatusStyles: Record<OutreachStatus, StatusStyle> = {
  queued: {
    label: "Queued",
    className: "bg-muted text-muted-foreground",
  },
  sent: {
    label: "Sent",
    className: "bg-info/10 text-info",
  },
  opened: {
    label: "Opened",
    className: "bg-warn/10 text-warn",
  },
  replied: {
    label: "Replied",
    className: "bg-success/10 text-success",
  },
  delivered: {
    label: "Delivered",
    className: "bg-info/20 text-info",
  },
  clicked: {
    label: "Clicked",
    className: "bg-category/10 text-category",
  },
  bounced: {
    label: "Bounced",
    className: "bg-destructive/10 text-destructive",
  },
  complained: {
    label: "Spam",
    className: "bg-destructive/10 text-destructive",
  },
};

/**
 * Enrichment status for a contact or company. Keys match the
 * `enrichment_status` values on people/organizations. The dot indicator
 * in the UI uses the solid bg color from `className`; the accompanying
 * label renders as plain text.
 */
export type EnrichmentStatus =
  | "pending"
  | "in_progress"
  | "enriched"
  | "failed";

export const enrichmentStatusStyles: Record<EnrichmentStatus, StatusStyle> = {
  pending: { label: "Pending", className: "bg-muted-foreground/40" },
  in_progress: { label: "In Progress", className: "bg-warn" },
  enriched: { label: "Enriched", className: "bg-success" },
  failed: { label: "Failed", className: "bg-destructive" },
};

/**
 * Readiness tag shown next to companies being tracked. Keys match
 * `ReadinessTag` from `@/lib/types/tracking`.
 */
export const trackingReadinessStyles: Record<ReadinessTag, StatusStyle> = {
  ready_to_contact: {
    label: "Ready",
    className: "bg-success/10 text-success",
  },
  monitoring: {
    label: "Monitoring",
    className: "bg-warn/10 text-warn",
  },
  not_ready: {
    label: "Not Ready",
    className: "bg-muted text-muted-foreground",
  },
};
