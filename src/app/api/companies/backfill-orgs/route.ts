import { getSupabaseAndUser } from "@/lib/supabase/server";
import { recordAffiliation } from "@/lib/services/affiliation";

export const maxDuration = 60;

interface PersonRow {
  id: string;
  enrichment_data: Record<string, unknown> | null;
}

interface OrgRow {
  id: string;
  name: string;
}

function extractCompanySignals(
  enrichment: Record<string, unknown> | null,
): string[] {
  if (!enrichment) return [];

  const signals = new Set<string>();

  // searchPeople stored its query string here.
  const searchQuery = enrichment.searchQuery;
  if (typeof searchQuery === "string") signals.add(searchQuery);

  const linkedin = enrichment.linkedin as
    | { profileInfo?: { headline?: string } | null }
    | undefined;
  const headline = linkedin?.profileInfo?.headline;
  if (typeof headline === "string") signals.add(headline);

  // Raw LinkedIn search result title -- e.g. "Paul Klein - Founder of Browserbase"
  const rawTitle = enrichment.rawTitle;
  if (typeof rawTitle === "string") signals.add(rawTitle);

  return [...signals];
}

/** Escape a company name for safe use inside a RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Longest company name that appears in the person's text signals.
 *
 * Matching is word-boundary anchored. Plain substring matching — what this did
 * before — pairs "Meta" with "Metadata Inc.", "Signal" with "signal
 * processing", and "Ramp" with "rampant", silently filing people under
 * companies they have never worked for. A boundary match is still only a
 * lexical hint, never proof, which is why the caller records it as the weakest
 * affiliation source rather than as a settled fact.
 */
function findOrgMatch(signals: string[], orgs: OrgRow[]): string | null {
  const text = signals.join(" \n ").toLowerCase();
  if (!text) return null;

  let best: { id: string; len: number } | null = null;
  for (const org of orgs) {
    const name = org.name.toLowerCase().trim();
    if (name.length < 3) continue;
    const boundary = new RegExp(
      `(^|[^a-z0-9])${escapeRegExp(name)}([^a-z0-9]|$)`,
    );
    if (boundary.test(text)) {
      if (!best || name.length > best.len) {
        best = { id: org.id, len: name.length };
      }
    }
  }
  return best?.id ?? null;
}

/** Nothing in scope. Same shape as a run that found no matches. */
const NOTHING_TO_DO = { scanned: 0, linked: 0, notWritten: 0, unmatched: 0 };

/**
 * One-off cleanup: re-link people that landed in the knowledge base with
 * organization_id = null. Looks at each person's enrichment_data for company
 * name signals and matches against existing organizations.
 *
 * Idempotent: safe to run multiple times. Only touches rows that are still
 * orphaned and only updates organization_id when a confident match is found.
 *
 * Scope: both halves are drawn through the caller's own campaigns. This takes
 * no input whatsoever -- no body, no ids -- so without that, one POST from any
 * signed-in account read every organization and up to 500 orphaned people
 * across the whole install and re-parented other people's contacts to other
 * people's companies. `people` and `organizations` are shared pools with no
 * owner column, so the campaign join tables are the only handle on who holds
 * what, exactly as /api/people/orphans uses them for these same rows.
 */
export async function POST() {
  const ctx = await getSupabaseAndUser();
  if (!ctx) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { supabase, user } = ctx;

  const { data: orgLinks, error: orgLinksErr } = await supabase
    .from("campaign_organizations")
    .select("organization_id, campaign:campaigns!inner(user_id)")
    .eq("campaign.user_id", user.id);

  if (orgLinksErr) {
    return Response.json({ error: orgLinksErr.message }, { status: 500 });
  }

  const orgIds = [
    ...new Set(
      ((orgLinks ?? []) as Array<{ organization_id: string }>).map(
        (r) => r.organization_id,
      ),
    ),
  ];

  const { data: personLinks, error: personLinksErr } = await supabase
    .from("campaign_people")
    .select("person_id, campaign:campaigns!inner(user_id)")
    .eq("campaign.user_id", user.id);

  if (personLinksErr) {
    return Response.json({ error: personLinksErr.message }, { status: 500 });
  }

  const personIds = [
    ...new Set(
      ((personLinks ?? []) as Array<{ person_id: string }>).map(
        (r) => r.person_id,
      ),
    ),
  ];

  // An empty `in` list is not a no-op in PostgREST, so say so explicitly
  // rather than letting an unfiltered query stand in for "nothing of yours".
  if (orgIds.length === 0 || personIds.length === 0) {
    return Response.json(NOTHING_TO_DO);
  }

  const { data: orgs, error: orgsErr } = await supabase
    .from("organizations")
    .select("id, name")
    .in("id", orgIds);

  if (orgsErr) {
    return Response.json({ error: orgsErr.message }, { status: 500 });
  }

  const { data: orphans, error: peopleErr } = await supabase
    .from("people")
    .select("id, enrichment_data")
    .is("organization_id", null)
    .in("id", personIds)
    .limit(500);

  if (peopleErr) {
    return Response.json({ error: peopleErr.message }, { status: 500 });
  }

  const orgList = (orgs ?? []) as OrgRow[];
  const rows = (orphans ?? []) as PersonRow[];

  let linked = 0;
  /** Matched to an org, but the write was refused or failed. Not linked. */
  let notWritten = 0;
  const unmatched: string[] = [];

  for (const row of rows) {
    const signals = extractCompanySignals(row.enrichment_data);
    const orgId = findOrgMatch(signals, orgList);
    if (!orgId) {
      unmatched.push(row.id);
      continue;
    }
    // Recorded as search_stamp — the weakest source — because a company name
    // appearing in someone's headline is a lexical hint, not evidence of
    // employment. Writing it as a bare organization_id, as this did before,
    // made a guess indistinguishable from a confirmed employee.
    try {
      // Only count what was actually written. These rows are selected as
      // orphans, so a refusal means something changed underneath the query or
      // the update failed, and either way nobody was linked.
      const write = await recordAffiliation(supabase, {
        personId: row.id,
        organizationId: orgId,
        source: "search_stamp",
        evidence: "company name matched in stored profile text",
      });
      if (write.written) linked += 1;
      else notWritten += 1;
    } catch (err) {
      notWritten += 1;
      console.error("[backfill-orgs] recordAffiliation failed:", err);
    }
  }

  return Response.json({
    scanned: rows.length,
    linked,
    notWritten,
    unmatched: unmatched.length,
  });
}
