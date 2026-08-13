# Architecture

A one-page map of what Signal is and how the pieces fit. For setup, see [`setup.md`](./setup.md). For signal-recipe authoring, see [`signal-authoring.md`](./signal-authoring.md).

## Shape

Signal is a Next.js App Router application backed by Supabase. There's no separate backend service — all server logic runs in Next.js route handlers and server components.

```
User ──▶ Next.js (App Router)
           │
           ├── UI (React 19 + Tailwind + shadcn/ui)
           ├── API routes (src/app/api/**)
           └── Server actions
                │
                ├──▶ Supabase (Postgres + Auth + RLS)
                ├──▶ Any OpenAI-compatible LLM (via Vercel AI SDK; AI_BASE_URL / AI_API_KEY / AI_MODEL)                ├──▶ Browserbase / Stagehand (web automation)
                ├──▶ Gmail SMTP/IMAP (outbound email + reply tracking)
                ├──▶ jobs table (Postgres queue, Vercel Cron tick)
                └──▶ Exa / Google / Apify / GitHub (enrichment)
```

## Code layout

```
src/
  app/              # Next.js routes
    (auth)/         # login, signup
    api/            # route handlers (webhooks, AI chat, CSV import, etc.)
    campaigns/      # campaign workspace pages
    chat/           # chat-first UI
    outreach/       # sequence composer + review
    signals/        # signal management UI
    settings/       # user + team settings
    tracking/       # signal-tracking UI (company / person monitoring)
  components/       # shadcn-style UI components + feature components
  lib/
    supabase/       # client, server, middleware, admin clients
    tools/          # AI tool definitions (email, profile, sequences)
    services/       # integrations (gmail, jobs, exa, browserbase, ...)
    jobs/           # job executors + runner for the Postgres queue
    signals/        # signal runner + recipe engine
    email-composition/
    types/          # shared TypeScript types
supabase/
  config.toml
  migrations/       # one consolidated initial schema
browserbase-functions/  # deployable Browserbase functions (pricing-changes)
scripts/            # one-off dev utilities
e2e/                # Playwright tests (api, pages, knowledge-base, signals)
src/__tests__/      # Vitest unit tests
```

## Data model

The migrations in `supabase/migrations/` define the canonical data model. The
table below was substantially wrong for months (it named `companies`,
`chat_sessions`, `chat_messages`, `signal_runs`, `signal_events`,
`email_events`, `knowledge_base`, `user_profiles` and `team_members`, none of
which exist), so treat the migrations as the source of truth and fix this table
when it drifts. These are the tables that actually exist:

| Table                                                        | Purpose                                                       |
| ------------------------------------------------------------ | ------------------------------------------------------------- |
| `campaigns`                                                  | Top-level container for a sales motion                        |
| `organizations`, `people`                                    | The shared knowledge pool: companies and contacts             |
| `campaign_organizations`, `campaign_people`                  | Which pool rows belong to which campaign                      |
| `signals`                                                    | Recipe-driven triggers watching for buying intent             |
| `campaign_signals`, `signal_results`                         | Signals enabled per campaign, and their execution output      |
| `chats`                                                      | Chat history, one row per conversation with messages as jsonb |
| `sequences`, `sequence_steps`, `sequence_enrollments`        | Multi-step outreach definitions and who is enrolled where     |
| `email_drafts`, `sent_emails`, `email_replies`               | Drafted mail, what was sent, and what came back               |
| `outreach_events`                                            | Append-only log of outreach status transitions                |
| `email_voice_profiles`                                       | Per-user and per-campaign writing voice                       |
| `tracking_configs`, `tracking_snapshots`, `tracking_changes` | Recurring company / person signal monitoring                  |
| `jobs`                                                       | Postgres job queue (recurring + one-off work)                 |
| `api_usage`                                                  | Per-action cost attribution                                   |
| `user_profile`                                               | The sending identity; a user may have several                 |
| `user_settings`                                              | Mailbox connection, daily send cap, pause switch              |

Row-level security scopes the user-owned tables to `auth.jwt() ->> 'sub'` via
`requesting_user_id()`. Note the exception, because it matters: `organizations`
and `people` are a **shared pool** with no owner column, readable and writable
by any authenticated user. That is a deliberate single-team tradeoff and it is
not safe to share an instance with people you do not trust.

## Multi-tenancy

Signal is designed for **single-tenant self-hosting**. One Supabase project = one team.

Campaign-scoped tables (`campaigns`, `chats`, `email_drafts`, `campaign_organizations`, `campaign_people`, `campaign_signals`) are correctly scoped by `auth.uid()` — a user only ever sees their own campaigns and the contacts they've linked.

