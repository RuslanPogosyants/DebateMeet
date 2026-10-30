import copy
import json
from dataclasses import asdict
from datetime import timedelta

from hypothesis import settings
from hypothesis import strategies as st
from hypothesis.stateful import RuleBasedStateMachine, invariant, rule

from debatemeet.round.domain.events import DisconnectCause
from debatemeet.round.domain.hand import Hand
from debatemeet.round.domain.ids import ParticipantId, SessionId
from debatemeet.round.domain.presence import Connected
from debatemeet.round.domain.room import Room
from debatemeet.round.domain.timer import TimerKind
from debatemeet.round.infrastructure.mapper import decode_round, encode_round
from tests.round.builders import ROUND_ID, T0, a_round, refused_with

ALICE, BOB, CAROL = ParticipantId("alice"), ParticipantId("bob"), ParticipantId("carol")
PEOPLE = (ALICE, BOB, CAROL)


class SocialCommands(RuleBasedStateMachine):
    def __init__(self) -> None:
        super().__init__()
        self.round = (
            a_round()
            .with_participant(ALICE)
            .with_participant(BOB)
            .with_participant(CAROL)
            .with_judge(ALICE)
            .build()
        )
        self.now, self.session = T0, 0
        self.hands: dict[ParticipantId, Hand | None] = dict.fromkeys(PEOPLE)
        self.round.start_timer(ALICE, TimerKind.PREP, self.now)
        self.round.start_timer(ALICE, TimerKind.SPEECH, self.now)
        self.round.next_speech(ALICE, self.now)
        self.round.pull_events()
        self.unrelated = copy.deepcopy(self.round)

    @rule(milliseconds=st.integers(min_value=0, max_value=1000))
    def time_passes(self, milliseconds: int) -> None:
        self.now += timedelta(milliseconds=milliseconds)

    @rule(actor=st.sampled_from(PEOPLE))
    def raises_hand(self, actor: ParticipantId) -> None:
        if not isinstance(self.round.participants[actor].presence, Connected):
            with refused_with("not_connected"):
                self.round.raise_hand(actor, self.now)
            return
        self.round.raise_hand(actor, self.now)
        if self.hands[actor] is None:
            self.hands[actor] = Hand(self.now)
        else:
            assert self.round.pull_events() == []

    @rule(actor=st.sampled_from(PEOPLE))
    def lowers_own_hand(self, actor: ParticipantId) -> None:
        self.round.lower_hand(actor, self.now)
        self.hands[actor] = None

    @rule(participant_id=st.sampled_from(PEOPLE))
    def judge_lowers_one(self, participant_id: ParticipantId) -> None:
        self.round.lower_hand_of(ALICE, participant_id, self.now)
        self.hands[participant_id] = None

    @rule()
    def judge_lowers_everyone(self) -> None:
        self.round.lower_all_hands(ALICE, self.now)
        self.hands = dict.fromkeys(PEOPLE)

    @rule(actor=st.sampled_from(PEOPLE), room=st.sampled_from(list(Room)))
    def moves(self, actor: ParticipantId, room: Room) -> None:
        if isinstance(self.round.participants[actor].presence, Connected):
            self.round.enter(actor, room, self.now)

    @rule()
    def judge_recalls(self) -> None:
        self.round.recall_all(ALICE, self.now)

    @rule(actor=st.sampled_from((BOB, CAROL)), online=st.booleans())
    def changes_connection(self, actor: ParticipantId, *, online: bool) -> None:
        self.session += 1
        sid = SessionId(f"S-{self.session}")
        if online:
            self.round.connect(actor, str(actor), sid, self.now)
        else:
            presence = self.round.participants[actor].presence
            self.round.disconnect(
                actor,
                presence.sid if isinstance(presence, Connected) else sid,
                self.now,
                cause=DisconnectCause.MEDIA,
            )

    @rule(actor=st.sampled_from((BOB, CAROL)))
    def rejoins(self, actor: ParticipantId) -> None:
        self.round.join(actor, str(actor), self.now, returning=True)

    @rule(participant_id=st.sampled_from(PEOPLE), unmute_request=st.booleans())
    def judge_requests_microphone_action(
        self, participant_id: ParticipantId, *, unmute_request: bool
    ) -> None:
        command = self.round.request_unmute if unmute_request else self.round.mute
        before = copy.deepcopy(self.round.participants)
        if isinstance(self.round.participants[participant_id].presence, Connected):
            command(ALICE, participant_id, self.now)
        else:
            with refused_with("not_connected"):
                command(ALICE, participant_id, self.now)
        assert self.round.participants == before

    @invariant()
    def hands_and_unrelated_state_are_preserved_and_codec_does_not_lose_them(self) -> None:
        assert {
            pid: participant.hand for pid, participant in self.round.participants.items()
        } == self.hands
        assert self.round.prep_timer == self.unrelated.prep_timer
        assert self.round.speech_timer == self.unrelated.speech_timer
        assert self.round.speech_no == self.unrelated.speech_no
        assert self.round.speech_undo == self.unrelated.speech_undo
        assert self.round.motion == self.unrelated.motion
        assert self.round.drum == self.unrelated.drum
        assert self.round.judge_flag == self.unrelated.judge_flag
        restored = decode_round(encode_round(self.round), ROUND_ID, self.round.version)
        assert restored.participants == self.round.participants
        for event in self.round.pull_events():
            payload = asdict(event)
            payload.pop("at")
            json.dumps(payload)


SocialCommands.TestCase.settings = settings(max_examples=250, stateful_step_count=40, deadline=None)
test_social_commands = SocialCommands.TestCase
