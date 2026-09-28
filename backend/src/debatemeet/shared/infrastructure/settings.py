from typing import Literal

from pydantic import SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict

type Environment = Literal["dev", "test", "stage", "prod"]


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
