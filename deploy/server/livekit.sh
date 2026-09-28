#!/bin/sh
# Starts LiveKit on a server. Refuses the dev key of deploy/dev/livekit.yaml: a server with it would
# accept tokens anyone can sign (docs/architecture.md §6). LiveKit itself refuses empty keys.
set -eu
case "${LIVEKIT_KEYS:-}" in
  *devkey* | *dev-secret-only-for-local-livekit*)
    echo "livekit.sh: LIVEKIT_KEYS holds the dev key of deploy/dev/livekit.yaml; refusing to start" >&2
    exit 1
    ;;
esac
exec /livekit-server --config /etc/livekit.yaml "$@"
