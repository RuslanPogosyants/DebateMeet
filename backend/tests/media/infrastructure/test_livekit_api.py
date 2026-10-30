import jwt
from livekit import api

from bots import dev
from debatemeet.media.infrastructure.livekit_api import LiveKitApiAdapter
from debatemeet.round.domain.ids import ParticipantId
from tests.round.builders import ROUND_ID


def test_participant_tokens_cannot_spoof_state_or_change_metadata() -> None:
    adapter = LiveKitApiAdapter(dev.URL, dev.API_KEY, dev.API_SECRET)

    token = adapter.token(ROUND_ID, ParticipantId("p01234567890"), "Alice")
    claims = api.TokenVerifier(dev.API_KEY, dev.API_SECRET).verify(token)
    payload = jwt.decode(token, options={"verify_signature": False})

    assert claims.identity == "p01234567890"
    assert claims.name == "Alice"
    assert claims.video is not None
    assert claims.video.room == ROUND_ID
    assert claims.video.can_publish_data is False
    assert claims.video.can_update_own_metadata is False
    assert claims.video.can_publish_sources == ["camera", "microphone"]
    assert claims.room_config is not None
    assert claims.room_config.max_participants == 30
    assert payload["exp"] - payload["nbf"] == 600
