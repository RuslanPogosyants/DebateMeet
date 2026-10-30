import unicodedata

from debatemeet.shared.domain.errors import DomainError

NAME_MAX_CHARACTERS = 40
NAME_MAX_BYTES = 80
# Marks, embeddings, overrides and isolates of text direction: a name could turn the text around it
# backwards.
_BIDI_CONTROLS = frozenset(
    map(chr, (0x200E, 0x200F, *range(0x202A, 0x202F), *range(0x2066, 0x206A)))
)
# Control characters, line and paragraph separators.
_FORBIDDEN_CATEGORIES = frozenset({"Cc", "Zl", "Zp"})


def participant_name(raw: str) -> str:
    """A name as the round keeps it (invariant 14): 1-40 characters and at most 80 bytes of
    UTF-8 after trimming spaces, no control characters. Raises DomainError("invalid_name")."""
    name = raw.strip()
    if not 1 <= len(name) <= NAME_MAX_CHARACTERS or len(name.encode()) > NAME_MAX_BYTES:
        raise DomainError("invalid_name", "a name is 1-40 characters and at most 80 bytes")
    if any(_is_control(character) for character in name):
        raise DomainError("invalid_name", "a name has no control characters")
    return name


def _is_control(character: str) -> bool:
    return character in _BIDI_CONTROLS or unicodedata.category(character) in _FORBIDDEN_CATEGORIES
