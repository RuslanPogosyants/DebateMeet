#!/usr/bin/env python3
"""Claude Code PreToolUse hook for Bash: blocks the git and gh operations that
CLAUDE.md ("Git and PRs") reserves for the author.

Allowed: commits, pushes of feature branches, opening and updating PRs, reads.
Blocked: push to main, force-push, remote deletes and tag pushes, --no-verify,
--amend, commit -a, hooksPath overrides, bulk or forced git add, gh pr merge,
releases, gh repo, manual workflow runs, gh api writes, secrets and variables,
attribution in commit and PR text, PR titles that break the commit format.

A guardrail against accidents, not a security boundary: commands are split with
shlex, heredoc bodies are skipped and command substitutions are not expanded.

Input: hook JSON on stdin (tool_input.command, cwd). Exit 2 blocks the call and
shows stderr to the agent. Stdlib only, Python 3.9+. Tests: tools/git/test_git_guard.py.
"""

from __future__ import annotations

import json
import os
import re
import shlex
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "tools" / "git"))
from check_message import check_message, find_attribution  # noqa: E402

PROTECTED_BRANCHES = ("main", "master")
SEPARATOR_CHARS = ";&|()<>\n"
WRAPPERS = ("env", "command", "exec", "time", "nohup", "sudo", "{", "}", "!", "then", "do", "else")
SHELLS = ("sh", "bash", "zsh")
ASSIGNMENT_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=")
SHORT_FLAGS_RE = re.compile(r"^-[A-Za-z]+$")
HEREDOC_RE = re.compile(r"(?<!<)<<(?!<)-?[ \t]*(['\"]?)([A-Za-z_][A-Za-z0-9_]*)\1")


class Blocked(Exception):
    pass


def strip_heredocs(text: str) -> str:
    """Drop heredoc bodies: their lines are data, not commands."""
    kept: list[str] = []
    pending: list[str] = []
    for line in text.split("\n"):
        if pending:
            if line.strip() == pending[0]:
                pending.pop(0)
            continue
        kept.append(line)
        pending = [m.group(2) for m in HEREDOC_RE.finditer(line)]
    return "\n".join(kept)


def split_commands(text: str) -> list[list[str]]:
    source = strip_heredocs(text)
    try:
        lexer = shlex.shlex(source, posix=True, punctuation_chars=SEPARATOR_CHARS)
        lexer.whitespace = " \t\r"
        lexer.whitespace_split = True
        lexer.commenters = ""
        tokens = list(lexer)
    except ValueError:  # unbalanced quotes: fall back to a rough split
        tokens = re.sub(r"[;&|()<>\n]+", " ; ", source).split()
    commands: list[list[str]] = [[]]
    for token in tokens:
        if token and all(ch in SEPARATOR_CHARS for ch in token):
            commands.append([])
        else:
            commands[-1].append(token)
    return [c for c in commands if c]


def git_output(cwd: str, *args: str) -> str | None:
    try:
        result = subprocess.run(
            ["git", "-C", cwd, *args], capture_output=True, text=True, timeout=5, check=False
        )
    except (OSError, subprocess.SubprocessError):
        return None
    return result.stdout.strip() if result.returncode == 0 and result.stdout.strip() else None


def current_branch(cwd: str) -> str | None:
    return git_output(cwd, "symbolic-ref", "--quiet", "--short", "HEAD")


def branch_name(ref: str) -> str:
    return ref[len("refs/heads/") :] if ref.startswith("refs/heads/") else ref


def bare_push_targets(cwd: str) -> list[str] | None:
    """Remote branches a push without refspecs may update, depending on push.default:
    the current branch and its upstream. None when HEAD is detached."""
    branch = current_branch(cwd)
    if branch is None:
        return None
    upstream = git_output(cwd, "config", "--get", f"branch.{branch}.merge")
    return [branch] + ([branch_name(upstream)] if upstream else [])


