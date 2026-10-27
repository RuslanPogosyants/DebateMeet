# DebateMeet

Web platform for British Parliamentary debate rounds: one link = one round with six logical rooms (base, OG, OO, CG, CO, judges), shared timers, motion, position draw, hands, chat. Self-hosted LiveKit, FastAPI, Postgres, React. Goal: a high-tier pet project at pre-product level — production-grade engineering without premature product weight.

**Current stage (2026-10-27, preparation A5 on `codex/slice-5-participation`, based on B4 `971ac08`):** slices 0a/0b and slices 1–4 are implemented locally. A5 adds compatible hand state, snapshot/packet contracts, pure client queue/guards, migration 0005, microphone control transport and retained command keys. B5 endpoints and hands/microphone/reaction/volume UI are not implemented. A5 verification passed 659 backend cases (658 in the full run plus the webhook case separately after port 8000 was free), 351 frontend tests, full lint/type/layer checks, 15 built-app scenarios and three local image builds. Independent implementation reviews are closed. Control-specific concurrency/fairness/cancellation and mutating-timeout marker barriers are covered; four source mutations fail their intended assertions. A corrupt control head blocks only its own round without acknowledgement or data repair. See `docs/architecture.md` §11 for precise evidence and remaining work. The author explicitly deferred the physical Chrome/laptop-speaker echo check; it remains unconfirmed, and volume above 100% must stay unavailable.

**A5 preparation boundary:** `Participant.hand` is a nullable `Hand` value; legacy schema-1 state without the field reads as `None`, corrupt state returns 503 without resetting it, and the snapshot declares required nullable `handRaisedAt`. The largest prepared snapshot is 13,357 of 14,336 bytes. A5 supplies the preparation boundary before B5. Actual frozen A5 source fixtures and B5 → A5 → B5 verification belong after the A5 commit and B5 implementation; they do not exist yet. The earlier B4 → actual A4 → B4 evidence remains recorded in `docs/architecture.md` §11.

Slices 1–6 follow a local development and verification policy (dev stack, bots and E2E). B5 adds hands, judge microphone commands, reactions and individual volume, followed by slice 6 (resilience). The stand itself — registry push, server, backups, alerts and real-network checks — remains slice S («С» in the Russian docs), after slice 6 (`docs/adr/0001-stand-after-slice-6.md`). Feature PRs target `main`; B4 PR #45 is published. No remote CI checks have been confirmed; these changes have not been merged or deployed. The architecture and API sections below include the target design: B5 user features, resilience and round deletion still belong to later work.

## Source of truth

- `docs/spec.md` — what we build (MVP decisions). Update it when the author changes a decision.
- `docs/architecture.md` — target design: glossary, contexts, aggregates and invariants, presence transitions, layers, persistence, LiveKit integration, frontend, API, tests, CI/CD and operations; §11 tracks implementation status and the roadmap. Design approved by the author and externally reviewed.
- `docs/design.md` — how the interface looks and behaves: the «Реплика» visual direction and its rules, round screen layout at every size, start and entry screens, action safety, states to draw. Chosen by the author after aesthetic and UX reviews of the first mockups.
- `docs/research.md` — a historical snapshot (2026-09-27) with sources. Where it disagrees with spec or architecture (e.g. participant attributes, 60 s flag hold, round reset), spec and architecture win.
- Read the relevant sections before proposing changes. Do not re-propose what they reject without new facts. Major changes go through an ADR in `docs/adr/`, discussed with the author first.
- Keep `AGENTS.md` byte-for-byte identical to `CLAUDE.md` when editing either file.

## Principles

- **The platform never moves or mutes anyone by itself.** No state machine of round phases. Mute and recall exist only as manual judge commands. Any heuristic must fail harmlessly and be undoable.
- **Plan and patterns before code.** Agree on design in chat, record it in the docs, then implement.
- **Accounts, roles, permissions, room privacy and personal-data formalities are deliberately deferred.** Access is by unguessable link only; keep the design open for accounts later.
- **Never estimate or mention work in hours.** Argue by substance; say "this is the hardest part" instead of numbers.

## Language

- Chat with the author and all docs: Russian.
- Code, identifiers, comments, commit messages: English.
- Use the glossary (`docs/architecture.md` §1): one concept, one word in both languages. `room` in code is always a logical room; a LiveKit room is a `MediaRoom`.

## Decisions most often re-proposed — they are settled

- No round reset: a round lives as long as its link. Participants absent for more than 5 minutes are evicted from the aggregate into the participant archive; the snapshot stays bounded (≤ 40 participants, ≤ 14 KiB).
- The judge flag is released immediately when its holder disconnects and never comes back by itself; a prominent "take it again" button instead. No hold period.
- The judge never moves individuals: only `recall(room)` for a subroom and `recall_all`.
- The link code is the round id (not separated). No organizer link; control is admin CLI commands on the server (`just admin …`).
- Participant id (12 chars, public) and secret (256 bits) are issued by the server per round.
- State reaches clients as a full versioned `RoundSnapshot`: reliable data packet on change, room metadata refreshed on the active leader's 2 s cadence (including unchanged state to repair a stale in-flight write after lease loss; see architecture §6), snapshot in every command response, `GET /snapshot?epoch=&since=` every 15 s. Participant attributes are not used. Clients cannot publish data packets (no `canPublishData`); reactions go through the backend.
- Presence is a cache of LiveKit state with the transition table in §3; LiveKit is never called under the round row lock.
- `@livekit/components-react` is not used: `MediaSession` is the single owner of subscriptions, track attachment and volume.

