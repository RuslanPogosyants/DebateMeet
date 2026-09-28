#!/bin/sh
# The application version (docs/architecture.md §10): the commit date in UTC and the short sha,
# for example 2026.09.28-08f224a1b2c3. A build with uncommitted changes gets "-dirty".
set -eu
date=$(TZ=UTC0 git log -1 --date=format-local:%Y.%m.%d --format=%cd)
sha=$(git rev-parse --short=12 HEAD)
dirty=$(git diff --quiet HEAD -- || echo -dirty)
echo "$date-$sha$dirty"
