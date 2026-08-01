#!/usr/bin/env node
// Wipes all application data from the LOCAL Supabase database while
// preserving schema and migrations history. Useful when you've accumulated
// experimental campaigns, contacts, and chats during development and want
// a clean slate without re-running every migration.
//
// Usage:
//   pnpm clear:local            -- prompts before truncating
//   pnpm clear:local --yes      -- skip the prompt (CI/scripted use)
//
// Connects to the local Supabase docker instance on the default port. If
// you're pointing at a hosted/remote DB, this script refuses to run.

import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output, exit, argv } from "node:process";
import { execSync } from "node:child_process";

const SKIP_PROMPT = argv.includes("--yes") || argv.includes("-y");
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost"]);
const DEFAULT_DB_URL =
  "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const DB_URL = process.env.LOCAL_DB_URL ?? DEFAULT_DB_URL;

const colors = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
};
const log = {
  ok: (m) => console.log(`${colors.green}✓ ${m}${colors.reset}`),
  info: (m) => console.log(`${colors.dim}${m}${colors.reset}`),
  warn: (m) => console.log(`${colors.yellow}! ${m}${colors.reset}`),
  fail: (m) => console.log(`${colors.red}✗ ${m}${colors.reset}`),
  bold: (m) => console.log(`${colors.bold}${m}${colors.reset}`),
};

// Allowlist of every data table we know about. New tables added in future
// migrations will surface as a "missing from allowlist" warning so this
// script doesn't silently miss them. Order doesn't matter -- we use
// TRUNCATE ... CASCADE.
const KNOWN_TABLES = [
  // outreach + tracking history
  "outreach_events",
  "sent_emails",
  "email_drafts",
  "sequence_enrollments",
  "sequence_steps",
  "sequences",
  "tracking_changes",
  "tracking_snapshots",
  "tracking_configs",
  // signal results / config
  "signal_results",
  "campaign_signals",
  "signals",
  "email_voice_profiles",
  // email skills
  "email_skill_attachments",
  "email_skills",
  // chat + usage
  "api_usage",
  "chats",
  // campaign linkage
  "campaign_people",
  "campaign_organizations",
  "campaigns",
  // shared knowledge base
  "people",
  "organizations",
  // user-scoped settings
  "user_profile",
  "user_settings",
];

function refuseIfNotLocal() {
  let host;
  try {
    host = new URL(DB_URL.replace(/^postgresql:/, "http:")).hostname;
  } catch {
    log.fail(`Couldn't parse LOCAL_DB_URL: ${DB_URL}`);
    exit(1);
  }
  if (!LOCAL_HOSTS.has(host)) {
    log.fail(
      `Refusing to run -- DB host is "${host}", not localhost. ` +
        `This script is local-only.`,
    );
    exit(1);
  }
}

function ensurePsqlAvailable() {
  try {
    execSync("which psql", { stdio: "ignore" });
  } catch {
    log.fail(
      "psql not found in PATH. Install it (brew install libpq && brew link --force libpq) " +
        "or use the supabase CLI shell.",
    );
    exit(1);
  }
}

async function confirm(tableCount) {
  if (SKIP_PROMPT) return true;
  const rl = createInterface({ input, output });
  const answer = await rl.question(
    `${colors.yellow}Truncate ${tableCount} tables on ${DB_URL}? [y/N] ${colors.reset}`,
  );
  rl.close();
  return answer.trim().toLowerCase() === "y";
}

