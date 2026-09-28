"""Run: python3 -m unittest discover -s tools/git"""

from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

HOOK = Path(__file__).resolve().parents[2] / ".claude" / "hooks" / "git-guard.py"
spec = importlib.util.spec_from_file_location("git_guard", HOOK)
assert spec and spec.loader
git_guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(git_guard)

REPOSITORY = "owner/repo"
GREEN = {"name": "ci-ok", "status": "COMPLETED", "conclusion": "SUCCESS",
         "startedAt": "2026-09-28T12:54:14Z"}  # fmt: skip


def pr(**changes: object) -> dict[str, object]:
    """gh pr view facts of a PR that Claude may merge, with the given changes."""
    facts: dict[str, object] = {
        "url": "https://github.com/Owner/Repo/pull/12",
        "author": {"login": "owner", "is_bot": False},
        "baseRefName": "main",
        "changedFiles": 1,
        "files": [{"path": "backend/src/debatemeet/main.py"}],
        "statusCheckRollup": [{"name": "Backend", "status": "COMPLETED"}, GREEN],
    }
    facts.update(changes)
    return facts


def make_repo(root: str, branch: str, upstream: str | None = None) -> str:
    path = Path(root, branch.replace("/", "-"))
    path.mkdir()
    subprocess.run(["git", "init", "-q", str(path)], check=True)
    subprocess.run(["git", "-C", str(path), "symbolic-ref", "HEAD", f"refs/heads/{branch}"], check=True)
    if upstream:
        subprocess.run(
            ["git", "-C", str(path), "config", f"branch.{branch}.merge", f"refs/heads/{upstream}"],
            check=True,
        )
    return str(path)


