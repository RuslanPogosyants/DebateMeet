#!/usr/bin/env bash
# Apply impairment only to the running local dev LiveKit namespace, then remove it on every exit.
set -euo pipefail

task_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
media_container="$(docker compose --project-directory "$task_root" ps -q livekit)"
if [ -z "$media_container" ] || [ "$#" -eq 0 ]; then
    echo 'Start local LiveKit and pass the measurement command.' >&2
    exit 2
fi

tc_in_media() {
    docker run --rm --network "container:$media_container" --cap-add NET_ADMIN \
        --entrypoint tc debatemeet-netem:dev "$@"
}

# add refuses an existing root policy; cleanup is registered only after our policy is installed.
tc_in_media qdisc add dev eth0 root netem delay 100ms 20ms loss 1%
cleanup() {
    tc_in_media qdisc del dev eth0 root
    tc_in_media qdisc show dev eth0
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
tc_in_media qdisc show dev eth0
"$@"
