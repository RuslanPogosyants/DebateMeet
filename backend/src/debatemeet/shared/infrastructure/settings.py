from typing import Literal, Self

from pydantic import SecretStr, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

type Environment = Literal["dev", "test", "stage", "prod"]

# The public key pair of deploy/dev/livekit.yaml: a server with it accepts tokens anyone signs.
DEV_LIVEKIT_API_KEY = "devkey"
DEV_LIVEKIT_API_SECRET = "dev-secret-only-for-local-livekit-000000"  # noqa: S105
SERVER_ENVIRONMENTS: tuple[Environment, ...] = ("stage", "prod")


class Settings(BaseSettings):
    """Backend settings: DM_* environment variables, locally also backend/.env."""

    model_config = SettingsConfigDict(env_prefix="DM_", env_file=".env", extra="ignore")

    environment: Environment = "dev"
    # Date and commit sha, set when the image is built.
    app_version: str = "dev"
    log_level: Literal["DEBUG", "INFO", "WARNING", "ERROR"] = "INFO"
    database_url: str
    # The key LiveKit signs its webhooks with; locally the one of deploy/dev/livekit.yaml.
    livekit_api_key: str
    livekit_api_secret: SecretStr

    @model_validator(mode="after")
    def refuse_the_dev_key_on_servers(self) -> Self:
        dev_pair = (
            self.livekit_api_key == DEV_LIVEKIT_API_KEY
            or self.livekit_api_secret.get_secret_value() == DEV_LIVEKIT_API_SECRET
        )
        if self.environment in SERVER_ENVIRONMENTS and dev_pair:
            raise ValueError(
                f"the {self.environment} backend refuses the dev LiveKit key of"
                " deploy/dev/livekit.yaml: set DM_LIVEKIT_API_KEY and DM_LIVEKIT_API_SECRET"
            )
        return self
