import pytest
from hypothesis import given
from hypothesis import strategies as st

from debatemeet.round.domain.motion import Motion
from debatemeet.round.domain.round import Round
from tests.round.builders import ROUND_ID, T0, refused_with


def test_motion_defaults_and_independent_infoslide() -> None:
    assert Motion() == Motion("", "")
    assert Motion("", "Инфослайд").infoslide == "Инфослайд"
    assert Round.create(ROUND_ID, T0).motion == Motion()


def test_motion_normalizes_line_endings_and_outer_whitespace_only() -> None:
    motion = Motion(" \r\nЭП считает,\rчто это важно\tтак\n ", " A\rB\r\nC ")
    assert motion.text == "ЭП считает,\nчто это важно\tтак"
    assert motion.infoslide == "A\nB\nC"
    assert Motion("\ufeffтекст\ufeff").text == "\ufeffтекст\ufeff"


def test_motion_limits_apply_after_normalization_to_code_points_and_utf8_bytes() -> None:
    assert len(Motion(" я" * 150).text) == 299
    assert Motion("я" * 300).text == "я" * 300
    assert Motion("😀" * 150).text == "😀" * 150
    assert Motion(infoslide="я" * 1500).infoslide == "я" * 1500
    for invalid in ("a" * 301, "я" * 301, "😀" * 151):
        with refused_with("invalid_motion"):
            Motion(invalid)
    with refused_with("invalid_motion"):
        Motion(infoslide="я" * 1501)


@pytest.mark.parametrize("codepoint", [0, 0x1C, 0x7F, 0x85, 0x9F, 0xD800, 0xDFFF])
def test_motion_rejects_forbidden_code_points_even_outside_trimmed_content(codepoint: int) -> None:
    control = chr(codepoint)
    for invalid in (f"{control}текст", f"текст{control}", f"те{control}кст"):
        with refused_with("invalid_motion"):
            Motion(invalid)
        with refused_with("invalid_motion"):
            Motion(infoslide=invalid)


@given(st.text(alphabet=st.characters(blacklist_categories=("Cc", "Cs")), max_size=100))
def test_motion_normalization_is_idempotent(text: str) -> None:
    normalized = Motion(text)
    assert Motion(normalized.text, normalized.infoslide) == normalized
