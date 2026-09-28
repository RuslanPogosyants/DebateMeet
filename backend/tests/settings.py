from pydantic import SecretStr

from bots import dev
from debatemeet.shared.infrastructure.settings import SERVER_ENVIRONMENTS, Environment, Settings

# Servers refuse the dev LiveKit key, so a test app of theirs gets a key of its own.
SERVER_API_KEY = "APItestserver"
SERVER_API_SECRET = "test-secret-of-a-server-app-000000000000"  # noqa: S105


def settings_for(
    database_url: str, *, environment: Environment = "test", app_version: str = "dev"
) -> Settings:
    """Settings of a test app; LiveKit is the local one of compose.yaml."""
    server = environment in SERVER_ENVIRONMENTS
    return Settings(
        database_url=database_url,
        environment=environment,
        app_version=app_version,
        livekit_api_key=SERVER_API_KEY if server else dev.API_KEY,
        livekit_api_secret=SecretStr(SERVER_API_SECRET if server else dev.API_SECRET),
    )
