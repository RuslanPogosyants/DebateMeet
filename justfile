# Developer commands. `just` lists them.

set shell := ["bash", "-euo", "pipefail", "-c"]

[private]
default:
    @just --list --unsorted

# Install dependencies and git hooks, create backend/.env
setup:
    lefthook install
    [ -f backend/.env ] || cp backend/.env.example backend/.env
    cd backend && uv sync --locked
    cd frontend && pnpm install --frozen-lockfile

# Start Postgres and LiveKit from compose.yaml
up:
    docker compose up -d --wait

# Stop them; the data stays
down:
    docker compose down

# Start Postgres and LiveKit, then the backend and Vite together; Ctrl-C stops both
dev: up
    #!/usr/bin/env bash
    set -euo pipefail
    trap 'kill 0' EXIT
    {{ just_executable() }} dev-backend &
    {{ just_executable() }} dev-web &
    wait

# Run the backend with reload on :8000; LiveKit reaches it through host.docker.internal
dev-backend:
    cd backend && uv run uvicorn debatemeet.main:create_app --factory --reload --host 0.0.0.0 --port 8000

# Run Vite on :5173; it proxies /api to the backend on :8000
dev-web:
    cd frontend && pnpm dev

# All tests
test: up
    python3 -m unittest discover -s tools/git
    cd backend && uv run pytest
    cd frontend && pnpm test

# Linters, type checks and layer rules
lint:
    cd backend && uv run ruff check && uv run ruff format --check && uv run mypy && uv run lint-imports
    cd frontend && pnpm lint && pnpm format:check && pnpm typecheck && pnpm depcruise

# Apply formatting and safe lint fixes
fmt:
    cd backend && uv run ruff check --fix && uv run ruff format
    cd frontend && pnpm lint --fix && pnpm format

# Start N bots in a media room: a tone and a test picture each; Ctrl-C stops them
bots n="1" room="bots": up
    cd backend && uv run python -m bots {{ n }} --media-room {{ room }}

# Regenerate frontend/src/contract from the backend OpenAPI; CI fails when it is stale
contract:
    cd backend && uv run python -m debatemeet.openapi ../frontend/src/contract/openapi.json
    cd frontend && pnpm contract
