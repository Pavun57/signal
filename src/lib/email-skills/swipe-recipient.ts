import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * A real campaign contact a batch can be written to. `signals` are compact
 * one-liners drawn from enrichment (news/articles/background titles with
 * dates); everything is bounded because enrichment is scraped content.
 */
export interface RealRecipient {
  personId: string;
  name: string;
  title: string | null;
  company: string | null;
  /** LinkedIn headline, when enrichment scraped one. */
  headline: string | null;
  signals: string[];
  enriched: boolean;
}

const MAX_SIGNALS = 5;
const MAX_SIGNAL_CHARS = 200;

/** Same joining rules as personaLabel, so transcript rotation keys match. */
export function recipientLabel(r: RealRecipient): string {
  const where = [r.title, r.company]
    .map((v) => v?.trim() ?? "")
    .filter(Boolean)
    .join(", ");
  return where ? `${r.name} · ${where}` : r.name;
}

/**
 * One contact per batch, enriched first, never repeating until every
 * candidate has been drafted to (then wrap around). Rotation state is the
 * judged transcript's persona labels, so it survives reloads for free.
 */
export function pickRecipient(
  candidates: RealRecipient[],
  judgedLabels: string[],
): RealRecipient | null {
  if (candidates.length === 0) return null;
  const seen = new Set(judgedLabels);
  const ordered = [...candidates].sort(
    (a, b) => Number(b.enriched) - Number(a.enriched),
  );
  return ordered.find((c) => !seen.has(recipientLabel(c))) ?? ordered[0]!;
}

interface SignalSource {
  title?: unknown;
  publishedDate?: unknown;
}

/** Maps one campaign_people row (with embedded person) to a candidate. */
export function candidateFromRow(row: {
  person?: {
    id?: unknown;
    name?: unknown;
    title?: unknown;
    enrichment_status?: unknown;
    enrichment_data?: unknown;
    organization?: { name?: unknown } | null;
  } | null;
}): RealRecipient | null {
  const p = row.person;
  if (!p?.id || typeof p.name !== "string" || !p.name.trim()) return null;

  const data = (p.enrichment_data ?? {}) as Record<string, unknown>;
  const linkedin = data.linkedin as
    | { profileInfo?: { headline?: unknown } | null }
    | undefined;
  const headline =
    typeof linkedin?.profileInfo?.headline === "string"
      ? linkedin.profileInfo.headline
      : null;

  const signals: string[] = [];
  for (const key of ["news", "articles", "background"] as const) {
    const items = data[key];
    if (!Array.isArray(items)) continue;
    for (const item of items as SignalSource[]) {
      if (signals.length >= MAX_SIGNALS) break;
      if (typeof item?.title !== "string" || !item.title.trim()) continue;
      const date =
        typeof item.publishedDate === "string" && item.publishedDate
          ? ` (${item.publishedDate})`
          : "";
      signals.push(`${item.title}${date}`.slice(0, MAX_SIGNAL_CHARS));
    }
  }

  return {
    personId: String(p.id),
    name: p.name.trim(),
    title: typeof p.title === "string" && p.title.trim() ? p.title : null,
    company:
      typeof p.organization?.name === "string" && p.organization.name.trim()
        ? p.organization.name
        : null,
    headline,
    signals,
    enriched: p.enrichment_status === "enriched",
  };
}

/**
 * All non-rejected contacts in the campaign. Any failure returns [] so the
 * caller falls back to invented personas; voice building never blocks here.
 */
export async function loadRecipientCandidates(
  supabase: SupabaseClient,
  campaignId: string,
): Promise<RealRecipient[]> {
  try {
    const { data, error } = await supabase
      .from("campaign_people")
      .select(
        // !organization_id disambiguates the second people->organizations FK,
        // same hint as PERSON_ENRICH_COLUMNS.
        "person:people(id, name, title, enrichment_status, enrichment_data, organization:organizations!organization_id(name))",
      )
      .eq("campaign_id", campaignId)
      .neq("status", "rejected")
      .limit(200);
    if (error || !data) return [];
    return data
      .map((row) =>
        candidateFromRow(row as Parameters<typeof candidateFromRow>[0]),
      )
      .filter((c): c is RealRecipient => c !== null);
  } catch {
    return [];
  }
}
