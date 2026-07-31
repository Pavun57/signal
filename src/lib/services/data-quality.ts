import type { SupabaseClient } from "@supabase/supabase-js";

import { normalizeCompanyName } from "@/lib/services/affiliation";

/**
 * Read-only audit of contact and company data.
 *
 * Every check here corresponds to a bug that has already written bad rows, so
 * the point is to find what those bugs left behind. Deliberately reports and
 * never repairs: merging two organizations or moving a person means choosing
 * whose data survives and re-pointing four foreign keys, which is a judgement
 * call for a human. Repair goes through the existing
 * /api/people/[id]/to-company and from-company endpoints once the user agrees.
 */

export interface DataQualityFinding {
  kind:
    | "duplicate_company"
    | "unresolved_company_with_people"
    | "email_domain_mismatch"
    | "duplicate_person"
    | "unverified_affiliation"
    | "unverified_email";
  severity: "high" | "medium" | "low";
  summary: string;
  /** Ids the user would act on. */
  ids: string[];
}

export interface DataQualityReport {
  findings: DataQualityFinding[];
  counts: {
    organizations: number;
    people: number;
    peopleWithOrg: number;
  };
}

const MAX_ROWS = 2000;

export async function runDataQualityAudit(
  supabase: SupabaseClient,
): Promise<DataQualityReport> {
  const findings: DataQualityFinding[] = [];

  const { data: orgs } = await supabase
    .from("organizations")
    .select("id, name, domain")
    .limit(MAX_ROWS);

  const { data: people } = await supabase
    .from("people")
    .select(
      "id, name, title, linkedin_url, organization_id, work_email, work_email_source, work_email_confidence, work_email_verification, affiliation_source, affiliation_confidence",
    )
    .limit(MAX_ROWS);

  const orgList = orgs ?? [];
  const peopleList = people ?? [];
  const orgById = new Map(orgList.map((o) => [o.id, o]));

  // 1. Companies that normalise to the same name. Before the domain-only
  //    identity rule these could have been silently merged into one row; now
  //    they stay separate, which is correct but leaves genuine duplicates to
  //    reconcile.
  const byNormName = new Map<string, typeof orgList>();
  for (const o of orgList) {
    const key = normalizeCompanyName(o.name);
    if (!key) continue;
    const list = byNormName.get(key) ?? [];
    list.push(o);
    byNormName.set(key, list);
  }
  for (const [key, list] of byNormName) {
    if (list.length < 2) continue;
    findings.push({
      kind: "duplicate_company",
      severity: "medium",
      summary: `${list.length} companies normalise to "${key}": ${list
        .map((o) => `${o.name} <${o.domain ?? "no domain"}>`)
        .join(
          ", ",
        )}. If these are the same company, merge them; if not, make sure each has its own domain.`,
      ids: list.map((o) => o.id),
    });
  }

  // 2. Domain-less companies holding people — the highest-risk bucket, because
  //    a company with no domain cannot be told apart from any other of the same
  //    name, so its contact list may be pooled from several businesses.
  const peopleByOrg = new Map<string, typeof peopleList>();
  for (const p of peopleList) {
    if (!p.organization_id) continue;
    const list = peopleByOrg.get(p.organization_id) ?? [];
    list.push(p);
    peopleByOrg.set(p.organization_id, list);
  }
  for (const [orgId, members] of peopleByOrg) {
    const org = orgById.get(orgId);
    if (!org || org.domain) continue;
    findings.push({
      kind: "unresolved_company_with_people",
      severity: "high",
      summary: `"${org.name}" has no domain but holds ${members.length} contact(s). Without a domain this company cannot be distinguished from any other of the same name — resolve its website, then re-verify the contacts.`,
      ids: [orgId],
    });
  }

  // 3. A verified work email whose domain is not the employer's. Usually means
  //    the person was filed under the wrong company.
  for (const p of peopleList) {
    if (!p.work_email || !p.organization_id) continue;
    const org = orgById.get(p.organization_id);
    if (!org?.domain) continue;
    const emailDomain = p.work_email.split("@")[1]?.toLowerCase();
    if (!emailDomain) continue;
    if (emailDomain === org.domain.toLowerCase()) continue;
    // A personal address is a weaker signal than a corporate one at a rival.
    findings.push({
      kind: "email_domain_mismatch",
      severity: "medium",
      summary: `${p.name} is filed under ${org.name} (${org.domain}) but their email is at ${emailDomain}.`,
      ids: [p.id],
    });
  }

  // 4. The same human across multiple organizations — what the LinkedIn URL
  //    host bug produced before canonicalisation.
  const byUrl = new Map<string, typeof peopleList>();
  for (const p of peopleList) {
    if (!p.linkedin_url) continue;
    const list = byUrl.get(p.linkedin_url) ?? [];
    list.push(p);
    byUrl.set(p.linkedin_url, list);
  }
  for (const [url, dupes] of byUrl) {
    if (dupes.length < 2) continue;
    findings.push({
      kind: "duplicate_person",
      severity: "high",
      summary: `${dupes.length} rows share the LinkedIn profile ${url} (${dupes
        .map((d) => d.name)
        .join(", ")}). Merge them — they are one person.`,
      ids: dupes.map((d) => d.id),
    });
  }

  // 5. People whose title names a company other than the one they are filed
  //    under. This is the check that catches the Charly Poly / Inngest case.
  for (const p of peopleList) {
    if (!p.organization_id || !p.title) continue;
    const org = orgById.get(p.organization_id);
    if (!org) continue;
    const match = p.title.match(/\b(?:at|@)\s+([A-Z][\w&.\- ]{2,40})/);
    const named = match?.[1]?.trim();
    if (!named) continue;
    const a = normalizeCompanyName(named);
    const b = normalizeCompanyName(org.name);
    if (!a || !b || a.includes(b) || b.includes(a)) continue;
    findings.push({
      kind: "unverified_affiliation",
      severity: "high",
      summary: `${p.name} is filed under ${org.name}, but their own title reads "${p.title}" — which names ${named}.`,
      ids: [p.id],
    });
  }

  // 6. Blind guesses still sitting in work_email.
  const guesses = peopleList.filter(
    (p) =>
      p.work_email &&
      p.work_email_source === "pattern_derived" &&
      (p.work_email_confidence ?? 0) < 0.5 &&
      p.work_email_verification !== "deliverable",
  );
  if (guesses.length > 0) {
    findings.push({
      kind: "unverified_email",
      severity: "medium",
      summary: `${guesses.length} contact(s) hold a pattern-guessed email that has never been verified. They are blocked from outreach; re-run findEmail with an email provider configured to confirm or replace them.`,
      ids: guesses.map((p) => p.id),
    });
  }

  const severityRank = { high: 0, medium: 1, low: 2 } as const;
  findings.sort((a, b) => severityRank[a.severity] - severityRank[b.severity]);

  return {
    findings,
    counts: {
      organizations: orgList.length,
      people: peopleList.length,
      peopleWithOrg: peopleList.filter((p) => p.organization_id).length,
    },
  };
}
