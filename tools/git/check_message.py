#!/usr/bin/env python3
"""Commit message and PR title policy.

One line `type: description` in English, types feat|fix|refactor|docs|test|chore,
no body, no trailers, no attribution. Used by the commit-msg hook (lefthook.yml),
by CI for PR titles (a squash merge turns the title into the commit message) and
by .claude/hooks/git-guard.py.

Usage: check_message.py <message-file> | check_message.py --title <text>
Stdlib only, Python 3.9+: it runs on the system interpreter, outside the backend venv.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

TYPES = ("feat", "fix", "refactor", "docs", "test", "chore")
MAX_SUBJECT_LENGTH = 100
SUBJECT_RE = re.compile(r"^(" + "|".join(TYPES) + r"): [a-z0-9]")
# Attribution of the text to an AI tool. A bare file name such as CLAUDE.md is fine.
ATTRIBUTION_RE = re.compile(
    r"co-?authored-by"
    r"|generated (with|by) \S*\s?(claude|anthropic)"
    r"|claude[ -]code"
    r"|(via|using|with|by) (claude|anthropic)\b"
    r"|anthropic\.com"
    r"|claude\.(ai|com)"
    r"|\U0001F916",
    re.IGNORECASE,
)
SCISSORS = "# ------------------------ >8 ------------------------"
FORMAT_HINT = (
    "expected one line 'type: description' in English: type is one of "
    + "|".join(TYPES)
    + f", description starts lowercase, at most {MAX_SUBJECT_LENGTH} characters,"
    " no final period, no body, no trailers"
)


def find_attribution(text: str) -> str | None:
    match = ATTRIBUTION_RE.search(text)
    return match.group(0) if match else None


def message_lines(text: str) -> list[str]:
    """Non-empty lines of a commit message file, without git comments and the verbose diff."""
    lines = []
    for line in text.splitlines():
        if line == SCISSORS:
            break
        if line.startswith("#") or not line.strip():
            continue
        lines.append(line.rstrip())
    return lines


def check_message(text: str, *, allow_merge: bool = True) -> str | None:
    """Return why the message is rejected, or None if it is fine."""
    lines = message_lines(text)
    if not lines:
        return "the message is empty"
    hit = find_attribution("\n".join(lines))
    if hit:
        return f"attribution is not allowed: {hit!r}"
    subject = lines[0]
    # Messages that git writes itself keep their format.
    if subject.startswith("Revert ") or (allow_merge and subject.startswith("Merge ")):
        return None
    if len(lines) > 1:
        return "only one line is allowed: no body and no trailers"
    if not SUBJECT_RE.match(subject):
        return f"the subject does not start with 'type: description': {subject!r}"
    if len(subject) > MAX_SUBJECT_LENGTH:
        return f"the subject is longer than {MAX_SUBJECT_LENGTH} characters ({len(subject)})"
    if subject.endswith("."):
        return "the subject ends with a period"
    if not subject.isascii():
        return "the subject has non-ASCII characters: write it in English"
    return None


def main(argv: list[str]) -> int:
    if len(argv) == 3 and argv[1] == "--title":
        reason = check_message(argv[2], allow_merge=False)
    elif len(argv) == 2:
        reason = check_message(Path(argv[1]).read_text(encoding="utf-8"))
    else:
        print("usage: check_message.py <message-file> | --title <text>", file=sys.stderr)
        return 2
    if reason:
        print(f"Rejected: {reason}.\n{FORMAT_HINT}.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
