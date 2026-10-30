# Actual A6 source boundary

These immutable fixtures preserve every tracked source file under `backend/src/debatemeet`
from commit `757f9cf8b1f73b7d91edcc3948bc91b61c073089`. The manifest records original paths
and SHA-256 hashes. They were extracted with read-only Git during development; tests need
no Git history and materialize the preserved bytes in their own temporary directory.

Do not format, modernize, or edit historical sources. New compatibility boundaries require
new fixtures. Non-Python package resources are preserved too. Runtime tests verify hashes
and module origins before exercising actual A6 against an isolated Postgres database.
An injected SDK boundary is separate from native RTC and physical acoustics acceptance.

The boundary contains 122 Python modules and two package resources (124 files,
361,235 bytes). `run_a6.py.fixture` is the current test harness, not historical
application source. It must load every `debatemeet` module from the materialized
source directory and rejects a leaked B6 deletion producer.

The real PG proof exercises A6's production HTTP composition, ordinary commands,
diagnostic ingestion/deduplication, publisher, terminal-room recovery and maintenance.
Native DeleteRoom/disconnection/stale-JWT evidence is kept separately in
`tests/media/infrastructure/test_livekit_round_deletion.py`.
