# syntax=docker/dockerfile:1
# The web image (docs/architecture.md §10): the built SPA in /web and nothing to run. The deploy
# agent copies the files into the static folder Caddy serves. Build context: frontend/; `just images`.

# Node 24.21.0; pnpm is the packageManager of package.json, through corepack. Dependabot moves the digest.
FROM node:24-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --store-dir /pnpm/store
COPY . .
# Only the bundle: CI type-checks, lints and tests the same sources.
RUN pnpm exec vite build

FROM scratch
COPY --from=build /app/dist /web
ARG APP_VERSION=dev
LABEL org.opencontainers.image.title="debatemeet-web" \
      org.opencontainers.image.source="https://github.com/RuslanPogosyants/DebateMeet" \
      org.opencontainers.image.version="${APP_VERSION}"
