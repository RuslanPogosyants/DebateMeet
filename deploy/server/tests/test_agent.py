"""Tests of the deploy agent against a fake registry and a fake compose (docs/architecture.md §9).

Run: python3 -m unittest discover -s deploy/server/tests
"""

from __future__ import annotations

import contextlib
import fcntl
import hashlib
import importlib.util
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from collections.abc import Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from unittest import mock

AGENT = Path(__file__).resolve().parents[1] / "agent.py"
spec = importlib.util.spec_from_file_location("agent", AGENT)
assert spec and spec.loader
agent = importlib.util.module_from_spec(spec)
# dataclasses resolve the string annotations of the module through sys.modules.
sys.modules["agent"] = agent
spec.loader.exec_module(agent)

REGISTRY = "registry.test/debatemeet"
STAGE = f"{REGISTRY}/bundle:stage"
DAY = 24 * 3600


def sha(text: str) -> str:
    return "sha256:" + hashlib.sha256(text.encode()).hexdigest()


@dataclass
class Image:
    labels: dict[str, str]
    files: dict[str, bytes]


@dataclass
class Call:
    step: str
    args: tuple[str, ...]
    backend: str


@dataclass
class Published:
    name: str
    digest: str
    backend: str

    @property
    def id(self) -> str:
        return self.digest.split(":", 1)[1][:12]


def step_of(args: Sequence[str]) -> str:
    if "debatemeet.migrate" in args:
        return "migrate"
    if args[0] == "up":
        return "up-postgres" if args[-1] == "postgres" else "up"
    if args[0] == "exec" and "reload" in args:
        return "reload"
    return args[0]


@dataclass
class FakeDocker:
    """A registry in memory and a compose that records its calls and fails where a test says."""

    tags: dict[str, str] = field(default_factory=dict)
    images: dict[str, Image] = field(default_factory=dict)
    calls: list[Call] = field(default_factory=list)
    # (step, backend image) pairs that fail.
    failing: set[tuple[str, str]] = field(default_factory=set)
    registry_down: bool = False

    def publish(
        self,
        name: str,
        *,
        caddyfile: str = "{$DM_APP_DOMAIN} { }\n",
        livekit: str = "port: 7880\n",
        assets: Sequence[str] = (),
        labels: bool = True,
    ) -> Published:
        """Pushes the images of a release and points the stage tag at its bundle."""
        digest = sha(name)
        backend = f"{REGISTRY}/backend@{sha(name + '/backend')}"
        web = f"{REGISTRY}/web@{sha(name + '/web')}"
        bundle_labels = {agent.VERSION_LABEL: name}
        if labels:
            bundle_labels |= {agent.BACKEND_LABEL: backend, agent.WEB_LABEL: web}
        self.images[f"{REGISTRY}/bundle@{digest}"] = Image(
            bundle_labels,
            {
                "/bundle/compose.yaml": f"# compose.yaml of {name}\n".encode(),
                "/bundle/env.example": b"DM_ENVIRONMENT=stage\n",
                "/bundle/agent.py": f"# agent of {name}\n".encode(),
                "/bundle/caddy/Caddyfile": caddyfile.encode(),
                "/bundle/livekit/livekit.yaml": livekit.encode(),
                "/bundle/livekit/livekit.sh": b"#!/bin/sh\n",
                "/bundle/systemd/debatemeet-agent.service": b"[Service]\n",
            },
        )
        self.images[backend] = Image({}, {})
        web_files = {"/web/index.html": f"<title>{name}</title>".encode()}
        for asset in assets or (f"index-{name}.js",):
            web_files[f"/web/assets/{asset}"] = f"// {asset}".encode()
        self.images[web] = Image({}, web_files)
        self.tags[STAGE] = digest
        return Published(name, digest, backend)

    def fail(self, step: str, release: Published) -> None:
        self.failing.add((step, release.backend))

    # the Docker port

    def resolve(self, ref: str) -> str:
        if self.registry_down:
            raise agent.DockerError("the registry does not answer")
        return self.tags[ref]

    def pull(self, ref: str) -> None:
        if self.registry_down or ref not in self.images:
            raise agent.DockerError(f"cannot pull {ref}")

    def labels(self, ref: str) -> dict[str, str]:
        return dict(self.images[ref].labels)

    def export(self, ref: str, source: str, destination: Path) -> None:
        for path, data in self.images[ref].files.items():
            if path.startswith(source + "/"):
                target = destination / path[len(source) + 1 :]
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(data)

    def compose(self, project: Path, env_files: Sequence[Path], args: Sequence[str]) -> bool:
        assert [path.name for path in env_files] == [".env", "release.env"]
        release_env = project / "release.env"
        backend = (
            agent.read_env(release_env).get("DM_BACKEND_IMAGE", "") if release_env.exists() else ""
        )
        call = Call(step_of(args), tuple(args), backend)
        self.calls.append(call)
        return (call.step, backend) not in self.failing


class AgentTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.web = self.root / "web"
        (self.root / "server").mkdir()
        (self.root / "server" / ".env").write_text(
            f"# The operator's file\nDM_REGISTRY={REGISTRY}\nDM_WEB_ROOT='{self.web}'\n"
        )
        self.docker = FakeDocker()
        self.clock = 1_000_000_000.0
        self.agent = agent.Agent(self.root, self.docker, now=lambda: self.clock)

    def tick(self) -> int:
        with contextlib.redirect_stdout(io.StringIO()) as output:
            code = self.agent.tick()
        self.output = output.getvalue()
        return code

    def events(self) -> list[str]:
        return [json.loads(line)["event"] for line in self.output.splitlines()]

    def state(self) -> agent.State:
        return agent.State.load(self.root / "state.json")

    def backend(self) -> str:
        return agent.read_env(self.root / "server" / "release.env")["DM_BACKEND_IMAGE"]

    def index(self) -> str:
        return (self.web / "current" / "index.html").read_text()

    def server_file(self, name: str) -> str:
        return (self.root / "server" / name).read_text()

    def steps(self) -> list[str]:
        return [call.step for call in self.docker.calls]

    def deployed(self, name: str, **publish: Any) -> Published:
        release = self.docker.publish(name, **publish)
        self.assertEqual(self.tick(), 0, self.output)
        self.docker.calls.clear()
        return release

    # the happy path

    def test_the_first_release_is_rolled_out(self) -> None:
        release = self.docker.publish("a")
        self.assertEqual(self.tick(), 0, self.output)
        self.assertEqual(self.steps(), ["up-postgres", "migrate", "up"])
        # Migrations run on the new image, before the backend is recreated.
        self.assertEqual(self.docker.calls[1].backend, release.backend)
        self.assertEqual(self.backend(), release.backend)
        self.assertEqual(self.index(), "<title>a</title>")
        self.assertEqual(os.readlink(self.web / "current"), f"releases/{release.id}")
        self.assertTrue((self.web / "assets" / "index-a.js").is_file())
        self.assertEqual(self.server_file("compose.yaml"), "# compose.yaml of a\n")
        self.assertEqual(self.server_file("caddy/Caddyfile"), "{$DM_APP_DOMAIN} { }\n")
        self.assertEqual(self.state(), agent.State(current=release.digest))
        self.assertIn("release_done", self.events())

    def test_a_new_release_replaces_the_current_one(self) -> None:
        first = self.deployed("a")
        second = self.docker.publish("b")
        self.assertEqual(self.tick(), 0, self.output)
        self.assertEqual(self.backend(), second.backend)
        self.assertEqual(self.index(), "<title>b</title>")
        # The assets of the previous release stay for the tabs opened on it.
        self.assertTrue((self.web / "assets" / "index-a.js").is_file())
        self.assertEqual(self.state(), agent.State(current=second.digest, previous=first.digest))

    def test_the_current_release_is_left_alone(self) -> None:
        self.deployed("a")
        self.assertEqual(self.tick(), 0)
        self.assertEqual(self.steps(), [])
        self.assertEqual(self.output, "")

    def test_files_gone_from_a_mounted_directory_are_removed(self) -> None:
        self.deployed("a")
        (self.root / "server" / "caddy" / "old.conf").write_text("stale\n")
        self.docker.publish("b")
        self.tick()
        self.assertFalse((self.root / "server" / "caddy" / "old.conf").exists())

    def test_static_files_are_readable_by_other_users(self) -> None:
        release = self.deployed("a")
        for path in (
            self.web / "assets" / "index-a.js",
            self.web / "releases" / release.id / "index.html",
        ):
            self.assertEqual(path.stat().st_mode & 0o777, 0o644, path)

    # Caddy and LiveKit

    def test_a_changed_caddyfile_is_reloaded(self) -> None:
        self.deployed("a")
        self.docker.publish("b", caddyfile="{$DM_APP_DOMAIN} { encode gzip }\n")
        self.assertEqual(self.tick(), 0, self.output)
        self.assertEqual(self.steps(), ["up-postgres", "migrate", "up", "reload"])

    def test_a_changed_livekit_config_restarts_livekit(self) -> None:
        self.deployed("a")
        self.docker.publish("b", livekit="port: 7880\nlogging:\n  level: debug\n")
        self.assertEqual(self.tick(), 0, self.output)
        self.assertEqual(self.steps(), ["up-postgres", "migrate", "up", "restart"])
        self.assertEqual(self.docker.calls[-1].args, ("restart", "livekit"))

    def test_unchanged_configs_touch_neither(self) -> None:
        self.deployed("a")
        self.docker.publish("b")
        self.tick()
        self.assertEqual(self.steps(), ["up-postgres", "migrate", "up"])

    # failures and rollbacks

    def test_failed_migrations_fail_the_release_and_it_is_not_retried(self) -> None:
        first = self.deployed("a")
        broken = self.docker.publish("b")
        self.docker.fail("migrate", broken)
        self.assertEqual(self.tick(), 1)
        self.assertEqual(self.steps(), ["up-postgres", "migrate", "up"])
        self.assertEqual(self.backend(), first.backend)
        self.assertEqual(self.server_file("compose.yaml"), "# compose.yaml of a\n")
        self.assertEqual(self.index(), "<title>a</title>")
        self.assertEqual(self.state(), agent.State(current=first.digest, failed=[broken.digest]))
        self.docker.calls.clear()
        self.assertEqual(self.tick(), 0)
        self.assertEqual(self.steps(), [])

    def test_an_unhealthy_backend_is_rolled_back(self) -> None:
        first = self.deployed("a")
        broken = self.docker.publish("b", caddyfile="{$DM_APP_DOMAIN} { encode gzip }\n")
        self.docker.fail("up", broken)
        self.assertEqual(self.tick(), 1)
        # The second `up` runs the previous backend image again; Caddy never saw the new file.
        self.assertEqual(self.steps(), ["up-postgres", "migrate", "up", "up"])
        self.assertEqual(self.docker.calls[-1].backend, first.backend)
        self.assertEqual(self.backend(), first.backend)
        self.assertEqual(self.server_file("caddy/Caddyfile"), "{$DM_APP_DOMAIN} { }\n")
        self.assertEqual(self.index(), "<title>a</title>")
        self.assertIn("rollback_done", self.events())

    def test_a_caddyfile_caddy_rejects_is_rolled_back_and_reloaded_again(self) -> None:
        first = self.deployed("a")
        broken = self.docker.publish("b", caddyfile="{$DM_APP_DOMAIN} { nonsense }\n")
        self.docker.fail("reload", broken)
        self.assertEqual(self.tick(), 1)
        self.assertEqual(self.steps(), ["up-postgres", "migrate", "up", "reload", "up", "reload"])
        self.assertEqual(self.docker.calls[-1].backend, first.backend)
        self.assertEqual(self.server_file("caddy/Caddyfile"), "{$DM_APP_DOMAIN} { }\n")
        self.assertEqual(self.state().failed, [broken.digest])

    def test_a_first_release_that_fails_is_remembered(self) -> None:
        broken = self.docker.publish("a")
        self.docker.fail("migrate", broken)
        self.assertEqual(self.tick(), 1)
        self.assertEqual(self.state(), agent.State(failed=[broken.digest]))
        self.assertFalse((self.web / "current").exists())
        self.assertIn("rollback_impossible", self.events())

    def test_the_next_release_after_a_failed_one_is_rolled_out(self) -> None:
        self.deployed("a")
        broken = self.docker.publish("b")
        self.docker.fail("migrate", broken)
        self.tick()
        fixed = self.docker.publish("c")
        self.assertEqual(self.tick(), 0, self.output)
        self.assertEqual(self.backend(), fixed.backend)
        self.assertEqual(self.state().failed, [broken.digest])

    def test_a_bundle_without_image_labels_is_a_failed_release(self) -> None:
        broken = self.docker.publish("a", labels=False)
        self.assertEqual(self.tick(), 1)
        self.assertEqual(self.state().failed, [broken.digest])
        self.assertEqual(self.steps(), [])

    def test_registry_trouble_fails_the_tick_but_blames_no_release(self) -> None:
        self.docker.publish("a")
        self.docker.registry_down = True
        self.assertEqual(self.tick(), 1)
        self.assertEqual(self.state(), agent.State())
        self.docker.registry_down = False
        self.assertEqual(self.tick(), 0, self.output)

    # housekeeping

    def test_a_tick_that_finds_the_lock_taken_does_nothing(self) -> None:
        self.docker.publish("a")
        with open(self.root / "agent.lock", "w") as held:
            fcntl.flock(held, fcntl.LOCK_EX)
            self.assertEqual(self.tick(), 0)
        self.assertEqual(self.steps(), [])
        self.assertIn("tick_skipped", self.events())

    def test_an_unset_server_is_reported(self) -> None:
        (self.root / "server" / ".env").unlink()
        self.assertEqual(self.tick(), 2)
        self.assertIn("not_set_up", self.events())

    def test_old_releases_and_their_old_assets_are_pruned(self) -> None:
        releases = []
        for name in "abcdefgh":
            releases.append(self.deployed(name))
            self.clock += 10 * DAY
        kept = {path.name for path in (self.root / "releases").iterdir()}
        self.assertEqual(kept, {release.id for release in releases[-agent.KEEP_RELEASES :]})
        # Assets older than 30 days go once no kept release has them; the others stay.
        assets = {path.name for path in (self.web / "assets").iterdir()}
        self.assertNotIn("index-a.js", assets)
        self.assertIn("index-h.js", assets)
        self.assertFalse((self.web / "releases" / releases[0].id).exists())

    def test_an_old_asset_of_a_kept_release_stays(self) -> None:
        self.deployed("a", assets=("shared.js",))
        self.clock += 40 * DAY
        self.deployed("b", assets=("other.js",))
        self.assertTrue((self.web / "assets" / "shared.js").is_file())

    # the command line and the docker CLI

    def test_status_prints_the_releases(self) -> None:
        release = self.deployed("a")
        with contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(
                agent.main(["--root", str(self.root), "status"], docker=self.docker), 0
            )
        status = json.loads(output.getvalue())
        self.assertEqual(status["current"], release.digest)
        self.assertEqual(status["current_version"], "a")
        self.assertEqual(status["backend"], release.backend)

    def test_compose_passes_its_arguments_through(self) -> None:
        self.deployed("a")
        self.assertEqual(
            agent.main(["--root", str(self.root), "compose", "--", "ps"], docker=self.docker), 0
        )
        self.assertEqual(self.docker.calls[-1].args, ("ps",))


