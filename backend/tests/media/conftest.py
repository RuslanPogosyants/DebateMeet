import pytest

from tests.media.livekit import wait_for_livekit


@pytest.fixture(scope="session")
def livekit() -> None:
    """The LiveKit of compose.yaml, up and answering."""
    wait_for_livekit()