class GitGuardTest(unittest.TestCase):
    tmp: tempfile.TemporaryDirectory[str]

    @classmethod
    def setUpClass(cls) -> None:
        cls.tmp = tempfile.TemporaryDirectory()
        cls.on_feature = make_repo(cls.tmp.name, "chore/ci")
        cls.on_main = make_repo(cls.tmp.name, "main")
        cls.tracks_main = make_repo(cls.tmp.name, "feat/x", upstream="main")
        cls.body_file = Path(cls.tmp.name, "body.md")
        cls.body_file.write_text("Adds CI.\n\nCo-Authored-By: someone\n", encoding="utf-8")

    @classmethod
    def tearDownClass(cls) -> None:
        cls.tmp.cleanup()

    def assert_allowed(self, command: str, cwd: str | None = None) -> None:
        try:
            git_guard.Guard(command, cwd or self.on_feature).run()
        except git_guard.Blocked as blocked:
            self.fail(f"blocked {command!r}: {blocked}")

    def assert_blocked(self, command: str, cwd: str | None = None) -> None:
        with self.assertRaises(git_guard.Blocked, msg=command):
            git_guard.Guard(command, cwd or self.on_feature).run()

    def test_allows_everyday_commands(self) -> None:
        for command in (
            "git status && git diff --stat",
            "git add backend/src/debatemeet/main.py docs/architecture.md",
            'git commit -m "feat: add health endpoint"',
            "git commit -m \"fix: handle -n and -a flags\" -- backend/app.py",
            "git commit -F /tmp/message.txt",
            "git push -u origin chore/ci",
            "git push origin HEAD",
            "git push",
            "git -C . push origin chore/ci:chore/ci",
            "git push origin main:chore/ci",
            "git config --get core.hooksPath",
            "git config get core.hooksPath",
            "git merge main",
            "gh pr create --title 'chore: add ci' --body 'Adds CI.'",
            "gh pr edit 12 --body-file /nonexistent/body.md",
            "gh pr view 12 && gh pr checks 12",
            "gh api repos/actions/checkout/releases/latest --jq .tag_name",
            "gh api -X GET repos/o/r/pulls -f state=open",
            "gh api graphql -f query='query { viewer { login } }'",
            "gh run view 123 --log-failed",
            "grep -rn 'git push origin main' docs",
            "echo 'gh pr merge' > notes.txt",
        ):
            with self.subTest(command=command):
                self.assert_allowed(command)

    def test_blocks_pushes_to_main(self) -> None:
        for command in (
            "git push origin main",
            "git push origin HEAD:main",
            "git push origin feat:refs/heads/main",
            "git push origin master",
            "cd /tmp && git push origin main",
            "bash -c 'git push origin main'",
            "FOO=1 git push origin main",
            "echo $(git push origin main)",
        ):
            with self.subTest(command=command):
                self.assert_blocked(command)

    def test_bare_push_depends_on_the_current_branch(self) -> None:
        self.assert_allowed("git push", cwd=self.on_feature)
        self.assert_blocked("git push", cwd=self.on_main)
        self.assert_blocked("git push -u origin", cwd=self.on_main)
        self.assert_blocked("git push origin HEAD", cwd=self.on_main)
        self.assert_blocked("git push", cwd=self.tracks_main)
        self.assert_blocked(f"cd {self.on_main} && git push")
        self.assert_blocked(f"git -C {self.on_main} push")

    def test_blocks_history_rewrites_and_hook_bypasses(self) -> None:
        for command in (
            "git push --force origin chore/ci",
            "git push -f origin chore/ci",
            "git push --force-with-lease origin chore/ci",
            "git push origin +chore/ci",
            "git push origin --delete chore/ci",
            "git push origin :chore/ci",
            "git push --tags",
            "git push origin refs/tags/v1",
            "git push --no-verify origin chore/ci",
            "git commit --amend --no-edit",
            "git commit --no-verify -m 'feat: x'",
            "git commit -nm 'feat: x'",
            "git commit -am 'feat: x'",
            "git commit --all -m 'feat: x'",
            "git -c core.hooksPath=/dev/null commit -m 'feat: x'",
            "git config core.hooksPath .githooks",
            "git config --unset core.hooksPath",
        ):
            with self.subTest(command=command):
                self.assert_blocked(command)

    def test_blocks_bulk_and_forced_staging(self) -> None:
        for command in (
            "git add .",
            "git add -A",
            "git add --all",
            "git add -u",
            "git add :/",
            "git add -f backend/.env",
            "git add -Av",
        ):
            with self.subTest(command=command):
                self.assert_blocked(command)

    def test_blocks_author_only_gh_operations(self) -> None:
        for command in (
            "gh release create v1",
            "gh repo edit --visibility private",
            "gh repo delete",
            "gh workflow run ci.yml",
            "gh run rerun 123",
            "gh secret set TOKEN",
            "gh api -X PUT repos/o/r/pulls/1/merge",
            "gh api repos/o/r/issues -f title=x",
            "gh api --method=DELETE repos/o/r/git/refs/heads/x",
            "gh api graphql -f query='mutation { mergePullRequest }'",
        ):
            with self.subTest(command=command):
                self.assert_blocked(command)

    def test_merges_only_as_a_squash_of_one_pr(self) -> None:
        facts = mock.patch.object(git_guard, "pr_facts", return_value=pr())
        origin = mock.patch.object(git_guard, "origin_slug", return_value=REPOSITORY)
        with facts, origin:
            for command in (
                "gh pr merge 12 --squash",
                "gh pr merge 12 -s --body ''",
                "gh pr merge --squash 12 --subject 'chore: land slice 0a (#12)'",
                "gh pr merge 12 --squash --match-head-commit 3d3c42e5",
            ):
                with self.subTest(command=command):
                    self.assert_allowed(command)
            for command in (
                "gh pr merge 12",
                "gh pr merge 12 --merge",
                "gh pr merge 12 -m",
                "gh pr merge 12 --rebase",
                "gh pr merge 12 -sd",
                "gh pr merge 12 --squash --delete-branch",
                "gh pr merge 12 --squash --admin",
                "gh pr merge 12 --squash --auto",
                "gh pr merge 12 --squash -R other/repo",
                "gh pr merge --squash",
                "gh pr merge feat/x --squash",
                "gh pr merge 12 13 --squash",
                "gh pr merge 12 --squash --subject 'Land slice 0a'",
                "gh pr merge 12 --squash --body '🤖 Generated with Claude Code'",
                f"gh pr merge 12 --squash --body-file {self.body_file}",
                "bash -c 'gh pr merge 12 --admin --squash'",
            ):
                with self.subTest(command=command):
                    self.assert_blocked(command)

    def test_merge_asks_github_for_the_policy(self) -> None:
        with mock.patch.object(git_guard, "origin_slug", return_value=REPOSITORY):
            with mock.patch.object(git_guard, "pr_facts", return_value=pr(baseRefName="feat/x")):
                self.assert_blocked("gh pr merge 12 --squash")
            with mock.patch.object(git_guard, "pr_facts", return_value=None):
                self.assert_blocked("gh pr merge 12 --squash")

    def test_blocks_attribution_and_bad_pr_titles(self) -> None:
        for command in (
            'git commit -m "feat: x" -m "Co-Authored-By: someone"',
            "gh pr create --title 'chore: add ci' --body '🤖 Generated with Claude Code'",
            f"gh pr create --title 'chore: add ci' --body-file {self.body_file}",
            "gh pr create --title 'Add CI' --body x",
            "gh pr edit 12 --title='chore: Add ci.'",
            "gh pr create --title 'chore: add ci' --body-file - <<'EOF'\nCo-authored-by: x\nEOF",
        ):
            with self.subTest(command=command):
                self.assert_blocked(command)

    def test_heredoc_bodies_are_not_commands(self) -> None:
        self.assert_allowed(
            "cat > /tmp/notes.md <<'EOF'\ngit push origin main\ngh pr merge 1\nEOF\ngit status"
        )
        self.assert_blocked("cat <<EOF\nnotes\nEOF\ngit push origin main")

    def test_hook_protocol(self) -> None:
        def run(command: str) -> subprocess.CompletedProcess[str]:
            payload = json.dumps({"tool_input": {"command": command}, "cwd": self.on_feature})
            return subprocess.run(
                [sys.executable, str(HOOK)], input=payload, capture_output=True, text=True
            )

        allowed = run("git status")
        self.assertEqual(allowed.returncode, 0, allowed.stderr)
        blocked = run("git push origin main")
        self.assertEqual(blocked.returncode, 2)
        self.assertIn("BLOCKED", blocked.stderr)


