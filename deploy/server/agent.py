#!/usr/bin/env python3
"""The thin deploy agent of the stand (docs/architecture.md, sections 10 and 11).

A systemd timer runs `agent.py tick` every minute. Under a lock, it takes the release the `stage`
tag points at, rolls it out and remembers the result; a release that fails is rolled back and never
retried.

A release is one digest: that of the bundle image. The bundle holds this file, compose.yaml and the
configs of Caddy and LiveKit; its labels pin the backend and web images by digest, so one tag moves
the whole release at once. The thin agent leaves out what the full one adds: the check that media
rooms are empty, the update mode, the dump before migrations, smoke checks and annotations. So it
may restart LiveKit or reload Caddy in the middle of a round.

Layout under the root, /srv/debatemeet:
    server/          the compose project: bundle files of the current release, the operator's .env
                     and release.env, where this agent writes the backend image
    web/             DM_WEB_ROOT of .env: assets/, releases/<id>/index.html and current,
                     a symlink to releases/<id> of the current release
    releases/<id>/   bundle, web files and release.json of recent releases, for rollbacks
    state.json       the current and previous release and the releases that failed
    agent.lock

Commands: tick, status, compose ARGS (docker compose with the env files of the release).
Exit codes: 0 done or nothing to do, 1 the tick failed, 2 the server is not set up.
Stdlib only, Python 3.9+: it runs on the system interpreter of the server.
"""

from __future__ import annotations

import argparse
import contextlib
import fcntl
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from collections.abc import Iterator, Sequence
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Callable, Protocol

