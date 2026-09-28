# syntax=docker/dockerfile:1
# The backend image (docs/architecture.md §10). Build context: backend/; `just images` builds it.
# Dependencies and code are separate layers, so a usual release pulls only the code layer.

# uv 0.11.25, the version CI uses; Python 3.14.7. Dependabot moves the digests.
FROM ghcr.io/astral-sh/uv:0.11.25@sha256:1e3808aa9023d0980e7c15b1fa7c1ac16ff35925780cf5c459858b2d693f01a9 AS uv
FROM python:3.14-slim@sha256:51dafde81dbdb6ebde285137a295cf18a47ca95234fe388a343719cb97305b3d AS python

# Runtime dependencies from uv.lock, compiled to bytecode; the project itself is not installed.
FROM python AS dependencies
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON=/usr/local/bin/python3 \
    UV_PYTHON_DOWNLOADS=never \
    UV_PROJECT_ENVIRONMENT=/app/.venv
WORKDIR /app
RUN --mount=from=uv,source=/uv,target=/usr/local/bin/uv \
    --mount=type=cache,target=/root/.cache/uv \
    --mount=type=bind,source=pyproject.toml,target=pyproject.toml \
    --mount=type=bind,source=uv.lock,target=uv.lock \
    uv sync --locked --no-dev --no-install-project

# The code with its bytecode. Unchecked hashes: nothing in the image ever changes the sources.
FROM python AS code
WORKDIR /app
COPY src/ src/
RUN python -m compileall -q -j 0 --invalidation-mode unchecked-hash src

FROM python
RUN groupadd --system --gid 10001 debatemeet \
    && useradd --system --uid 10001 --gid debatemeet --no-create-home --home-dir /nonexistent \
        --shell /usr/sbin/nologin debatemeet
WORKDIR /app
COPY --from=dependencies /app/.venv .venv
COPY --from=code /app/src src
ENV PATH=/app/.venv/bin:$PATH \
    PYTHONPATH=/app/src \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1
# Files stay owned by root: the app can read its code but not change it.
USER debatemeet
EXPOSE 8000
# /api/health also checks the database: the deploy agent waits for it after a release.
HEALTHCHECK --interval=10s --timeout=3s --start-period=30s --start-interval=1s --retries=3 \
    CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/health', timeout=2)"]
# Last, so that a new version reuses every layer above. See tools/app-version.sh.
ARG APP_VERSION=dev
ENV DM_APP_VERSION=${APP_VERSION}
LABEL org.opencontainers.image.title="debatemeet-backend" \
      org.opencontainers.image.source="https://github.com/RuslanPogosyants/DebateMeet" \
      org.opencontainers.image.version="${APP_VERSION}"
CMD ["uvicorn", "debatemeet.main:create_app", "--factory", "--host", "0.0.0.0", "--port", "8000"]