class Guard:
    def __init__(self, command: str, cwd: str) -> None:
        self.command = command
        self.cwd = cwd

    def run(self) -> None:
        for tokens in split_commands(self.command):
            self.check(tokens)

    def check(self, tokens: list[str]) -> None:
        i = 0
        while i < len(tokens) and (tokens[i] in WRAPPERS or ASSIGNMENT_RE.match(tokens[i])):
            i += 1
        if i >= len(tokens):
            return
        program = os.path.basename(tokens[i].lstrip("`"))
        args = tokens[i + 1 :]
        if program == "cd":
            target = os.path.expanduser(args[0] if args else "~")
            self.cwd = os.path.normpath(os.path.join(self.cwd, target))
        elif program in SHELLS and len(args) >= 2 and re.match(r"^-[a-z]*c$", args[0]):
            Guard(args[1], self.cwd).run()
        elif program == "git":
            self.check_git(args)
        elif program == "gh":
            self.check_gh(args)

    # git

    def check_git(self, args: list[str]) -> None:
        cwd = self.cwd
        i = 0
        while i < len(args) and args[i].startswith("-"):
            option = args[i]
            value = args[i + 1] if i + 1 < len(args) else ""
            if option == "-C":
                cwd = os.path.normpath(os.path.join(cwd, os.path.expanduser(value)))
                i += 2
                continue
            if option in ("-c", "--config-env"):
                self.check_config_override(value)
                i += 2
                continue
            if option.startswith(("-c", "--config-env=")):
                self.check_config_override(option)
            elif option in ("--git-dir", "--work-tree", "--namespace"):
                i += 1
            i += 1
        if i >= len(args):
            return
        subcommand, rest = args[i], args[i + 1 :]
        if subcommand == "commit":
            self.check_commit(rest)
        elif subcommand == "push":
            self.check_push(rest, cwd)
        elif subcommand in ("add", "stage"):
            self.check_add(rest)
        elif subcommand == "config":
            self.check_config(rest)

    @staticmethod
    def check_config_override(setting: str) -> None:
        if "hookspath" in setting.lower():
            raise Blocked("overriding core.hooksPath")

    @staticmethod
    def check_config(rest: list[str]) -> None:
        positional = [a for a in rest if not a.startswith("-")]
        keys = [p.lower() for p in positional]
        if "core.hookspath" not in keys or (keys and keys[0] in ("get", "list")):
            return
        writes = keys.index("core.hookspath") + 1 < len(keys) or keys[0] in ("set", "unset")
        if writes or any(a.startswith(("--unset", "--add", "--replace-all")) for a in rest):
            raise Blocked("changing core.hooksPath")

    def check_commit(self, rest: list[str]) -> None:
        takes_value = ("-m", "-F", "-C", "-c", "-t", "--message", "--file", "--author",
                       "--date", "--template", "--reuse-message", "--reedit-message",
                       "--fixup", "--squash", "--trailer", "--cleanup")  # fmt: skip
        skip_next = False
        message_file = None
        for i, arg in enumerate(rest):
            if skip_next:
                skip_next = False
                continue
            if arg == "--":
                break
            if arg in takes_value:
                if arg in ("-F", "--file") and i + 1 < len(rest):
                    message_file = rest[i + 1]
                skip_next = True
                continue
            name, _, value = arg.partition("=")
            if name == "--file":
                message_file = value
            if name == "--no-verify":
                raise Blocked("git commit --no-verify skips the commit-msg and pre-commit hooks")
            if name == "--amend":
                raise Blocked("git commit --amend rewrites history")
            if name == "--all":
                raise Blocked("git commit --all stages every change: add explicit paths")
            if SHORT_FLAGS_RE.match(arg):
                for flag in arg[1:]:
                    if flag == "n":
                        raise Blocked("git commit -n skips the commit-msg and pre-commit hooks")
                    if flag == "a":
                        raise Blocked("git commit -a stages every change: add explicit paths")
                    if flag in "mFCct":
                        break  # the rest of the cluster is the option value
        self.check_attribution(message_file)

    def check_push(self, rest: list[str], cwd: str) -> None:
        takes_value = ("-o", "--push-option", "--repo", "--receive-pack", "--exec")
        forbidden = {
            "--force": "force-push",
            "--force-with-lease": "force-push",
            "--force-if-includes": "force-push",
            "--mirror": "pushing every ref",
            "--all": "pushing every branch",
            "--branches": "pushing every branch",
            "--tags": "pushing tags: releases are the author's",
            "--follow-tags": "pushing tags: releases are the author's",
            "--delete": "deleting remote branches",
            "--prune": "deleting remote branches",
            "--no-verify": "skipping the pre-push hook",
        }
        positional: list[str] = []
        skip_next = False
        for arg in rest:
            if skip_next:
                skip_next = False
            elif arg in takes_value:
                skip_next = True
            elif arg.startswith("--"):
                reason = forbidden.get(arg.split("=", 1)[0])
                if reason:
                    raise Blocked(f"git push {arg}: {reason}")
            elif arg.startswith("-") and len(arg) > 1:
                if "f" in arg:
                    raise Blocked(f"git push {arg}: force-push")
                if "d" in arg:
                    raise Blocked(f"git push {arg}: deleting remote branches")
                skip_next = arg.endswith("o")
            else:
                positional.append(arg)
        refspecs = positional[1:]
        if not refspecs:
            targets = bare_push_targets(cwd)
            if targets is None:
                raise Blocked("git push from a detached HEAD: name the branch")
            for target in targets:
                if target in PROTECTED_BRANCHES:
                    raise Blocked(
                        f"git push without a refspec may update {target} (the current branch"
                        " or its upstream): push a named feature branch"
                    )
        for spec in refspecs:
            if spec.startswith("+"):
                raise Blocked(f"git push {spec}: force-push")
            source, _, destination = spec.partition(":")
            if not source:
                raise Blocked(f"git push {spec}: deleting remote branches")
            if "refs/tags/" in spec:
                raise Blocked(f"git push {spec}: pushing tags: releases are the author's")
            target = destination or source
            if target in ("HEAD", "@"):
                resolved = current_branch(cwd)
                if resolved is None:
                    raise Blocked("git push HEAD from a detached HEAD: name the branch")
                target = resolved
            self.check_push_target(branch_name(target))

    @staticmethod
    def check_push_target(branch: str) -> None:
        if branch in PROTECTED_BRANCHES:
            raise Blocked(f"pushing to {branch}: changes reach it only through a merged PR")

    @staticmethod
    def check_add(rest: list[str]) -> None:
        for arg in rest:
            if arg in (".", "./", ":/", ":.", "*", "-A", "--all", "-u", "--update",
                       "--no-ignore-removal"):  # fmt: skip
                raise Blocked(f"git add {arg}: add explicit paths")
            if arg in ("-f", "--force"):
                raise Blocked(f"git add {arg}: adds ignored files such as .env")
            if SHORT_FLAGS_RE.match(arg) and set(arg[1:]) & set("Auf"):
                raise Blocked(f"git add {arg}: add explicit paths")

    # gh

    def check_gh(self, args: list[str]) -> None:
        group = args[0] if args else ""
        action = args[1] if len(args) > 1 else ""
        if group == "pr":
            if action == "merge":
                raise Blocked("gh pr merge: the author merges PRs")
            if action in ("create", "edit", "comment", "review"):
                self.check_pr_text(args[2:])
        elif group == "release" and action not in ("list", "view", "download"):
            raise Blocked(f"gh release {action}: releases are the author's")
        elif group == "repo" and action not in ("view", "list", "clone"):
            raise Blocked(f"gh repo {action}: repository operations are the author's")
        elif group == "workflow" and action in ("run", "enable", "disable"):
            raise Blocked(f"gh workflow {action}: workflows are not run by hand")
        elif group == "run" and action in ("rerun", "delete"):
            raise Blocked(f"gh run {action}: workflows are not run by hand")
        elif group in ("secret", "variable") and action in ("set", "delete", "remove"):
            raise Blocked(f"gh {group} {action}: repository settings are the author's")
        elif group == "api":
            self.check_gh_api(args[1:])

    def check_pr_text(self, rest: list[str]) -> None:
        body_file = None
        for i, arg in enumerate(rest):
            value = rest[i + 1] if i + 1 < len(rest) else ""
            if arg in ("-t", "--title") or arg.startswith("--title="):
                title = arg.split("=", 1)[1] if "=" in arg else value
                reason = check_message(title, allow_merge=False)
                if reason:
                    raise Blocked(f"PR title: {reason} (the squash commit takes the title)")
            if arg in ("-F", "--body-file"):
                body_file = value
            elif arg.startswith("--body-file="):
                body_file = arg.split("=", 1)[1]
        self.check_attribution(body_file)

    def check_attribution(self, text_file: str | None) -> None:
        texts = [self.command]
        if text_file and text_file != "-":
            path = Path(self.cwd, os.path.expanduser(text_file))
            try:
                texts.append(path.read_text(encoding="utf-8"))
            except (OSError, UnicodeDecodeError):
                pass
        for text in texts:
            hit = find_attribution(text)
            if hit:
                raise Blocked(f"attribution is not allowed in commits and PRs: {hit!r}")

    @staticmethod
    def check_gh_api(rest: list[str]) -> None:
        method = None
        has_fields = False
        endpoint = None
        skip_next = False
        for i, arg in enumerate(rest):
            if skip_next:
                skip_next = False
                continue
            if arg in ("-X", "--method"):
                method = rest[i + 1].upper() if i + 1 < len(rest) else None
                skip_next = True
            elif arg.startswith("--method="):
                method = arg.split("=", 1)[1].upper()
            elif arg.startswith("-X") and len(arg) > 2:
                method = arg[2:].upper()
            elif arg in ("-f", "-F", "--field", "--raw-field", "--input"):
                has_fields = True
                skip_next = True
            elif arg.startswith(("--field=", "--raw-field=", "--input=")):
                has_fields = True
            elif arg in ("-H", "--header", "-q", "--jq", "-t", "--template", "--hostname",
                         "--cache", "-p", "--preview"):  # fmt: skip
                skip_next = True
            elif not arg.startswith("-") and endpoint is None:
                endpoint = arg
        if endpoint == "graphql":
            if any("mutation" in a.lower() for a in rest):
                raise Blocked("gh api graphql mutation: write calls go through the author")
            return
        effective = method or ("POST" if has_fields else "GET")
        if effective != "GET":
            raise Blocked(f"gh api {effective}: write calls go through the author")


def main() -> int:
    try:
        payload = json.load(sys.stdin)
    except ValueError:
        return 0
    command = (payload.get("tool_input") or {}).get("command") or ""
    cwd = payload.get("cwd") or os.getcwd()
    try:
        Guard(command, cwd).run()
    except Blocked as blocked:
        print(f"BLOCKED by .claude/hooks/git-guard.py: {blocked}.", file=sys.stderr)
        print("If the author should do it, give them the command as text.", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
