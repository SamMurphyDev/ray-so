# syntax=docker/dockerfile:1

# ---- Base ----
# Pinned to Node 22 (see "engines" in package.json). Alpine keeps the image small.
FROM node:22-alpine AS base
# libc compatibility shim some native deps (e.g. sharp) expect on Alpine.
RUN apk add --no-cache libc6-compat

# ---- Dependencies ----
# Install full dependencies based on the lockfile. Cached unless package files change.
FROM base AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ---- Builder ----
# Build the production bundle. Produces .next/standalone thanks to output: "standalone".
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# ---- Runner ----
# Minimal runtime image containing only the standalone server and static assets.
FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
# Next.js standalone server listens on this host/port.
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Run as a non-root user for security.
RUN addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 nextjs

# Public assets (served directly by the Next.js server).
COPY --from=builder /app/public ./public

# Standalone server output: includes a minimal node_modules and server.js.
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
# Static chunks (JS/CSS) referenced by the standalone server.
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs

EXPOSE 3000

# server.js is emitted at the root of the standalone output.
CMD ["node", "server.js"]
