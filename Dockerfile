# syntax=docker/dockerfile:1.7
# Signal — Next.js 16 standalone build.
# Built on node:22-alpine. Multi-stage to keep the final image small.
# Node 22+ is required: the pinned node:20-alpine ships an undici without
# util.markAsUncloneable, which crashes `next build` page-data collection
# (TypeError: s.util.markAsUncloneable is not a function).

ARG NODE_VERSION=22-alpine

# ----------------------------------------------------------------------------
# deps — install production + build deps
# ----------------------------------------------------------------------------
FROM node:${NODE_VERSION} AS deps
WORKDIR /app
# libc6-compat is occasionally needed by Next / sharp on Alpine.
RUN apk add --no-cache libc6-compat
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# ----------------------------------------------------------------------------
# build — compile Next.js in standalone mode
# ----------------------------------------------------------------------------
FROM node:${NODE_VERSION} AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
RUN corepack enable
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Next inlines NEXT_PUBLIC_* into the client bundle at build time, and
# container runtime env does NOT reach `docker build` (Dokploy passes UI
# env vars to the container only). Every NEXT_PUBLIC_* var the app reads
# must therefore be a build ARG mapped to ENV here, and set under Dokploy's
# build arguments (in addition to the Environment section).
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY
ARG NEXT_PUBLIC_APP_URL
ARG NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN
ARG NEXT_PUBLIC_POSTHOG_HOST
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL
ENV NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY=$NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY
ENV NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL
ENV NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN=$NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN
ENV NEXT_PUBLIC_POSTHOG_HOST=$NEXT_PUBLIC_POSTHOG_HOST
RUN pnpm build

# ----------------------------------------------------------------------------
# runner — minimal runtime image
# ----------------------------------------------------------------------------
FROM node:${NODE_VERSION} AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs
EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

CMD ["node", "server.js"]