The enrichment pool is deliberately shared across all users on an instance: `organizations`, `people`, and `signal_results` have `USING (true)` RLS for SELECT. This lets a team's multiple users collaborate on the same enriched companies without re-paying for the same Exa / Apify lookups.

If you deploy Signal for multiple independent teams, **do not share a Supabase project between them** — they will see each other's enriched companies and contacts. Deploy one instance per team, or tighten the RLS on the shared tables to scope by an organization column before onboarding multi-tenant traffic.

## Key flows

### Chat → tool call → draft

1. User sends a message in a campaign's chat.
2. Route handler at `src/app/api/chat/route.ts` streams to the configured model via `@ai-sdk/openai-compatible` (see `src/lib/ai/models.ts`).
3. Claude calls tools from `src/lib/tools/*` — company lookup, contact enrichment, sequence drafting.
4. Tool results stream back to the UI as structured cards.

### Signal run

1. The per-minute tick at `src/app/api/jobs/tick` claims due jobs; the recurring `tracking.dispatch` job enqueues one `tracking.run` job per due tracking config.
2. The `tracking.run` executor (`src/lib/jobs/executors/tracking-run.ts`) calls `src/lib/signals/runner.ts`, which loads the recipe, dispatches steps (scraper / API / Stagehand), and persists events.
3. New events raise contact priorities and surface in the campaign UI. A tracking verdict that flips to "ready to contact" enqueues an `outreach.process` job.

### Outreach send

1. User reviews draft sequences in `/outreach/review`.
2. Send request hits `src/app/api/outreach/send-now/route.ts`.
3. `src/lib/services/gmail-service.ts` dispatches over the user's Gmail SMTP, stores `email_drafts` rows.
4. The recurring `email.track` job polls each connected mailbox over IMAP and updates reply / bounce state; the recurring `outreach.process` job sends due sequence follow-ups. Signal sends no tracking pixel, so `opened` / `clicked` statuses are never written.

## Job queue

Scheduling lives in Postgres, not an external vendor. A single `jobs` table (created in `supabase/migrations/20260801000003_job_queue.sql`) holds both recurring system jobs and one-off work items enqueued by app code via `enqueueJob()` (`src/lib/services/jobs.ts`).

Claiming happens in one SQL function, `claim_jobs()`, so the concurrency rules live in one transaction the app can't get wrong:

- `FOR UPDATE SKIP LOCKED` makes concurrent claimers safe (a second claimer skips rows the first is mid-claim on).
- Per-user fairness: at most `per_user_cap` jobs per user per batch, so one tenant's backlog can't starve others.
- Singleton keys: at most one running job per `singleton_key` (unused in v1; reserved for per-mailbox send serialization).
- Lease reaping: a claimed job carries a `locked_until` lease. If the runner dies mid-job, the lease expires and the next `claim_jobs()` call reaps the job back to pending. That lease is the retry mechanism.

Two routes drive the queue, both guarded by `CRON_SECRET` (unset secret means the queue stays off, never open):

- `/api/jobs/tick` (per-minute, via Vercel Cron or pg_cron) claims a batch and POSTs each job id to the runner. It is a dispatcher only and finishes in seconds.
- `/api/jobs/run` responds 202 immediately and executes the job in `after()`, so each job gets its own invocation and its own `maxDuration = 300` budget.

Job types (v1):

| type                | payload                                     | recurring                  |
| ------------------- | ------------------------------------------- | -------------------------- |
| `email.track`       | `{}`                                        | every 10 min               |
| `email.cleanup`     | `{}`                                        | daily                      |
| `tracking.dispatch` | `{}`                                        | every 15 min               |
| `tracking.run`      | `{ trackingConfigId }`                      | no                         |
| `outreach.process`  | `{ type: "followups" }` or a signal payload | followups row every 15 min |

Executors live in `src/lib/jobs/executors/` and are registered in `src/lib/jobs/executors/index.ts`. The recurring rows are seeded by the migration with `insert ... on conflict do nothing`, so a fresh deploy schedules itself and a deleted row self-heals on the next migration run.

When volume grows, a persistent worker can run the same `claim_jobs()` loop against the same executors. The table is the contract: no schema, executor, or enqueue-site changes, and worker and cron can run simultaneously because SKIP LOCKED prevents double-claims.

## External service touchpoints

All integrations live under `src/lib/services/`. Each gates on its env var and fails with a descriptive error if unconfigured — nothing crashes the app if a secondary service is missing.

## Testing

- **Unit** (`src/__tests__/`, Vitest): tool shape contracts, recipe logic, differs, scrapers.
- **E2E** (`e2e/`, Playwright): API routes, page navigation, signal execution, knowledge-base. Run serially against a real Supabase instance.

## Adding a new signal type

See [`docs/signal-authoring.md`](./signal-authoring.md) for the full recipe-authoring guide.
