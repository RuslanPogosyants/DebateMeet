# syntax=docker/dockerfile:1
# The deploy bundle (docs/architecture.md §10), and the release itself: its digest is what the stage
# tag points at. In /bundle: the server compose.yaml, the Caddy and LiveKit configs, the deploy agent
# and its systemd units; nothing to run. Its labels pin the backend and web images of the release,
# so CI builds it after pushing them. Build context: deploy/server/; `just images` builds it.
FROM scratch
COPY compose.yaml env.example agent.py /bundle/
COPY caddy/ /bundle/caddy/
COPY livekit/ /bundle/livekit/
COPY systemd/ /bundle/systemd/
ARG APP_VERSION=dev
# Image references with digests in CI; the local tags of `just images` otherwise.
ARG BACKEND_IMAGE=debatemeet-backend:dev
ARG WEB_IMAGE=debatemeet-web:dev
LABEL org.opencontainers.image.title="debatemeet-bundle" \
      org.opencontainers.image.source="https://github.com/RuslanPogosyants/DebateMeet" \
      org.opencontainers.image.version="${APP_VERSION}" \
      debatemeet.backend-image="${BACKEND_IMAGE}" \
      debatemeet.web-image="${WEB_IMAGE}"
