"""Export checked CI images; verify the exact artifact before an offline trial deployment."""

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
from pathlib import Path
from typing import Any


def run(*args: str, env: dict[str, str] | None = None) -> str:
    return subprocess.check_output(args, text=True, env=env, timeout=600).strip()


def image_state(ref: str) -> dict[str, Any]:
    info = json.loads(run("docker", "image", "inspect", ref))[0]
    if (info["Os"], info["Architecture"]) != ("linux", "amd64"):
        raise ValueError(f"not a Linux/amd64 image: {ref}")
    return {
        "platform": "linux/amd64",
        "rootfs": info["RootFS"],
        "config": info["Config"],
    }


def export_files(image: str, source: str, target: Path) -> None:
    container = run("docker", "create", image, "none")
    try:
        target.mkdir()
        run("docker", "cp", f"{container}:{source}/.", str(target))
    finally:
        run("docker", "rm", container)


def files(directory: Path) -> list[Path]:
    result = []
    for path in sorted(directory.rglob("*")):
        if path.is_symlink():
            raise ValueError(f"unexpected symbolic link: {path}")
        if path.is_file() and path.name != "SHA256SUMS":
            if path.name.startswith(".env"):
                raise ValueError("environment files do not belong in the artifact")
            result.append(path)
    return result


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def build(directory: Path) -> None:
    commit = run("git", "rev-parse", "HEAD")
    if run("git", "status", "--porcelain"):
        raise ValueError("cannot package an uncommitted working tree")
    version = run("sh", "tools/app-version.sh")
    directory.mkdir(parents=True)
    export_files("debatemeet-bundle:ci", "/bundle", directory / "server")
    export_files("debatemeet-web:ci", "/web", directory / "web")
    shutil.copyfile(
        "deploy/trial/compose.yaml", directory / "server/compose.trial.yaml"
    )
    shutil.copyfile(__file__, directory / "artifact.py")
    # Compose is the existing source of truth for infrastructure digests.
    env = dict(os.environ)
    env.update(
        DM_REGISTRY="trial",
        DM_BACKEND_IMAGE="debatemeet-backend:ci",
        DM_POSTGRES_PASSWORD="validation-only",
        DM_LIVEKIT_API_KEY="validation-only",
        DM_LIVEKIT_API_SECRET="validation-only-secret-of-the-trial-package",
    )
    config = json.loads(
        run(
            "docker",
            "compose",
            "--env-file",
            str(directory / "server/env.example"),
            "-f",
            str(directory / "server/compose.yaml"),
            "config",
            "--format",
            "json",
            env=env,
        )
    )
    sources = {name: f"debatemeet-{name}:ci" for name in ("backend", "web", "bundle")}
    for name, repository in (
        ("postgres", "postgres"),
        ("livekit", "livekit/livekit-server"),
        ("caddy", "livekit/caddyl4"),
    ):
        digest = config["services"][name]["image"].split("@", 1)[1]
        if not re.fullmatch(r"sha256:[0-9a-f]{64}", digest):
            raise ValueError(f"invalid pinned infrastructure digest: {name}")
        sources[name] = f"{repository}@{digest}"
        run("docker", "pull", "--platform", "linux/amd64", sources[name])
    images = {}
    for name, source in sources.items():
        ref = f"debatemeet-{name}:{commit}"
        run("docker", "tag", source, ref)
        state = image_state(ref)
        if (
            name in ("backend", "web", "bundle")
            and state["config"]["Labels"]["org.opencontainers.image.version"] != version
        ):
            raise ValueError(f"image version differs from the checkout: {name}")
        images[ref] = state
    run("docker", "save", "--output", str(directory / "images.tar"), *images)
    (directory / "server/release.env").write_text(
        f"DM_RELEASE_COMMIT={commit}\nDM_BACKEND_IMAGE=debatemeet-backend:{commit}\n"
        "DM_REGISTRY=debatemeet-trial\n",
        encoding="utf-8",
    )
    manifest = {
        "commit": commit,
        "version": version,
        "run_id": os.getenv("GITHUB_RUN_ID"),
        "images": images,
    }
    (directory / "manifest.json").write_text(
        json.dumps(manifest, indent=2) + "\n", encoding="utf-8"
    )
    checksums = "".join(
        f"{sha256(p)}  {p.relative_to(directory).as_posix()}\n"
        for p in files(directory)
    )
    (directory / "SHA256SUMS").write_text(checksums, encoding="utf-8")
    verify(directory, commit, loaded=True)


def verify(directory: Path, commit: str, *, loaded: bool) -> None:
    if not re.fullmatch(r"[0-9a-f]{40}", commit):
        raise ValueError("expected a full git commit SHA")
    expected = {}
    for line in (directory / "SHA256SUMS").read_text(encoding="utf-8").splitlines():
        checksum, name = line.split("  ", 1)
        path = Path(name)
        if path.is_absolute() or ".." in path.parts or name in expected:
            raise ValueError("invalid checksum entry")
        expected[name] = checksum
    actual = {p.relative_to(directory).as_posix(): sha256(p) for p in files(directory)}
    if actual != expected:
        raise ValueError("artifact files differ from SHA256SUMS")
    manifest = json.loads((directory / "manifest.json").read_text(encoding="utf-8"))
    if manifest["commit"] != commit:
        raise ValueError("artifact belongs to a different git commit")
    if loaded:
        for ref, state in manifest["images"].items():
            if image_state(ref) != state:
                raise ValueError(f"loaded image differs from the artifact: {ref}")
    print(f"Verified trial artifact: {commit}, version {manifest['version']}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("build").add_argument("directory", type=Path)
    check = commands.add_parser("verify")
    check.add_argument("directory", type=Path)
    check.add_argument("commit")
    check.add_argument("--loaded", action="store_true")
    args = parser.parse_args()
    if args.command == "build":
        build(args.directory)
    else:
        verify(args.directory, args.commit, loaded=args.loaded)


if __name__ == "__main__":
    main()