function discoverTables() {
  // Intersect KNOWN_TABLES with what actually exists in the local public
  // schema. Legacy tables that have since been dropped (e.g. `contacts`,
  // `companies`) are quietly skipped; new tables not yet in the allowlist
  // are surfaced as a warning so we know to update the script.
  const out = execSync(
    `psql "${DB_URL}" -X -A -t -c "select tablename from pg_tables where schemaname = 'public'"`,
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  const live = new Set(
    out
      .trim()
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  const present = KNOWN_TABLES.filter((t) => live.has(t));
  const missing = KNOWN_TABLES.filter((t) => !live.has(t));
  const unknown = [...live].filter(
    (t) => !KNOWN_TABLES.includes(t) && !t.startsWith("_"),
  );
  return { present, missing, unknown };
}

// The 11 built-in signals are seeded ONLY by the initial migration, so nothing
// puts them back: `supabase start` won't, and re-running migrations won't either
// because the migration is already recorded as applied. Wiping them leaves the
// app with an empty signal catalogue, recoverable only by hand-replaying the
// INSERTs out of the initial migration.
//
// A `delete from signals where not is_builtin` is NOT enough. signals.created_by
// references user_profile, so `truncate user_profile ... cascade` truncates the
// whole signals table on its way through — CASCADE ignores row values. So
// snapshot the built-ins, let the truncate happen, and put them back.
// created_by is nulled on restore because the user_profile row it pointed at is
// gone (the FK is ON DELETE SET NULL, so null is the value it would have taken).
const PRESERVE_BUILTIN = "signals";

function buildTruncateSql(tables) {
  const preserving = tables.includes(PRESERVE_BUILTIN);
  const statements = [];

  if (preserving) {
    statements.push(
      `create temp table _preserved_signals on commit drop as select * from ${PRESERVE_BUILTIN} where is_builtin;`,
    );
  }

  // RESTART IDENTITY resets any sequence-backed columns; CASCADE handles
  // the foreign-key web (campaign_people -> people, etc.) without us
  // needing to enumerate dependency order.
  statements.push(
    `truncate table ${tables.join(", ")} restart identity cascade;`,
  );

  if (preserving) {
    statements.push(
      `update _preserved_signals set created_by = null;`,
      `insert into ${PRESERVE_BUILTIN} select * from _preserved_signals;`,
    );
  }

  // One transaction so the snapshot, the wipe and the restore cannot be
  // interrupted halfway — and so the ON COMMIT DROP temp table is cleaned up.
  return `begin; ${statements.join(" ")} commit;`;
}

function rowCounts(tables) {
  if (tables.length === 0) return [];
  const sql = tables
    .map((t) => `select '${t}' as t, count(*) from ${t}`)
    .join(" union all ");
  try {
    const out = execSync(
      `psql "${DB_URL}" -X -A -F"|" -t -c "${sql.replace(/"/g, '\\"')}"`,
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    return out
      .trim()
      .split("\n")
      .map((line) => {
        const [table, count] = line.split("|");
        return { table, count: Number(count) };
      });
  } catch (err) {
    log.warn(`Couldn't read row counts: ${err.message?.split("\n")[0]}`);
    return null;
  }
}

async function main() {
  refuseIfNotLocal();
  ensurePsqlAvailable();

  log.bold("Local database wipe");
  log.info(`  target: ${DB_URL}`);

  const { present, missing, unknown } = discoverTables();
  log.info(
    `  tables: ${present.length} present (${missing.length} legacy/missing skipped)`,
  );
  if (unknown.length > 0) {
    log.warn(
      `  unknown tables (not in allowlist, will be left alone): ${unknown.join(", ")}`,
    );
    log.warn("  -- update KNOWN_TABLES in scripts/clear-local-data.mjs");
  }

  const before = rowCounts(present);
  if (before) {
    const total = before.reduce((sum, r) => sum + r.count, 0);
    log.info(`  rows:   ${total} across all tables`);
    if (total === 0) {
      log.ok("Nothing to clear.");
      exit(0);
    }
  }

  const proceed = await confirm(present.length);
  if (!proceed) {
    log.warn("Aborted.");
    exit(0);
  }

  try {
    execSync(
      `psql "${DB_URL}" -X -v ON_ERROR_STOP=1 -c "${buildTruncateSql(present)}"`,
      { stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (err) {
    log.fail(`Truncate failed: ${err.stderr?.toString() ?? err.message}`);
    exit(1);
  }

  log.ok(
    "Done. All application data cleared. Schema and migrations are intact.",
  );
}

main().catch((err) => {
  log.fail(err.message);
  exit(1);
});
