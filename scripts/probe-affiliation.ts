/**
 * Read-only affiliation probe.
 *
 *   pnpm probe:affiliation                                  # Browserbase, default titles
 *   pnpm probe:affiliation Vercel                           # another company, default titles
 *   pnpm probe:affiliation Vercel "Developer Relations" "Solutions Engineer"
 *
 * Runs the real discovery search (one Exa people-search per title, the same
 * query shape as contact-discovery.ts) and hands the candidates to the real
 * `filterContactsByCompany`, then prints the verdict distribution and a
 * per-candidate table. It imports the judge rather than reimplementing it, so
 * what it measures is what ships: a local copy of the prompt would drift from
 * production and quietly keep reporting the old numbers.
 *
 * Changes nothing. No database client is opened, no person is created, no
 * affiliation is recorded. The only side effects are the API calls below.
 *
 * It costs real money: one Exa search per title plus one Haiku call for the
 * judge, roughly a cent a run at the default five titles.
 *
 * What to look for. The 2026-08-01 baseline on Browserbase was 33 verified,
 * 3 former_employee, 1 rejected and 3 uncertain out of 39 candidates, with Exa
 * returning usable page text for 39 of 39. Mostly `uncertain` means the page
 * text is not reaching the prompt, which is the failure this whole design
 * exists to prevent. Mostly `rejected` means the judge has tipped back into the
 * hard headline filter that once deleted 22 of 41 genuine contacts. Either way,
 * read the evidence column before touching the prompt.
 */
import { readFileSync } from "node:fs";

for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^([A-Z_0-9]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}

import {
  filterContactsByCompany,
  type CandidateContact,
  type CompanyContext,
} from "@/lib/services/contact-filter";
import { ExaService } from "@/lib/services/exa-service";
import { normalizeLinkedInUrl } from "@/lib/services/knowledge-base";
import { parseLinkedInTitle } from "@/lib/utils";

/**
 * The company the 2026-08-01 baseline was measured against, with the context
 * the judge uses to disambiguate similarly-named employers. Any other company
 * runs with nulls unless the PROBE_* env vars below fill them in, which makes
 * that disambiguation weaker; the probe says so in its output.
 */
const BASELINE: CompanyContext = {
  name: "Browserbase",
  domain: "browserbase.com",
  industry: "Technology, Information and Internet",
  location: "San Francisco, California",
  description: "Browser infrastructure for AI agents.",
};

/** The five titles the agent searched in the transcript this plan came from. */
const DEFAULT_TITLES = [
  "Developer Relations",
  "Head of Growth",
  "Customer Engineer",
  "Growth Engineer",
  "Software Engineer",
];

/** Matches the `numResults` discovery uses when the agent does not override it. */
const NUM_RESULTS = 10;

/** Below this, Exa gave us a stub rather than a profile worth reading. */
const USABLE_TEXT_CHARS = 200;

interface Candidate extends CandidateContact {
  url: string;
}

function buildCompany(name: string): CompanyContext {
  if (name.toLowerCase() === BASELINE.name.toLowerCase()) return BASELINE;
  return {
    name,
    domain: process.env.PROBE_DOMAIN || null,
    industry: process.env.PROBE_INDUSTRY || null,
    location: process.env.PROBE_LOCATION || null,
    description: process.env.PROBE_DESCRIPTION || null,
  };
}

/**
 * The same query, category and dedup as contact-discovery.ts phase 2. Kept in
 * step by hand: the probe is meant to reproduce the discovery path, and a
 * different query would measure a different population of candidates.
 */
