from collections.abc import Callable
from datetime import UTC, datetime
from typing import cast

import pytest

from debatemeet.round.domain.drum import DrawnPosition, DrawResult, Drum
from debatemeet.round.domain.position import Position
from debatemeet.round.domain.round import Round
from debatemeet.round.domain.timer import JS_MAX_SAFE_INTEGER
from tests.round.builders import ROUND_ID, T0, refused_with


def test_drum_defaults_are_bounded_and_belong_to_each_new_round() -> None:
    drum = Drum()
    assert drum.enabled == tuple(Position)
    assert drum.drawn == ()
    assert drum.remove_drawn is True
    assert drum.last is None
    assert drum.draw_count == 0
    assert Round.create(ROUND_ID, T0).drum == drum


def test_drum_preserves_disabled_old_draws_and_last_after_mode_changes() -> None:
    first = DrawnPosition(Position.OG, 1)
    last = DrawResult(Position.CO, 7, T0)
    for remove_drawn in (True, False):
        drum = Drum((), (first,), remove_drawn, last, 7)
        assert drum.drawn == (first,)
        assert drum.last == last
    assert Drum(draw_count=99).last is None


def test_draw_numbers_are_positive_safe_integers_but_count_can_be_zero() -> None:
    maximum = DrawnPosition(Position.OG, JS_MAX_SAFE_INTEGER)
    assert Drum(
        (Position.OG,),
        (maximum,),
        True,
        DrawResult(Position.OG, JS_MAX_SAFE_INTEGER, T0),
        JS_MAX_SAFE_INTEGER,
    ).drawn == (maximum,)
    for invalid in (True, 0, -1, JS_MAX_SAFE_INTEGER + 1):
        with refused_with("invalid_drum"):
            DrawnPosition(Position.OG, invalid)
    for invalid in (True, -1, JS_MAX_SAFE_INTEGER + 1):
        with refused_with("invalid_drum"):
            Drum(draw_count=invalid)


CORRUPT_DRUMS: tuple[Callable[[], Drum], ...] = (
    lambda: Drum(enabled=(Position.OG, Position.OG)),
    lambda: Drum(enabled=cast(tuple[Position, ...], [Position.OG])),
    lambda: Drum(enabled=(cast(Position, "og"),)),
    lambda: Drum(remove_drawn=cast(bool, 1)),
    lambda: Drum(drawn=(DrawnPosition(Position.OG, 1),)),
    lambda: Drum(last=DrawResult(Position.OG, 1, T0), draw_count=2),
    lambda: Drum(
        drawn=(DrawnPosition(Position.OG, 2),), last=DrawResult(Position.CO, 1, T0), draw_count=1
    ),
    lambda: Drum(
        drawn=(DrawnPosition(Position.OG, 1),), last=DrawResult(Position.CO, 1, T0), draw_count=1
    ),
    lambda: Drum(
        drawn=(DrawnPosition(Position.OG, 1), DrawnPosition(Position.OG, 2)),
        last=DrawResult(Position.OG, 2, T0),
        draw_count=2,
    ),
    lambda: Drum(
        drawn=(DrawnPosition(Position.OG, 1), DrawnPosition(Position.OO, 1)),
        last=DrawResult(Position.OG, 1, T0),
        draw_count=1,
    ),
)


@pytest.mark.parametrize("create", CORRUPT_DRUMS)
def test_corrupt_drum_shapes_are_rejected(create: Callable[[], Drum]) -> None:
    with refused_with("invalid_drum"):
        create()


def test_last_time_is_aware_and_may_precede_epoch() -> None:
    before_epoch = datetime(1960, 1, 1, tzinfo=UTC)
    assert DrawResult(Position.OG, 1, before_epoch).at == before_epoch
    with refused_with("invalid_drum"):
        DrawResult(Position.OG, 1, T0.replace(tzinfo=None))
