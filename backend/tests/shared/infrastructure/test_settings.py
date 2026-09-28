import pytest
from pydantic import SecretStr, ValidationError

from debatemeet.shared.infrastructure.settings import (
    DEV_LIVEKIT_API_KEY,
    DEV_LIVEKIT_API_SECRET,
    Environment,
    Settings,
)

DATABASE_URL = "postgresql+asyncpg://debatemeet:debatemeet@127.0.0.1:5432/debatemeet"
SERVER_KEY, SERVER_SECRET = "APIserver", "a-server-secret-00000000000000000000000"


def settings(environment: Environment, key: str, secret: str) -> Settings:
    return Settings(
        _env_file=None,
        database_url=DATABASE_URL,
        environment=environment,
        livekit_api_key=key,
        livekit_api_secret=SecretStr(secret),
    )


@pytest.mark.parametrize("environment", ["stage", "prod"])
@pytest.mark.parametrize(
    ("key", "secret"),
    [
        (DEV_LIVEKIT_API_KEY, DEV_LIVEKIT_API_SECRET),
        (DEV_LIVEKIT_API_KEY, SERVER_SECRET),
        (SERVER_KEY, DEV_LIVEKIT_API_SECRET),
    ],
)
def test_servers_refuse_the_dev_key(environment: Environment, key: str, secret: str) -> None:
    with pytest.raises(ValidationError, match="refuses the dev LiveKit key"):
        settings(environment, key, secret)


@pytest.mark.parametrize("environment", ["dev", "test"])
def test_local_environments_take_the_dev_key(environment: Environment) -> None:
    local = settings(environment, DEV_LIVEKIT_API_KEY, DEV_LIVEKIT_API_SECRET)
    assert local.environment == environment


def test_a_server_takes_its_own_key() -> None:
    assert settings("prod", SERVER_KEY, SERVER_SECRET).environment == "prod"
