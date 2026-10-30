"""Reject artifacts that cannot establish the intended deployment identity and contents."""

import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from artifact import verify


class ArtifactVerificationTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        self.commit = "a" * 40
        self.state = {"id": "sha256:expected", "layers": [], "labels": {}}
        manifest = {
            "commit": self.commit,
            "version": "test-version",
            "images": {"debatemeet-backend:test": self.state},
        }
        (self.directory / "manifest.json").write_text(json.dumps(manifest))
        (self.directory / "images.tar").write_bytes(b"image archive")
        checksums = "".join(
            f"{hashlib.sha256(p.read_bytes()).hexdigest()}  {p.name}\n"
            for p in sorted(self.directory.iterdir())
        )
        (self.directory / "SHA256SUMS").write_text(checksums)

    def test_valid_files_do_not_need_docker_before_loading(self) -> None:
        verify(self.directory, self.commit, loaded=False)

    def test_other_successful_commits_are_not_substitutes(self) -> None:
        with self.assertRaisesRegex(ValueError, "different git commit"):
            verify(self.directory, "b" * 40, loaded=False)

    def test_corrupt_image_archive_is_rejected_before_loading(self) -> None:
        (self.directory / "images.tar").write_bytes(b"changed archive")
        with self.assertRaisesRegex(ValueError, "SHA256SUMS"):
            verify(self.directory, self.commit, loaded=False)

    def test_unlisted_file_is_rejected(self) -> None:
        (self.directory / "extra.txt").write_text("unexpected")
        with self.assertRaisesRegex(ValueError, "SHA256SUMS"):
            verify(self.directory, self.commit, loaded=False)

    def test_environment_file_cannot_be_included(self) -> None:
        (self.directory / ".env").write_text("secret")
        with self.assertRaisesRegex(ValueError, "environment files"):
            verify(self.directory, self.commit, loaded=False)

    def test_symbolic_links_cannot_leave_the_artifact(self) -> None:
        (self.directory / "escape").symlink_to("/etc/passwd")
        with self.assertRaisesRegex(ValueError, "symbolic link"):
            verify(self.directory, self.commit, loaded=False)

    def test_loaded_image_must_match_the_checked_archive(self) -> None:
        with (
            patch("artifact.image_state", return_value={"id": "another image"}),
            self.assertRaisesRegex(ValueError, "loaded image differs"),
        ):
            verify(self.directory, self.commit, loaded=True)


if __name__ == "__main__":
    unittest.main()
