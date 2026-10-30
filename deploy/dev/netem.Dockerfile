# Local measurement tools only; never shipped in a server release.
FROM livekit/livekit-server:v1.13.7
RUN apk add --no-cache iproute2
