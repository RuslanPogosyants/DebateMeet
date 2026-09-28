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

# Start Postgres and LiveKit from compose.yaml
up:
    docker compose up -d --wait

# Stop them; the data stays
down:
    docker compose down

# Run the backend with reload on :8000; LiveKit reaches it through host.docker.internal
dev: up
    cd backend && uv run uvicorn debatemeet.main:create_app --factory --reload --host 0.0.0.0 --port 8000

# All tests
test: up
    python3 -m unittest discover -s tools/git
    cd backend && uv run pytest

# Linters, type checks and layer rules
lint:
    cd backend && uv run ruff check && uv run ruff format --check && uv run mypy && uv run lint-imports

# Apply formatting and safe lint fixes
fmt:
    cd backend && uv run ruff check --fix && uv run ruff format