class DockerCliTest(unittest.TestCase):
    def run_with(self, stdout: str) -> Any:
        """Patches subprocess.run of the agent to succeed with `stdout`."""
        done = subprocess.CompletedProcess(args=[], returncode=0, stdout=stdout, stderr="")
        return mock.patch.object(agent.subprocess, "run", return_value=done)

    def test_resolve_reads_the_digest_of_the_manifest(self) -> None:
        manifest = json.dumps(
            {"mediaType": "application/vnd.oci.image.index.v1+json", "digest": "sha256:abc"}
        )
        with self.run_with(manifest) as run:
            self.assertEqual(agent.DockerCli().resolve(STAGE), "sha256:abc")
        self.assertEqual(run.call_args.args[0][:4], ["docker", "buildx", "imagetools", "inspect"])

    def test_a_failing_docker_is_a_docker_error(self) -> None:
        error = subprocess.CalledProcessError(1, ["docker"], stderr="unauthorized")
        with (
            mock.patch.object(agent.subprocess, "run", side_effect=error),
            self.assertRaisesRegex(agent.DockerError, "unauthorized"),
        ):
            agent.DockerCli().resolve(STAGE)

    def test_compose_runs_in_the_project_with_both_env_files(self) -> None:
        project = Path("/srv/debatemeet/server")
        with self.run_with("") as run:
            agent.DockerCli().compose(project, [project / ".env", project / "release.env"], ["ps"])
        self.assertEqual(
            run.call_args.args[0],
            ["docker", "compose", "--project-directory", str(project),
             "--env-file", str(project / ".env"), "--env-file", str(project / "release.env"), "ps"],
        )  # fmt: skip


if __name__ == "__main__":
    unittest.main()
