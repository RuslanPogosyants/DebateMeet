"""The local LiveKit of compose.yaml and deploy/dev/livekit.yaml; DM_LIVEKIT_* override it."""

import os

URL = os.environ.get("DM_LIVEKIT_URL", "ws://localhost:7880")
API_KEY = os.environ.get("DM_LIVEKIT_API_KEY", "devkey")
# A public development value, as in deploy/dev/livekit.yaml; never used outside compose.yaml.
API_SECRET = os.environ.get("DM_LIVEKIT_API_SECRET", "dev-secret-only-for-local-livekit-000000")