async function collectCandidates(
  company: CompanyContext,
  titles: string[],
): Promise<Candidate[]> {
  const exa = new ExaService();
  const searches = await Promise.all(
    titles.map(async (title) => {
      const query = `"${company.name}" ${title} site:linkedin.com`;
      try {
        const result = await exa.search(query, {
          numResults: NUM_RESULTS,
          category: "people" as const,
          includeText: true,
        });
        return { title, results: result.results };
      } catch (err) {
        console.error(`  search failed: ${query}`, err);
        return { title, results: [] };
      }
    }),
  );

  const seen = new Set<string>();
  const out: Candidate[] = [];

  for (const search of searches) {
    for (const result of search.results) {
      // Individual profiles only. A /company/ or /school/ page parses into a
      // "person" named after the company, whose headline then obviously names
      // the target, so the judge confirms a contact that does not exist.
      const isProfile = /linkedin\.com\/in\//i.test(result.url);
      if (!isProfile && /linkedin\.com/i.test(result.url)) continue;

      const linkedinUrl = isProfile ? normalizeLinkedInUrl(result.url) : null;
      const dedupKey = linkedinUrl ?? result.url;
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);

      const parsed = parseLinkedInTitle(result.title);
      if (!parsed.name || parsed.name === "Unknown") continue;

      out.push({
        name: parsed.name,
        title: parsed.title,
        linkedinUrl,
        rawHeadline: result.title,
        pageText: result.text ?? null,
        pageDate: result.publishedDate ?? null,
        url: result.url,
      });
    }
  }
  return out;
}

function pct(part: number, whole: number): string {
  if (whole === 0) return "0%";
  return `${Math.round((part / whole) * 100)}%`;
}

async function main() {
  const [companyArg, ...titleArgs] = process.argv.slice(2);
  const company = buildCompany(companyArg || BASELINE.name);
  const titles = titleArgs.length > 0 ? titleArgs : DEFAULT_TITLES;

  console.log(
    `\nAffiliation probe (read-only, nothing is written)\n\n  company: ${company.name}\n  titles:  ${titles.join(", ")}\n`,
  );
  if (!company.domain) {
    console.log(
      "  note: no domain/industry/location for this company, so the judge has less\n" +
        "  to disambiguate similarly-named employers with. Set PROBE_DOMAIN,\n" +
        "  PROBE_INDUSTRY, PROBE_LOCATION and PROBE_DESCRIPTION to supply them.\n",
    );
  }

  const candidates = await collectCandidates(company, titles);
  if (candidates.length === 0) {
    console.log("  Exa returned no usable candidates. Nothing to judge.\n");
    return;
  }

  // The whole design rests on the page text being there. If coverage drops,
  // every verdict below degrades to `uncertain` and the judge is not at fault.
  const withAnyText = candidates.filter((c) => (c.pageText ?? "").length > 0);
  const withUsableText = candidates.filter(
    (c) => (c.pageText ?? "").length >= USABLE_TEXT_CHARS,
  );
  const withDate = candidates.filter((c) => c.pageDate);

  console.log(`  ${candidates.length} unique candidates`);
  console.log(
    `  page text present:  ${withAnyText.length}/${candidates.length} (${pct(withAnyText.length, candidates.length)})`,
  );
  console.log(
    `  page text usable:   ${withUsableText.length}/${candidates.length} (${pct(withUsableText.length, candidates.length)}, at least ${USABLE_TEXT_CHARS} chars)`,
  );
  console.log(
    `  page date present:  ${withDate.length}/${candidates.length} (${pct(withDate.length, candidates.length)})\n`,
  );

  console.log("  Judging with the shipped filterContactsByCompany...\n");
  const judged = await filterContactsByCompany(company, candidates);

  const tally: Record<string, number> = {};
  for (const v of judged) tally[v.verdict] = (tally[v.verdict] ?? 0) + 1;

  console.log("  verdicts:");
  for (const [verdict, count] of Object.entries(tally).sort(
    (a, b) => b[1] - a[1],
  )) {
    console.log(
      `    ${verdict.padEnd(16)} ${String(count).padStart(3)}  (${pct(count, judged.length)})`,
    );
  }
  console.log();

  const byIndex = new Map(judged.map((v) => [v.index, v]));
  const line = "-".repeat(146);
  console.log(line);
  console.log(
    "NAME".padEnd(26) +
      "VERDICT".padEnd(17) +
      "EMPLOYER SEEN".padEnd(24) +
      "DATES".padEnd(26) +
      "EVIDENCE",
  );
  console.log(line);
  candidates.forEach((c, i) => {
    const v = byIndex.get(i);
    console.log(
      c.name.slice(0, 25).padEnd(26) +
        (v?.verdict ?? "-").padEnd(17) +
        (v?.employerSeen ?? "-").slice(0, 23).padEnd(24) +
        (v?.datesSeen ?? "-").slice(0, 25).padEnd(26) +
        (v?.evidence ?? "").slice(0, 60),
    );
  });
  console.log(line);
  console.log();
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