DEFAULT_ROOT = Path("/srv/debatemeet")
STAGE_TAG = "stage"
BACKEND_LABEL = "debatemeet.backend-image"
WEB_LABEL = "debatemeet.web-image"
VERSION_LABEL = "org.opencontainers.image.version"
# Files of the bundle replaced as a whole. Directories are synced file by file and never replaced:
# containers mount them, and a mount keeps the directory it was created with.
BUNDLE_FILES = ("compose.yaml", "env.example", "agent.py")
BUNDLE_DIRS = ("caddy", "livekit", "systemd")
# Releases kept for rollbacks, besides the current and the previous one.
KEEP_RELEASES = 5
# Hashed assets outlive their release: a tab opened on it still loads its chunks.
ASSET_MAX_AGE_SECONDS = 30 * 24 * 3600
WAIT_TIMEOUT_SECONDS = 180
MIGRATE = ("python", "-m", "debatemeet.migrate")
# Every service up, and healthy where it has a health check: the backend answers /api/health.
UP_ALL = ("up", "-d", "--wait", "--wait-timeout", str(WAIT_TIMEOUT_SECONDS), "--remove-orphans")
# Caddy applies a new Caddyfile in place. Whether that keeps TURN/TLS connections is still a
# check for the stand (docs/architecture.md, section 6).
CADDY_RELOAD = ("caddy", "reload", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile")


class DockerError(Exception):
    """Docker or the registry did not answer: the tick fails, the release is not blamed."""


class ReleaseError(Exception):
    """The release itself is broken: it is marked failed and never tried again."""


def log(event: str, **fields: object) -> None:
    print(json.dumps({"event": event, **fields}, ensure_ascii=False), flush=True)


class Docker(Protocol):
    def resolve(self, ref: str) -> str:
        """The digest a tag points at in the registry."""

    def pull(self, ref: str) -> None: ...

    def labels(self, ref: str) -> dict[str, str]: ...

    def export(self, ref: str, source: str, destination: Path) -> None:
        """Copies the directory `source` of the image into `destination`."""

    def compose(self, project: Path, env_files: Sequence[Path], args: Sequence[str]) -> bool:
        """Runs docker compose in `project`; True when it succeeded."""


class DockerCli:
    """The docker CLI of the server, logged in to the registry with a read-only token."""

    def _run(self, *args: str) -> str:
        try:
            done = subprocess.run(
                ["docker", *args], capture_output=True, text=True, check=True, timeout=600
            )
        except (OSError, subprocess.SubprocessError) as error:
            stderr = getattr(error, "stderr", "") or ""
            raise DockerError(f"docker {' '.join(args[:2])}: {stderr.strip() or error}") from error
        return done.stdout

    def resolve(self, ref: str) -> str:
        manifest = self._run(
            "buildx", "imagetools", "inspect", ref, "--format", "{{json .Manifest}}"
        )
        try:
            digest = json.loads(manifest)["digest"]
        except (ValueError, KeyError, TypeError) as error:
            raise DockerError(f"no digest for {ref}: {manifest[:200]}") from error
        return str(digest)

    def pull(self, ref: str) -> None:
        self._run("pull", "--quiet", ref)

    def labels(self, ref: str) -> dict[str, str]:
        output = self._run("image", "inspect", "--format", "{{json .Config.Labels}}", ref)
        labels = json.loads(output) or {}
        return {str(key): str(value) for key, value in labels.items()}

    def export(self, ref: str, source: str, destination: Path) -> None:
        container = self._run("create", ref, "none").strip()
        try:
            self._run("cp", f"{container}:{source}/.", str(destination))
        finally:
            self._run("rm", container)

    def compose(self, project: Path, env_files: Sequence[Path], args: Sequence[str]) -> bool:
        command = ["docker", "compose", "--project-directory", str(project)]
        for env_file in env_files:
            command += ["--env-file", str(env_file)]
        # Its output goes straight to the journal, next to the agent's own lines.
        return subprocess.run([*command, *args], check=False).returncode == 0


@dataclass(frozen=True)
class Release:
    digest: str
    bundle: str
    backend: str
    web: str
    version: str

    @property
    def id(self) -> str:
        return release_id(self.digest)


def release_id(digest: str) -> str:
    return digest.split(":", 1)[-1][:12]


@dataclass
class State:
    current: str | None = None
    previous: str | None = None
    failed: list[str] = field(default_factory=list)

    @classmethod
    def load(cls, path: Path) -> State:
        if not path.exists():
            return cls()
        data = json.loads(path.read_text(encoding="utf-8"))
        return cls(data.get("current"), data.get("previous"), list(data.get("failed", [])))

    def save(self, path: Path) -> None:
        write_atomic(path, json.dumps(asdict(self), indent=2) + "\n")


def write_atomic(path: Path, content: str | bytes, mode: int = 0o644) -> None:
    """Writes a new file next to `path` and renames it over: readers see the old or the new one.
    The mode is explicit: mkstemp makes files only its owner can read, and Caddy reads these."""
    path.parent.mkdir(parents=True, exist_ok=True)
    data = content.encode("utf-8") if isinstance(content, str) else content
    fd, temporary = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.")
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
        os.chmod(temporary, mode)
        os.replace(temporary, path)
    except BaseException:
        with contextlib.suppress(FileNotFoundError):
            os.unlink(temporary)
        raise


def sync_dir(source: Path, destination: Path) -> bool:
    """Makes `destination` hold what `source` holds, file by file; True when anything changed."""
    destination.mkdir(parents=True, exist_ok=True)
    changed = False
    wanted = {path.relative_to(source) for path in source.rglob("*") if path.is_file()}
    for relative in sorted(wanted):
        data = (source / relative).read_bytes()
        mode = (source / relative).stat().st_mode & 0o777
        target = destination / relative
        if not target.is_file() or target.read_bytes() != data:
            write_atomic(target, data, mode)
            changed = True
    for path in sorted(destination.rglob("*"), reverse=True):
        if path.is_file() and path.relative_to(destination) not in wanted:
            path.unlink()
            changed = True
    return changed


def read_env(path: Path) -> dict[str, str]:
    """The KEY=VALUE lines of an env file, as compose reads the simple ones."""
    values = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
            value = value[1:-1]
        values[key.strip()] = value
    return values


class Agent:
    def __init__(self, root: Path, docker: Docker, now: Callable[[], float] = time.time) -> None:
        self.root = root
        self.docker = docker
        self.now = now
        self.server = root / "server"
        self.releases = root / "releases"
        self.state_path = root / "state.json"

    # tick

    def tick(self) -> int:
        with self._lock() as locked:
            if not locked:
                log("tick_skipped", reason="another tick holds the lock")
                return 0
            env_path = self.server / ".env"
            if not env_path.is_file():
                log("not_set_up", missing=str(env_path))
                return 2
            settings = read_env(env_path)
            registry = settings.get("DM_REGISTRY", "")
            if not registry:
                log("not_set_up", missing="DM_REGISTRY in .env")
                return 2
            web_root = Path(settings.get("DM_WEB_ROOT") or self.root / "web")
            state = State.load(self.state_path)
            try:
                digest = self.docker.resolve(f"{registry}/bundle:{STAGE_TAG}")
            except DockerError as error:
                log("registry_unreachable", error=str(error))
                return 1
            # Both are quiet: the timer asks every minute, and a failure was reported once.
            if digest == state.current or digest in state.failed:
                return 0
            try:
                release = self._fetch(registry, digest)
            except DockerError as error:
                log("release_fetch_failed", release=release_id(digest), error=str(error))
                return 1
            except ReleaseError as error:
                self._mark_failed(state, digest, str(error))
                return 1
            return 0 if self._roll_out(release, state, web_root) else 1

    @contextlib.contextmanager
    def _lock(self) -> Iterator[bool]:
        self.root.mkdir(parents=True, exist_ok=True)
        with open(self.root / "agent.lock", "w") as handle:
            try:
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                yield False
                return
            try:
                yield True
            finally:
                fcntl.flock(handle, fcntl.LOCK_UN)

    def _fetch(self, registry: str, digest: str) -> Release:
        """Pulls the images of the release and unpacks the bundle and the web files."""
        bundle = f"{registry}/bundle@{digest}"
        self.docker.pull(bundle)
        labels = self.docker.labels(bundle)
        missing = [label for label in (BACKEND_LABEL, WEB_LABEL) if not labels.get(label)]
        if missing:
            raise ReleaseError(f"the bundle has no {', '.join(missing)} label")
        release = Release(
            digest, bundle, labels[BACKEND_LABEL], labels[WEB_LABEL], labels.get(VERSION_LABEL, "")
        )
        directory = self.releases / release.id
        for name, ref, source in (("bundle", bundle, "/bundle"), ("web", release.web, "/web")):
            if not (directory / name).is_dir():
                if ref != bundle:  # the bundle is here already: its labels were read
                    self.docker.pull(ref)
                incoming = directory / f".{name}.incoming"
                shutil.rmtree(incoming, ignore_errors=True)
                incoming.mkdir(parents=True)
                self.docker.export(ref, source, incoming)
                incoming.rename(directory / name)
        if not (directory / "bundle" / "compose.yaml").is_file():
            raise ReleaseError("the bundle has no compose.yaml")
        if not (directory / "web" / "index.html").is_file():
            raise ReleaseError("the web image has no index.html")
        self.docker.pull(release.backend)
        write_atomic(directory / "release.json", json.dumps(asdict(release), indent=2) + "\n")
        return release

    def _roll_out(self, release: Release, state: State, web_root: Path) -> bool:
        log("release_started", release=release.id, version=release.version)
        self._install_static(release, web_root)
        changed = self._install_bundle(release)
        if "systemd" in changed and state.current is not None:
            log("systemd_units_changed", hint="systemctl daemon-reload picks them up")
        applied: set[str] = set()
        step = "migrations"
        ok = self._compose("up", "-d", "--wait", "postgres") and self._compose(
            "run", "--rm", "--no-deps", "-T", "backend", *MIGRATE
        )
        if ok:
            step = "services"
            ok = self._compose(*UP_ALL)
        if ok and state.current is not None:
            # The first release starts every container with its files; later ones change them live.
            step = "configs"
            ok, applied = self._apply_configs(changed)
        if not ok:
            self._mark_failed(state, release.digest, f"{step} failed")
            self._roll_back(state, changed, applied)
            return False
        self._switch_static(release, web_root)
        state.previous, state.current = state.current, release.digest
        state.save(self.state_path)
        self._prune(state, web_root)
        log("release_done", release=release.id, version=release.version)
        return True

    def _install_static(self, release: Release, web_root: Path) -> None:
        """Adds the assets of the release to the shared folder and puts its index.html beside;
        the current release does not change yet."""
        staged = self.releases / release.id / "web"
        assets = web_root / "assets"
        now = self.now()
        for path in sorted((staged / "assets").rglob("*")):
            if path.is_file():
                target = assets / path.relative_to(staged / "assets")
                if not target.is_file():
                    write_atomic(target, path.read_bytes())
                os.utime(target, (now, now))
        for path in staged.iterdir():
            if path.name != "assets" and path.is_file():
                write_atomic(web_root / "releases" / release.id / path.name, path.read_bytes())

    def _switch_static(self, release: Release, web_root: Path) -> None:
        # Caddy serves current/: renaming a new symlink over it switches every request at once.
        incoming = web_root / ".current.incoming"
        with contextlib.suppress(FileNotFoundError):
            incoming.unlink()
        os.symlink(Path("releases") / release.id, incoming)
        os.replace(incoming, web_root / "current")

    def _install_bundle(self, release: Release) -> set[str]:
        """Puts the files of the release into server/; returns the mounted dirs that changed."""
        source = self.releases / release.id / "bundle"
        for name in BUNDLE_FILES:
            if (source / name).is_file():
                mode = (source / name).stat().st_mode & 0o777
                write_atomic(self.server / name, (source / name).read_bytes(), mode)
        changed = {name for name in BUNDLE_DIRS if sync_dir(source / name, self.server / name)}
        write_atomic(
            self.server / "release.env",
            "# Written by agent.py: the release that compose.yaml runs.\n"
            f"DM_RELEASE={release.digest}\nDM_BACKEND_IMAGE={release.backend}\n",
        )
        return changed

    def _apply_configs(self, changed: set[str]) -> tuple[bool, set[str]]:
        """Reloads Caddy and restarts LiveKit when their mounted files changed."""
        applied: set[str] = set()
        if "caddy" in changed:
            applied.add("caddy")
            if not self._compose("exec", "-T", "caddy", *CADDY_RELOAD):
                return False, applied
        if "livekit" in changed:
            applied.add("livekit")
            if not self._compose("restart", "livekit"):
                return False, applied
        return True, applied

    def _roll_back(self, state: State, changed: set[str], applied: set[str]) -> None:
        """Puts the previous release back: its files, its backend image, its Caddy and LiveKit."""
        if state.current is None:
            log("rollback_impossible", reason="no release ran here before")
            return
        previous = self._load_release(state.current)
        if previous is None:
            log("rollback_impossible", reason=f"release {release_id(state.current)} is gone")
            return
        self._install_bundle(previous)
        ok = self._compose(*UP_ALL)
        # Only what the failed release had changed live needs to change back.
        if ok and applied:
            ok, _ = self._apply_configs(applied & changed)
        log("rollback_done" if ok else "rollback_failed", release=previous.id)

    def _mark_failed(self, state: State, digest: str, reason: str) -> None:
        if digest not in state.failed:
            state.failed.append(digest)
        state.save(self.state_path)
        log("release_failed", release=release_id(digest), reason=reason)

    def _load_release(self, digest: str) -> Release | None:
        path = self.releases / release_id(digest) / "release.json"
        if not path.is_file():
            return None
        return Release(**json.loads(path.read_text(encoding="utf-8")))

    def _prune(self, state: State, web_root: Path) -> None:
        """Drops old releases, and assets that are old and belong to no kept release."""
        pinned = {release_id(d) for d in (state.current, state.previous) if d is not None}
        by_age = sorted(
            (path for path in self.releases.iterdir() if path.is_dir()),
            key=lambda path: path.stat().st_mtime,
            reverse=True,
        )
        kept = pinned | {path.name for path in by_age[:KEEP_RELEASES]}
        for path in by_age:
            if path.name not in kept:
                shutil.rmtree(path)
                shutil.rmtree(web_root / "releases" / path.name, ignore_errors=True)
        in_use = set()
        for name in kept:
            staged = self.releases / name / "web" / "assets"
            if staged.is_dir():
                in_use |= {p.relative_to(staged) for p in staged.rglob("*") if p.is_file()}
        assets = web_root / "assets"
        if assets.is_dir():
            cutoff = self.now() - ASSET_MAX_AGE_SECONDS
            for path in assets.rglob("*"):
                unused = path.is_file() and path.relative_to(assets) not in in_use
                if unused and path.stat().st_mtime < cutoff:
                    path.unlink()

    def _compose(self, *args: str) -> bool:
        env_files = [self.server / ".env", self.server / "release.env"]
        return self.docker.compose(self.server, env_files, args)

    # the other commands

    def status(self) -> int:
        state = State.load(self.state_path)
        current = self._load_release(state.current) if state.current else None
        print(
            json.dumps(
                {
                    "current": state.current,
                    "current_version": current.version if current else None,
                    "backend": current.backend if current else None,
                    "previous": state.previous,
                    "failed": state.failed,
                },
                indent=2,
            )
        )
        return 0

    def compose(self, args: Sequence[str]) -> int:
        if args and args[0] == "--":
            args = args[1:]
        return 0 if self._compose(*args) else 1


def main(argv: Sequence[str] | None = None, docker: Docker | None = None) -> int:
    parser = argparse.ArgumentParser(prog="agent.py", description="The deploy agent of the stand.")
    parser.add_argument(
        "--root", type=Path, default=Path(os.environ.get("DM_AGENT_ROOT") or DEFAULT_ROOT)
    )
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("tick", help="roll out the release of the stage tag, if it is new")
    commands.add_parser("status", help="print the current, previous and failed releases")
    compose = commands.add_parser(
        "compose", help="docker compose with the env files of the release"
    )
    compose.add_argument("args", nargs=argparse.REMAINDER)
    options = parser.parse_args(argv)
    agent = Agent(options.root, docker or DockerCli())
    if options.command == "tick":
        return agent.tick()
    if options.command == "status":
        return agent.status()
    return agent.compose(options.args)


if __name__ == "__main__":
    sys.exit(main())
