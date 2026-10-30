import jwt
import pytest
from livekit import api
from livekit.api.room_service import RoomService
from livekit.protocol.models import TrackInfo, TrackSource

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
    assert claims.video.can_publish_sources == ["camera", "microphone", "screen_share"]
    assert claims.room_config is not None
    assert claims.room_config.max_participants == 30
    assert payload["exp"] - payload["nbf"] == 600


@pytest.mark.parametrize(
    ("track", "confirmed"),
    [
        (None, False),
        (TrackInfo(sid="TR_other", source=TrackSource.MICROPHONE, muted=True), False),
        (TrackInfo(sid="TR_expected", source=TrackSource.CAMERA, muted=True), False),
        (TrackInfo(sid="TR_expected", source=TrackSource.MICROPHONE, muted=False), False),
        (TrackInfo(sid="TR_expected", source=TrackSource.MICROPHONE, muted=True), True),
    ],
)
async def test_mute_confirmation_requires_the_exact_returned_microphone_track(
    monkeypatch: pytest.MonkeyPatch, track: TrackInfo | None, confirmed: bool
) -> None:
    requests: list[api.MuteRoomTrackRequest] = []

    async def muted(_: RoomService, request: api.MuteRoomTrackRequest) -> api.MuteRoomTrackResponse:
        requests.append(request)
        return api.MuteRoomTrackResponse(track=track)

    monkeypatch.setattr(RoomService, "mute_published_track", muted)
    adapter = LiveKitApiAdapter(dev.URL, dev.API_KEY, dev.API_SECRET)
    try:
        assert (
            await adapter.mute_microphone(ROUND_ID, ParticipantId("p" * 12), "TR_expected")
            is confirmed
        )
        assert len(requests) == 1
        assert requests[0].muted is True
        assert requests[0].track_sid == "TR_expected"
    finally:
        await adapter.aclose()
