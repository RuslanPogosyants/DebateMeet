# syntax=docker/dockerfile:1
# The deploy bundle (docs/architecture.md §10): the server compose.yaml, Caddyfile and LiveKit config
# in /bundle, nothing to run. The deploy agent unpacks it on the server, so servers never git pull.
# Build context: deploy/server/; `just images` builds it.
FROM scratch
COPY compose.yaml Caddyfile livekit.yaml livekit.sh env.example /bundle/
ARG APP_VERSION=dev
LABEL org.opencontainers.image.title="debatemeet-bundle" \
      org.opencontainers.image.source="https://github.com/RuslanPogosyants/DebateMeet" \
      org.opencontainers.image.version="${APP_VERSION}"
