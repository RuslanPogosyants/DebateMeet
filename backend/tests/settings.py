from pydantic import SecretStr

from bots import dev
from debatemeet.shared.infrastructure.settings import Environment, Settings


def settings_for(
    database_url: str, *, environment: Environment = "test", app_version: str = "dev"
) -> Settings:
    """Settings of a test app; LiveKit is the local one of compose.yaml."""
    return Settings(
        database_url=database_url,
        environment=environment,
        app_version=app_version,
        livekit_api_key=dev.API_KEY,
        livekit_api_secret=SecretStr(dev.API_SECRET),
    )