## Architecture in one screen

- Modular monolith, DDD, ports and adapters. Contexts: **Round** (core; chat is a separate aggregate in `round/chat/`) and **Media** (anti-corruption layer over LiveKit).
- Backend layout: `shared/{domain,application,infrastructure,api}`; `round/{domain,application,infrastructure,api,contract,chat}`; `media/{application,infrastructure,api}`; composition roots `main.py` (HTTP), `admin.py` (CLI), `openapi.py` (the contract export) and `migrate.py` (schema migrations, the one way to run the Alembic history in `migrations/`); dev bots in `backend/bots/`, outside the package. `domain` is pure synchronous Python on dataclasses: no FastAPI, SQLAlchemy, Pydantic or LiveKit; `now` and randomness are passed in. Enforced by `import-linter`. Manual wiring, no DI container.
- Frontend layout: `src/{contract,domain,application,infrastructure,ui}`, the same hexagon; `contract` is generated from the backend OpenAPI and is available to every layer. Enforced by `dependency-cruiser`.
- One `Round` aggregate stored as a JSONB document with a schema number; one row lock per command; monotonic version plus `epoch` (changes on backup restore). An unknown schema is an error, never a reset; the document evolves expand → contract.
- Delivery to LiveKit: a single publisher leader (Postgres advisory lock, `NOTIFY` + 1 s tick) with delivery levels in `media_rooms` and a transactional outbox (`media_outbox`). Participant removal, chat and system lines are implemented. A5 adds a separate microphone control lane with a durable marker before the single mutating attempt; HTTP commands and user interaction remain B5. Removal revisions fence late acknowledgements; bounded SDK tasks keep normal delivery independent. Final acceptance still requires isolation of a corrupt control head. Startup recovery retries busy and unobserved rounds independently.

## API conventions

- Command per endpoint under `/api/rounds/{id}`; domain commands return `200` with the snapshot and require `Idempotency-Key`. Exceptions are listed in `docs/architecture.md` §8.
- `Authorization: Bearer <participant_id>.<secret>`; JSON in camelCase; time in epoch milliseconds; errors as `{code, message}`.

## Stack and pinned choices

- Python 3.14, uv, FastAPI, Pydantic (API boundary and settings only), SQLAlchemy Core (no ORM), asyncpg, Alembic, livekit-api, structlog; ruff, mypy strict, pytest, Hypothesis.
- Node ≥ 24, pnpm (version pinned by `frontend/package.json`, with `minimumReleaseAge` and `trustPolicy`), Vite, React, TypeScript 6.0.x (TS 7 is not yet supported by the lint tooling), Zustand, React Router, Tailwind 4, shadcn/ui, livekit-client; oxlint, Prettier, Vitest, fast-check, Playwright. `just test` runs unit/integration tests; `just test-e2e` builds the client and runs Chromium against real local Postgres/LiveKit with fake capture devices.
- Dev infra: `docker compose up -d` in the repo root starts Postgres 18 (host port 5450, databases `debatemeet` and `debatemeet_test`) and LiveKit 1.13.7 (config in `deploy/dev/livekit.yaml`): it creates no media room on join (`room.auto_create: false`) and sends signed webhooks to the backend on `host.docker.internal:8000`. `just bots N` starts test participants with a tone and a test picture.
- Servers never reach abroad (images, STUN, error tracking); the only exception is Caddy's ACME for TLS certificates. No Sentry SaaS.

## Git and PRs

- Trunk-based: short branches, PR into `main`, squash merge, only when the latest `ci-ok` on the PR head is green (not enforced by GitHub: there is no branch protection by the author's decision). Claude merges its own PRs; the author merges PRs that change the guardrails (`.claude/`, `tools/git/`, `lefthook.yml`) and PRs opened by bots such as Dependabot.
- Every PR targets `main`. If a PR has to stack on another, retarget it with `gh pr edit N --base main` and merge `main` into it after the parent merges, before merging it.
- Commit message and PR title: one line `type: description` in English, types `feat|fix|refactor|docs|test|chore`, no body.
- **No attribution of any kind** in commits or PRs: no `Co-Authored-By`, no "Generated with Claude Code", no 🤖, no mention of Claude. Commits use the repo git identity; PRs are opened with the author's `gh`.
- Claude may commit, push feature branches, open or update PRs and merge its own PRs with `gh pr merge N --squash --body ""` (a one-line squash commit). Never push to `main`, force-push, amend, use `--no-verify`, change `hooksPath`, stage with `git add .`/`-A`/`-u` (add explicit paths), merge any other way (`--admin`, `--auto`, `--merge`, `--rebase`, `--delete-branch`, `gh api`), create releases, run repository operations (`gh repo …`) or run workflows manually. The hook `.claude/hooks/git-guard.py` blocks these and checks every merge against GitHub (hooks load when a session starts); it is a guardrail, not a security boundary — do not try to work around it. Commit messages are checked by `tools/git/check_message.py` (lefthook `commit-msg`).
- The repository is public: never commit secrets or `.env` files.
- No license for now (all rights reserved).