class MergePolicyTest(unittest.TestCase):
    def test_allows_a_green_pr_of_a_person_into_main(self) -> None:
        self.assertIsNone(git_guard.merge_refusal(pr(), REPOSITORY))

    def test_only_the_latest_ci_ok_counts(self) -> None:
        cancelled = {**GREEN, "conclusion": "FAILURE", "startedAt": "2026-09-28T12:53:08Z"}
        failed = {**GREEN, "conclusion": "FAILURE", "startedAt": "2026-09-28T12:55:00Z"}
        running = {**GREEN, "status": "IN_PROGRESS", "conclusion": "",
                   "startedAt": "2026-09-28T12:55:00Z"}  # fmt: skip
        refusal = git_guard.merge_refusal
        self.assertIsNone(refusal(pr(statusCheckRollup=[cancelled, GREEN]), REPOSITORY))
        self.assertIsNotNone(refusal(pr(statusCheckRollup=[GREEN, failed]), REPOSITORY))
        self.assertIsNotNone(refusal(pr(statusCheckRollup=[GREEN, running]), REPOSITORY))

    def test_refuses_what_the_author_merges(self) -> None:
        for label, facts, repository in (
            ("another repository", pr(url="https://github.com/other/repo/pull/12"), REPOSITORY),
            ("unknown origin", pr(), None),
            ("dependabot", pr(author={"login": "app/dependabot", "is_bot": True}), REPOSITORY),
            ("stacked", pr(baseRefName="feat/x"), REPOSITORY),
            ("hook", pr(files=[{"path": ".claude/hooks/git-guard.py"}]), REPOSITORY),
            ("settings", pr(files=[{"path": ".claude/settings.json"}]), REPOSITORY),
            ("message policy", pr(files=[{"path": "tools/git/check_message.py"}]), REPOSITORY),
            ("lefthook", pr(files=[{"path": "lefthook.yml"}]), REPOSITORY),
            ("unlisted files", pr(changedFiles=101), REPOSITORY),
            ("no ci-ok", pr(statusCheckRollup=[]), REPOSITORY),
        ):
            with self.subTest(label):
                self.assertIsNotNone(git_guard.merge_refusal(facts, repository))

    def test_repo_slug(self) -> None:
        for url in (
            "https://github.com/Owner/Repo.git",
            "git@github.com:Owner/Repo.git",
            "ssh://git@github.com/Owner/Repo",
            "https://github.com/Owner/Repo/pull/12",
        ):
            with self.subTest(url=url):
                self.assertEqual(git_guard.repo_slug(url), REPOSITORY)


if __name__ == "__main__":
    unittest.main()
