import os

import pytest

# The test database from compose.yaml; CI points it at its own Postgres.
TEST_DATABASE_URL = os.environ.get(
    "DM_TEST_DATABASE_URL",
    "postgresql+asyncpg://debatemeet:debatemeet@localhost:5450/debatemeet_test",
)


@pytest.fixture
def database_url() -> str:
    return TEST_DATABASE_URL
