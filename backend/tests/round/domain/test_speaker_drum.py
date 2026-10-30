"""Team and individual-speaker draws share one bounded, explicit drum."""

from debatemeet.round.domain.drum import DrawnPosition, DrawResult
from debatemeet.round.domain.position import Position
from tests.round.builders import at, refused_with
from tests.round.domain.test_motion_drum_commands import ALICE, judged_round


def speaker_positions() -> tuple[Position, ...]:
    return tuple(
        Position(f"{team}{number}") for team in ("og", "oo", "cg", "co") for number in (1, 2)
    )


def test_eight_speaker_positions_are_independent_and_exhaust_without_replacement() -> None:
    round_ = judged_round()
    positions = speaker_positions()
    round_.configure_drum(ALICE, tuple(reversed(positions)), True, at(1))
    assert round_.drum.enabled == positions
    for number, position in enumerate(positions, 1):
        assert position in round_.draw_candidates(ALICE, at(number + 1))
        round_.draw(ALICE, position, at(number + 1))
    assert round_.drum.drawn == tuple(
        DrawnPosition(position, index) for index, position in enumerate(positions, 1)
    )
    assert round_.drum.last == DrawResult(positions[-1], 8, at(9))
    with refused_with("drum_empty"):
        round_.draw_candidates(ALICE, at(10))
    round_.reset_drum(ALICE, at(11))
    assert round_.draw_candidates(ALICE, at(12)) == positions
    assert round_.drum.draw_count == 8


def test_switching_preserves_twelve_draws_and_replacement_does_not_grow_history() -> None:
    round_ = judged_round()
    teams = (Position.OG, Position.OO, Position.CG, Position.CO)
    for number, position in enumerate(teams, 1):
        round_.draw(ALICE, position, at(number))
    speakers = speaker_positions()
    round_.configure_drum(ALICE, speakers, True, at(5))
    for number, position in enumerate(speakers, 5):
        round_.draw(ALICE, position, at(number + 1))
    history = round_.drum.drawn
    assert len(history) == 12
    last = round_.drum.last
    round_.configure_drum(ALICE, teams, False, at(14))
    assert round_.drum.drawn == history
    assert round_.drum.last == last
    round_.draw(ALICE, Position.OG, at(15))
    round_.draw(ALICE, Position.OG, at(16))
    assert round_.drum.drawn == history
    round_.configure_drum(ALICE, teams, True, at(17))
    with refused_with("drum_empty"):
        round_.draw_candidates(ALICE, at(18))
    round_.reset_drum(ALICE, at(19))
    assert round_.drum.drawn == ()
    assert round_.drum.last is None
    assert round_.drum.draw_count == 14
    assert round_.draw_candidates(ALICE, at(20)) == teams
