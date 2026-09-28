import json
from pathlib import Path

from debatemeet.main import create_app
from debatemeet.openapi import CONTRACT_VERSION, main, openapi_schema
from debatemeet.shared.infrastructure.settings import Settings


def test_contract_is_the_schema_of_the_served_app(database_url: str) -> None:
    served = create_app(
        Settings(database_url=database_url, environment="prod", app_version="abc")
    ).openapi()

    exported = openapi_schema()

    assert exported["info"]["version"] == CONTRACT_VERSION
    assert {**exported, "info": served["info"]} == served


def test_export_writes_the_schema_as_json(tmp_path: Path) -> None:
    target = tmp_path / "openapi.json"

    assert main(["openapi", str(target)]) == 0

    assert json.loads(target.read_text(encoding="utf-8")) == openapi_schema()


def test_export_needs_a_path() -> None:
    assert main(["openapi"]) == 2
