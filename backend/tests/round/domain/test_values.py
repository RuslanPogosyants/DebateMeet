import pytest

from debatemeet.round.domain.ids import is_participant_id, is_round_id
from debatemeet.round.domain.name import participant_name
from debatemeet.shared.domain.errors import DomainError

# Written as code points: invisible characters do not belong in the source.
WOMAN_TECHNOLOGIST = "".join(map(chr, (0x1F469, 0x1F3FD, 0x200D, 0x1F4BB)))
LINE_SEPARATOR = chr(0x2028)
RIGHT_TO_LEFT_OVERRIDE = chr(0x202E)


class TestParticipantName:
    def test_spaces_around_are_trimmed(self) -> None:
        assert participant_name("  Вика Сомова \n") == "Вика Сомова"

    @pytest.mark.parametrize(
        "name",
        ["А" * 40, "Ё" * 40, "a", "Анна-Мария О'Коннор", WOMAN_TECHNOLOGIST],
    )
    def test_accepted(self, name: str) -> None:
        assert participant_name(name) == name

    @pytest.mark.parametrize(
        "name",
        [
            "",
            "   ",
            "a" * 41,
            # 27 characters, but 108 bytes of UTF-8.
            "😀" * 27,
            "Вика\tСомова",
            "Вика" + LINE_SEPARATOR + "Сомова",
            "Вика" + RIGHT_TO_LEFT_OVERRIDE + "авомоС",
            "\x00",
        ],
    )
    def test_refused(self, name: str) -> None:
        with pytest.raises(DomainError) as refused:
            participant_name(name)

        assert refused.value.code == "invalid_name"


@pytest.mark.parametrize(
    ("value", "valid"),
    [
        ("Rnd0123456789abcdefghi", True),
        ("Rnd0123456789abcdef-_A", True),
        ("Rnd0123456789abcdefgh", False),
        ("Rnd0123456789abcdefghij", False),
        ("Rnd0123456789abcdefgh=", False),
        ("Rnd0123456789abcdefgh/", False),
    ],
)
def test_round_id(value: str, *, valid: bool) -> None:
    assert is_round_id(value) is valid


@pytest.mark.parametrize(
    ("value", "valid"),
    [
        ("abcdefghijkl", True),
        ("abc-_fghijk9", True),
        ("abcdefghijk", False),
        ("abcdefghijk.", False),
    ],
)
def test_participant_id(value: str, *, valid: bool) -> None:
    assert is_participant_id(value) is valid
