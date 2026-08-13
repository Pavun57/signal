# Setup

The fastest path is `pnpm run setup` — an interactive script that prompts for keys, starts local Supabase, and runs migrations. If you don't have a hosted Supabase project, just skip those prompts: after `supabase start`, the script auto-writes the local URL + keys into `.env.local`. You'll sign up for the first account once on first run; local Supabase has email confirmation disabled, so signup is instant.

This doc is the manual walkthrough for when the script doesn't fit your setup, or you want to understand each step.

## Prerequisites

| Tool         | Version | Why                                                               |
| ------------ | ------- | ----------------------------------------------------------------- |
| Node         | 20+     | Runtime                                                           |
| pnpm         | 10.x    | Package manager (run `corepack enable` to get the pinned version) |
| Docker       | 24+     | For local Supabase                                                |
| Supabase CLI | 2.30+   | Applies migrations, runs local Supabase                           |
| Git          | 2.30+   | —                                                                 |

Install the Supabase CLI:

```bash
# macOS
brew install supabase/tap/supabase

# Linux / Windows — see https://supabase.com/docs/guides/cli/getting-started
```

## 1. Clone and install

```bash
git clone https://github.com/jay-sahnan/signal.git
cd signal
corepack enable
pnpm install
```

## 2. Create env file

```bash
cp .env.example .env.local
```

Open `.env.local` in your editor. You'll fill this in as you go.

## 3. Supabase

You have two options.

### Option A — Local Supabase (recommended for dev)

```bash
supabase start
```

This boots Postgres, Auth, Storage, and the Studio UI in Docker. It prints a block of URLs and keys at the end — copy these into `.env.local`:

```
API URL:    →  NEXT_PUBLIC_SUPABASE_URL, SUPABASE_URL
anon key:   →  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY, SUPABASE_ANON_KEY
service_role key: →  SUPABASE_SERVICE_ROLE_KEY
```

Then apply the schema:

```bash
supabase db reset
```

This runs `supabase/migrations/20260419000000_initial_schema.sql` against the local DB.

### Option B — Hosted Supabase

