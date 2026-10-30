"""Coordinate local recorders; media bytes never pass through the backend."""

from contextlib import AbstractAsyncContextManager
from dataclasses import dataclass, replace
from datetime import datetime, timedelta
from typing import Protocol

from debatemeet.round.application.credentials import Credentials, verify
from debatemeet.round.application.ports import ParticipantArchive, RoundRepository
from debatemeet.round.domain.ids import ParticipantId, RoundId, SessionId
from debatemeet.round.domain.presence import Connected
from debatemeet.round.domain.room import Room
from debatemeet.shared.application.clock import Clock
from debatemeet.shared.application.errors import NotFoundError
from debatemeet.shared.domain.errors import DomainError

LEASE_DURATION = timedelta(seconds=15)


@dataclass(frozen=True, slots=True)
class RecordingLease:
    room: Room
    recording_id: str
    participant_id: ParticipantId
    sid: SessionId
    epoch: int
    expires_at: datetime
    active: bool


@dataclass(frozen=True, slots=True)
class RecordingStatus:
    leases: tuple[RecordingLease, ...]
    server_time: datetime


class RecordingTransaction(Protocol):
    rounds: RoundRepository
    archive: ParticipantArchive

    async def epoch(self) -> int: ...
    async def leases(self, round_id: RoundId) -> tuple[RecordingLease, ...]: ...
    async def save(self, round_id: RoundId, lease: RecordingLease) -> None: ...
    async def remove(
        self,
        round_id: RoundId,
        participant_id: ParticipantId,
        sid: SessionId,
        room: Room,
        recording_id: str,
    ) -> None: ...


class RecordingTransactions(Protocol):
    def begin(self) -> AbstractAsyncContextManager[RecordingTransaction]: ...


class ManageRecordings:
    def __init__(self, transactions: RecordingTransactions, clock: Clock) -> None:
        self._transactions, self._clock = transactions, clock

    def remaining_ms(self, lease: RecordingLease) -> int:
        return max(
            0, min(15000, int((lease.expires_at - self._clock.now()).total_seconds() * 1000))
        )

    async def status(self, round_id: RoundId, credentials: Credentials) -> RecordingStatus:
        async with self._transactions.begin() as tx:
            round_ = await tx.rounds.get_for_update(round_id)
            verify(await tx.archive.find(round_id, credentials.participant_id), credentials)
            if round_ is None:
                raise NotFoundError
            now, epoch = self._clock.now(), await tx.epoch()
            visible = []
            for lease in await tx.leases(round_id):
                person = round_.participants.get(lease.participant_id)
                if (
                    lease.active
                    and lease.expires_at > now
                    and lease.epoch == epoch
                    and person is not None
                    and person.room == lease.room
                    and isinstance(person.presence, Connected)
                    and person.presence.sid == lease.sid
                ):
                    visible.append(lease)
            return RecordingStatus(tuple(visible), now)

    async def reserve(
        self,
        round_id: RoundId,
        credentials: Credentials,
        sid: SessionId,
        room: Room,
        recording_id: str,
    ) -> RecordingLease:
        return await self._write(round_id, credentials, sid, room, recording_id, reserve=True)

    async def renew(
        self,
        round_id: RoundId,
        credentials: Credentials,
        sid: SessionId,
        room: Room,
        recording_id: str,
        *,
        active: bool,
    ) -> RecordingLease:
        return await self._write(
            round_id,
            credentials,
            sid,
            room,
            recording_id,
            reserve=False,
            active=active,
        )

    async def _write(
        self,
        round_id: RoundId,
        credentials: Credentials,
        sid: SessionId,
        room: Room,
        recording_id: str,
        *,
        reserve: bool,
        active: bool = False,
    ) -> RecordingLease:
        async with self._transactions.begin() as tx:
            # The same round lock serializes entry, presence and competing recorders.
            round_ = await tx.rounds.get_for_update(round_id)
            verify(await tx.archive.find(round_id, credentials.participant_id), credentials)
            if round_ is None:
                raise NotFoundError
            person = round_.participants.get(credentials.participant_id)
            if (
                person is None
                or person.room != room
                or not isinstance(person.presence, Connected)
                or person.presence.sid != sid
            ):
                raise DomainError("recording_session_changed")
            epoch = await tx.epoch()
            now = self._clock.now()
            previous = next((item for item in await tx.leases(round_id) if item.room == room), None)
            same = (
                previous is not None
                and previous.recording_id == recording_id
                and previous.participant_id == person.id
                and previous.sid == sid
                and previous.epoch == epoch
            )
            if reserve:
                if previous is not None and previous.expires_at > now:
                    if same:
                        return previous
                    raise DomainError("recording_busy")
                if same:
                    raise DomainError("recording_expired")
                lease = RecordingLease(
                    room, recording_id, person.id, sid, epoch, now + LEASE_DURATION, False
                )
            else:
                if not same or previous is None or previous.expires_at <= now:
                    raise DomainError("recording_expired")
                lease = replace(
                    previous, expires_at=now + LEASE_DURATION, active=previous.active or active
                )
            await tx.save(round_id, lease)
            return lease

    async def stop(
        self,
        round_id: RoundId,
        credentials: Credentials,
        sid: SessionId,
        room: Room,
        recording_id: str,
    ) -> None:
        async with self._transactions.begin() as tx:
            # A displaced owner may release only its own fenced lease, never the new one.
            await tx.rounds.get_for_update(round_id)
            verify(await tx.archive.find(round_id, credentials.participant_id), credentials)
            await tx.remove(round_id, credentials.participant_id, sid, room, recording_id)
