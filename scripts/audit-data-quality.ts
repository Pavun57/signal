/**
 * Read-only data-quality audit.
 *
 *   npx tsx scripts/audit-data-quality.ts
 *
 * Reports duplicate companies, domain-less companies holding contacts, people
 * whose email domain or job title contradicts the company they are filed under,
 * duplicate people, and unverified pattern-guessed emails.
 *
 * Changes nothing. Repair is a judgement call — merging two companies or moving
 * a person means choosing whose data survives and re-pointing four foreign keys
 * — so this prints what it found and stops. Act on findings through the
 * existing /api/people/[id]/to-company and from-company endpoints.
 *
 * The checks live in src/lib/services/data-quality.ts and are imported, not
 * reimplemented: the same module backs the agent's getDataQualityReport tool,
 * and a second copy here would drift from it exactly the way the three copies
 * of contact-finding did.
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

import { runDataQualityAudit } from "../src/lib/services/data-quality";

for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^([A-Z_0-9]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}

const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const key =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

if (!url || !key) {
  console.error(
    "Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY. Set them in .env.local.",
  );
  process.exit(1);
}

// Wrapped rather than top-level await: tsx transpiles this file to CJS, where
// top-level await is a syntax error.
async function main() {
  const supabase = createClient(url!, key!, {
    auth: { persistSession: false },
  });
  const report = await runDataQualityAudit(supabase);

  const rank = { high: 0, medium: 1, low: 2 } as const;
  const sorted = [...report.findings].sort(
    (a, b) => rank[a.severity] - rank[b.severity],
  );

  console.log("\nData quality audit (read-only — nothing was changed)\n");
  console.log(
    `  ${report.counts.organizations} companies · ${report.counts.people} people · ${report.counts.peopleWithOrg} attached to a company\n`,
  );
  if (report.truncated) {
    console.log(`  ⚠ ${report.truncated}\n`);
  }

  if (sorted.length === 0) {
    console.log("  No problems found.\n");
    return;
  }

  for (const f of sorted) {
    console.log(`  [${f.severity.toUpperCase().padEnd(6)}] ${f.summary}`);
  }
  console.log(
    `\n  ${sorted.length} finding(s). Review before acting — repairs are not automatic.\n`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
