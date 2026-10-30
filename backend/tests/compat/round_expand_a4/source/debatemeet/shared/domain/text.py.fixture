"""Canonical multiline plain text shared by motions and chat messages."""

from debatemeet.shared.domain.errors import DomainError


def multiline_text(
    raw: str,
    *,
    maximum_characters: int,
    error_code: str,
    minimum_characters: int = 0,
    maximum_bytes: int | None = None,
) -> str:
    if not isinstance(raw, str):
        raise DomainError(error_code)
    normalized = raw.replace("\r\n", "\n").replace("\r", "\n")
    # Validate before strip: Python treats some forbidden C0/C1 controls as whitespace.
    if any(
        (ord(character) < 0x20 and character not in "\n\t")
        or 0x7F <= ord(character) <= 0x9F
        or 0xD800 <= ord(character) <= 0xDFFF
        for character in normalized
    ):
        raise DomainError(error_code)
    normalized = normalized.strip()
    try:
        encoded = normalized.encode("utf-8")
    except UnicodeEncodeError:
        raise DomainError(error_code) from None
    if not minimum_characters <= len(normalized) <= maximum_characters:
        raise DomainError(error_code)
    if maximum_bytes is not None and len(encoded) > maximum_bytes:
        raise DomainError(error_code)
    return normalized
