# Network Graph Phase 1 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Give Signal a real relationship graph: preserve employment history instead of destroying it on job changes, extract dated work histories for campaign contacts from public profiles, derive person-to-person edges (worked together, studied together, co-founded, engaged, replied), and surface warm paths in the contacts UI so the agent can route outreach through relationships instead of always going cold.

**Architecture:** Two new tables hold ground truth (`employment_history` for dated stints, `person_edges` for derived person-to-person edges, plus `user_person_edges` for the sender's own ego edges). Three writers feed them: (1) `recordAffiliation` snapshots the old employer into history whenever it moves someone, (2) a new `work-history` enrichment step fetches the person's public LinkedIn mirror via Exa `/contents` and extracts dated stints with `generateObject`, (3) a `graph.derive` job computes overlap edges from the accumulated histories plus free edges already sitting in existing data (YC founders, repost authors, reply history). A recursive-CTE path service answers "how do I reach this person/account" for both the UI badge and a new agent tool. Rendering stays list-and-badge first (per the InMaps/TeamLink research); the living-graph canvas prototype exists as a claude.ai artifact and is out of scope here.

**Tech Stack:** Next.js 16 (App Router), Supabase (Postgres + RLS, admin client for jobs), Vercel AI SDK (`generateObject`, Anthropic models), Vitest (`pnpm test`), Zod, Exa API. Tests live in `src/__tests__/*.test.ts`.

**Verification commands:** `pnpm typecheck`, `pnpm lint`, `pnpm test` (all must pass before each commit).

**Deploy note:** Prod migrations are applied manually with `supabase db push` (migrate.yaml secrets are unset in prod) — flag this in the PR description.

**Copy note:** ESLint errors on em dashes in string literals — use colons in tool descriptions, errors, and toasts.

---

## Context: what was validated before this plan (2026-08-05)

- **Exa's index mirrors LinkedIn profiles including dated experience/education sections.** Tested live: full dated stints for known founders, and 127/130 usable profile texts for the top-2-per-account people of the "UK Tech Series A+ GTM Discovery" campaign (597 people, 95 orgs). No Apify profile actor needed for well-indexed people; keep it as a fallback only.
- **Extraction → interval-intersection produces correct edges.** Ant Wilson ↔ Paul Copplestone: coworker_past at Supabase, 79 months overlap, plus a YC S20 cohort edge. Negative control (Guillermo Rauch vs both) correctly produced zero edges. Company-anchored discovery also works (found real ServisHero employees overlapping Paul's 2015-2017 tenure).
- **The schema gap is real:** prod has zero person-to-person edges and `people.organization_id` is a single overwritten scalar. Job changes currently destroy the prior employer link (only `affiliation_detached_from` + one evidence line survive).
- **Prior art worth copying:** The Swarm's public API stores per-edge `shared_company`, `overlap_start_date`, `overlap_end_date`, `overlap_duration_months` with a 3-tier normalized strength; strength scoring across the industry is recency + frequency + overlap-tenure, discounted by company size.

Non-goals for Phase 1: Gmail header mining (needs explicit consent flow), LinkedIn connections import, the graph canvas UI, buying third-party relationship data.

---

### Task 0: Branch setup

```bash
cd /Users/jay/signal
git checkout main && git pull
git checkout -b feat/network-graph-phase1
```

---

### Task 1: Migration — employment history + edge tables

**Files:**

- Create: `supabase/migrations/<next-version>_network_graph.sql` (check `supabase/migrations/` for the next free `202608xx` version number at implementation time)

**Step 1: Write the migration**

```sql
-- Network graph phase 1: dated employment history per person, derived
-- person-to-person edges, and sender-to-person ego edges.

create table employment_history (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references people(id) on delete cascade,
  organization_name text not null,          -- past employers usually have no organizations row
  organization_id uuid references organizations(id) on delete set null,  -- linked when matchable
  title text,
  start_date date,                          -- month precision; day always 01
  end_date date,                            -- null = current or unknown (see confidence)
  dated boolean not null default false,     -- true when start_date came from the source, not inferred
  source text not null check (source in
    ('linkedin_mirror','exa_search','affiliation_change','user_entered')),
  evidence_url text,
  created_at timestamptz not null default now()
);
create index idx_employment_history_person on employment_history(person_id);
-- dedupe key: one stint per person per normalized org per start month
create unique index idx_employment_history_dedupe
  on employment_history(person_id, lower(organization_name), coalesce(start_date, '1900-01-01'::date));

create table person_edges (
  id uuid primary key default gen_random_uuid(),
  person_a uuid not null references people(id) on delete cascade,
  person_b uuid not null references people(id) on delete cascade,
  edge_type text not null check (edge_type in
    ('coworker_past','education_overlap','cofounder','engaged_post')),
  strength real not null default 0.5,
  evidence jsonb not null default '{}'::jsonb,  -- {org, months, from, to, url, ...}
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  check (person_a < person_b)               -- canonical ordering, no duplicate reversed pairs
);
create unique index idx_person_edges_pair on person_edges(person_a, person_b, edge_type);
create index idx_person_edges_b on person_edges(person_b);

create table user_person_edges (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  person_id uuid not null references people(id) on delete cascade,
  edge_type text not null check (edge_type in
    ('replied','contacted','coworker_past','education_overlap')),
  strength real not null default 0.5,
  evidence jsonb not null default '{}'::jsonb,
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now()
);
create unique index idx_user_person_edges_key on user_person_edges(user_id, person_id, edge_type);
```

Follow the RLS/grant patterns of the sender-facts migration (`20260805000000_sender_facts.sql`) for all three tables: service-role writes from jobs, authenticated reads scoped the same way the neighboring tables are.

**Step 2: `pnpm typecheck && pnpm lint && pnpm test`, apply locally with `supabase migration up`, commit.**

---

### Task 2: Stop destroying employment history on job changes

**Files:**

- Modify: `src/lib/services/affiliation.ts` (`recordAffiliation`, the detach paths)
- Test: `src/__tests__/affiliation-history.test.ts`

**Step 1:** In every code path where `recordAffiliation` (or a detach) replaces or clears a non-null `organization_id`, first insert an `employment_history` row for the outgoing employer: `organization_name` from the org row, `organization_id`, `title` from the person's current title, `end_date = date_trunc('month', now())`, `dated = false`, `source = 'affiliation_change'`. Use `on conflict do nothing` against the dedupe index. This must be additive only: no change to the monotonic-confidence semantics, the send gates, or `affiliation_detached_from`.

**Step 2:** Test: moving a person from org A to org B creates exactly one history row for A; repeating the move creates no duplicate; a first-time affiliation (null → A) creates none.

---

### Task 3: Work-history extraction service

**Files:**

- Create: `src/lib/services/work-history.ts`
- Test: `src/__tests__/work-history.test.ts` (extraction schema + normalization, Exa mocked)

**Step 1: Fetch.** `fetchProfileText(person)`: requires `linkedin_url`; POST Exa `/contents` with the canonical URL, `text.maxCharacters: 4200`. Return null when missing/short (<300 chars). Batch variant `fetchProfileTexts(people)` chunks 25 URLs per call (validated: 127/130 hit rate).

**Step 2: Extract.** `extractStints(profiles)` uses `generateObject` with `claude-haiku-4-5` (fall back to the campaign default model on schema failure), 8 profiles per call, Zod schema:

```ts
z.object({
  people: z.array(
    z.object({
      name: z.string(),
      stints: z.array(
        z.object({
          organization: z.string(),
          title: z.string().nullable(),
          start: z.string().nullable(), // YYYY-MM or YYYY
          end: z.string().nullable(),
        }),
      ),
      education: z.array(
        z.object({
          school: z.string(),
          startYear: z.number().int().nullable(),
          endYear: z.number().int().nullable(),
        }),
      ),
    }),
  ),
});
```

Prompt rules (validated wording): only stints present in the text; accelerators (YC, Techstars, EF, Antler) go under education with cohort year; use the exact names given in the headers.

**Step 3: Persist.** Upsert `employment_history` rows (`source = 'linkedin_mirror'`, `dated = start != null`, `evidence_url = linkedin_url`). Education rows also go in `employment_history`? No: keep education inside the same table with a dedicated org prefix is a hack — instead store education stints in `employment_history` with `title = 'Education'`? **Decision: store education in `person_edges` derivation input only, held in `enrichment_data.education` on the person** (additive merge via `mergeEnrichmentData`), so the table stays employment-only.

**Step 4: Spend policy (lazy, like Hunter verification).** Export `ensureWorkHistory(personIds)` and call it only for: people entering `tracking_configs`, people whose draft is approved, and an explicit per-campaign "map network" action. Never inside discovery. Skip people enriched in the last 90 days (`employment_history` row with `source = 'linkedin_mirror'` newer than that).

---

### Task 4: Edge derivation job

**Files:**

- Create: `src/lib/jobs/executors/graph-derive.ts` (job type `graph.derive`, follow the executor/registration pattern of `email-track.ts`)
- Create: `src/lib/services/graph-edges.ts` (pure functions: normalization, overlap, strength — unit-testable)
- Test: `src/__tests__/graph-edges.test.ts`

**Step 1: Normalization + overlap (port the validated logic).**

```ts
// strip corporate suffixes, then alphanumerics only
normalizeOrg("Fathom Analytics Ltd") === "fathomanalytics";
// generic non-employers never match
GENERIC =
  /^(freelance|self.?employed|consultant|independent|various|stealth)$/i;
// interval intersection at month precision; both stints must be dated;
// months >= 2 to count
```

**Step 2: Strength.** `strength = clamp01(0.25 + 0.1 * ln(1 + months))` discounted by recency (`* 0.85` if the overlap ended > 8 years ago) and by company size when a headcount claim exists on the matched org (`* 0.6` when headcount > 500; overlap at a big co is weak evidence). Education overlap gets a flat `0.35`.

**Step 3: The job.** For each pair of people sharing a normalized org across their dated stints (group stints by normalized org first — never O(n²) over all people), upsert `person_edges` with `evidence = {org, months, from, to}` and bump `last_seen`. Same-employer-now pairs (`people.organization_id` equal) are **not** materialized — they are derivable by join and would bloat the table (the 33-person account alone would be 528 rows).

**Step 4: Free edges from existing data**, same job, cheap passes:

- **cofounder:** `organizations.enrichment_data.yc.founders[]` — resolve each founder through `findOrCreatePerson` (dedup by canonical LinkedIn URL), edge between founders of the same company, evidence `{org, source: 'yc'}`.
- **engaged_post:** stop dropping `repostedBy`/`author.publicIdentifier` in `extractPost` (`src/lib/services/linkedin-service.ts:64`); when an engager's canonical LinkedIn URL matches an existing person, upsert an edge with the post URL as evidence.
- **replied / contacted (ego edges):** from `email_replies` (kind `reply`) and `sent_emails` per `user_id`, upsert `user_person_edges` with Google's interaction-rank shape: each event contributes `0.5^(ageDays/180)`, outbound weighted 0.7, inbound 1.0; strength = clamp01 of the sum.

**Step 5: Scheduling.** Enqueue `graph.derive` after each `ensureWorkHistory` batch completes, plus a nightly sweep. Thread `user_id` into the enqueue (same partition-cap lesson as the tracking-pipeline fixes).

---

### Task 5: Warm-path service + agent tool

**Files:**

- Create: `src/lib/services/warm-path.ts`
- Modify: `src/lib/tools/` (new `findWarmPath` tool, registered wherever the drafting agent gets its tools)
- Test: `src/__tests__/warm-path.test.ts`

**Step 1:** `findWarmPath(userId, target)` where target is a person or organization. Build the small adjacency in SQL: `user_person_edges` (start hops) + `person_edges` + implicit same-employer join, recursive CTE capped at depth 3, strongest-path-first (product of strengths). Return hops as `{person | org, edgeType, evidence, strength}[]`.

**Step 2:** Agent tool `findWarmPath`: description states when to call it (before drafting cold outreach to a person or account: check for a warm route first). Output includes the evidence lines verbatim so drafts can cite them ("you overlapped with her for 3 years at X"). The draft flow itself is unchanged in Phase 1: the agent may reference the path in the draft body but still goes through the normal pending-review pipeline.

---

### Task 6: Contacts UI badge + company path card

**Files:**

- Modify: contacts table component (wherever campaign contacts render) + company page (`src/app/companies/[id]/page.tsx`)
- Create: `src/app/api/warm-paths/route.ts` (batch: campaign or org id → best path per person)

**Step 1:** Warm-path badge in the contacts list: pill showing "Warm path: via {first-hop name}" (green tier for strength ≥ 0.6, amber below), tooltip = evidence line. Filter toggle "Warm paths only". No node-link rendering here.

**Step 2:** Company page: a path card at the top ("You → {connector} → {target}") when a path into the account exists, with per-hop evidence and a button that pre-fills the drafting flow targeting the connector. Follows the existing card/type-scale idioms (`type-*` utilities).

---

### Task 7: Verification + PR

- `pnpm typecheck && pnpm lint && pnpm test`
- Manual: run `ensureWorkHistory` on the UK Tech campaign's tracked people, then `graph.derive`, then check `person_edges` rows exist and the badge renders for at least one contact.
- PR body: flag the manual `supabase db push` for prod, and that `graph.derive` is additive/idempotent (safe to re-run).

---

## Phase 2+ (explicitly out of scope, tracked here so the plan composes)

1. **Sender ego enrichment:** extract the user's own work history (needs `user_profile.linkedin_url` — currently null for Jay's profile) so user↔person `coworker_past` edges exist and warm paths start from real shared history, not only reply history.
2. **Gmail header mining (opt-in):** first-degree network from the user's own mailbox; self-hosted keys avoid the CASA burden; requires an explicit consent surface.
3. **Graph canvas:** the living-network artifact (company meta-nodes, expand-to-ring, search-first) as an in-app view once edges are dense enough to be worth drawing.
4. **Employment backfill at discovery:** `contact-filter.ts` already sees dated experience text during LLM affiliation judging and discards it; persist the judged stints as `exa_search`-source history rows for free coverage growth.