Create a project at [supabase.com](https://supabase.com/dashboard). From **Project Settings → API**, copy the URL and keys into `.env.local`.

Then apply the schema:

```bash
supabase link --project-ref <your-project-ref>
supabase db push
```

## 4. Auth

Sign-in is Supabase's own email/password auth — no third-party provider, no
extra keys. The session JWT carries `role: authenticated` and the user id in
`sub`, so RLS policies work out of the box.

One dashboard toggle matters: **Authentication → Sign In / Up → Email** —
turn **"Confirm email" OFF** for a self-hosted/test deployment so new
accounts can sign in immediately without a confirmation link. (Leave it on if
you configure SMTP and want verified emails.)

## 5. AI model key

Signal talks to any OpenAI-compatible endpoint. The default is Anthropic: get a key at [console.anthropic.com](https://console.anthropic.com) and paste into `.env.local`:

```
AI_API_KEY=sk-ant-api03-...
```

To use a different provider (OpenAI, OpenRouter, a local gateway, …), set the base URL and model too:

```
AI_API_KEY=sk-or-...
AI_BASE_URL=https://openrouter.ai/api/v1
AI_MODEL=anthropic/claude-sonnet-4-6
```

Known-good `AI_BASE_URL` values: Anthropic `https://api.anthropic.com/v1`, OpenAI `https://api.openai.com/v1`, OpenRouter `https://openrouter.ai/api/v1`. One model (`AI_MODEL`) is used for every task — chat, email composition, extraction, verdicts — so pick a frontier model. Note the OpenAI-compatible path has no prompt caching or effort controls. Existing installs can keep `ANTHROPIC_API_KEY`, which is still honored as a fallback.

At this point, you have enough to run `pnpm dev` and see the app boot.

## 6. Optional services

Every block in `.env.example` beyond the required ones is feature-gated. If you don't set a key, the feature that uses it will fail gracefully with a "not configured" message. Pick what you need:

| Service            | Unlocks                                                                          |
| ------------------ | -------------------------------------------------------------------------------- |
| Browserbase        | Web scraping, YC scraper, hiring signals (Stagehand reuses your AI key)    |
| Gmail app password | Sending outreach emails from your own mailbox + reply tracking over IMAP         |
| Job scheduler      | Scheduled signal runs, reply tracking, sequence follow-ups                       |
| Exa                | Neural web search inside chat                                                    |
| Google API + CSE   | Google Places enrichment                                                         |
| Apify              | LinkedIn + X enrichment                                                          |
| GitHub token       | GitHub-based signals (commits, releases)                                         |

Signup links live in `.env.example` next to each block.

### Email verification provider

Signal's built-in discovery finds candidate addresses for free, but only a
verifier confirms a mailbox exists — and unverified addresses are blocked at
the send gate. Two adapters ship:

- **Hunter** (`EMAIL_PROVIDER=hunter` + `HUNTER_API_KEY`) — hosted, paid, can
  also *find* emails when the free path comes up empty.
- **Reacher** (`EMAIL_PROVIDER=reacher`) — self-hosted
  [check-if-email-exists](https://github.com/reacherhq/check-if-email-exists),
  free, verification only. `docker-compose.yaml` already runs it as a
  `reacher` service and points the app at it; outside compose, run
  `docker run -p 8080:8080 reacherhq/backend:latest` and set
  `REACHER_API_URL=http://localhost:8080`. Needs **outbound port 25** open on
  the host for SMTP probing — if your VPS blocks it, every verdict degrades to
  "unknown" (Signal treats that as retryable, so nothing is wrongly blocked,
  but nothing gets verified either).

### Job scheduler

Recurring work (scheduled signal runs, reply tracking, sequence follow-ups) runs off a Postgres job queue driven by a per-minute tick at `/api/jobs/tick`. The tick and runner routes share one secret:

```bash
openssl rand -hex 32   # → CRON_SECRET in .env.local (and your Vercel env)
```

Without `CRON_SECRET`, the routes refuse everything and recurring jobs never run. `pnpm run setup` can generate one for you.

**On Vercel**: the repo ships `vercel.json` with the per-minute cron schedule, and Vercel Cron sends the `Authorization: Bearer $CRON_SECRET` header automatically once the env var is set. Per-minute cadence requires a Pro plan.

**Self-hosting or Vercel Hobby**: schedule the tick from Postgres instead. In the Supabase SQL editor:

```sql
select cron.schedule(
  'signal-jobs-tick',
  '* * * * *',
  $$
  select net.http_post(
    url := 'https://YOUR-APP-DOMAIN/api/jobs/tick',
    headers := jsonb_build_object('Authorization', 'Bearer YOUR_CRON_SECRET')
  )
  $$
);
```

The recurring jobs themselves are seeded by the job-queue migration with `insert ... on conflict do nothing`, so they self-heal: if a row is ever deleted, re-running the migration restores it.

## 7. Run

```bash
pnpm dev
# → http://localhost:3000
```

On first run, visit http://localhost:3000 — you'll be redirected to `/login`. Click "Sign up" to create the first account. If you get stuck, check [Issues](../../issues) or [Discussions](../../discussions).

## 8. Running tests

```bash
pnpm lint          # ESLint
pnpm typecheck     # tsc --noEmit
pnpm test          # Vitest unit tests
pnpm test:e2e      # Playwright E2E (requires a running dev server + real DB)
```

E2E tests hit a real Supabase instance and share DB state — run them serially against a non-production project. They require:

- `SUPABASE_SERVICE_ROLE_KEY` in `.env.local` for fixture setup/teardown — `e2e/helpers.ts` creates and deletes test users via the admin auth API

## Troubleshooting

**`supabase db reset` fails with connection refused** — Docker isn't running, or `supabase start` wasn't called first.

**Redirected to `/login` on a fresh install** — expected. Click "Sign up" to create the first account.

**Sign-up works but sign-in says the email isn't confirmed** — "Confirm email" is still on in Supabase (Authentication → Sign In / Up → Email). Turn it off, or confirm the address via the link in the email.

**Schema drift** — If you make DB changes locally, generate a new migration with `supabase db diff -f <name>` and commit it.
