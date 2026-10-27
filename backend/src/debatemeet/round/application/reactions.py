from debatemeet.round.application.credentials import Credentials, verify
from debatemeet.round.application.ports import (
    ReactionGateway,
    ReactionLimiter,
    ReactionMessage,
    RoundReader,
)
from debatemeet.round.domain.ids import RoundId
from debatemeet.round.domain.presence import Connected
from debatemeet.round.domain.reaction import REACTION_CODES, ReactionCode
from debatemeet.shared.application.errors import (
    MediaUnavailableError,
    NotFoundError,
    RateLimitedError,
)
from debatemeet.shared.application.ports import RandomSource
from debatemeet.shared.domain.errors import DomainError


class SendReaction:
    def __init__(
        self,
        reader: RoundReader,
        gateway: ReactionGateway,
        limiter: ReactionLimiter,
        random: RandomSource,
    ) -> None:
        self._reader, self._gateway, self._limiter, self._random = reader, gateway, limiter, random

    async def __call__(
        self, round_id: RoundId, credentials: Credentials, reaction: ReactionCode
    ) -> None:
        if reaction not in REACTION_CODES:
            raise DomainError("invalid_reaction")
        actor = credentials.participant_id
        verify(await self._reader.participant(round_id, actor), credentials)
        committed = await self._reader.committed(round_id)
        if committed is None:
            raise NotFoundError
        sender = committed.round.participants.get(actor)
        if sender is None:
            raise DomainError("participant_not_found")
        if not isinstance(sender.presence, Connected):
            raise DomainError("not_connected")
        if not self._limiter.allow(round_id, actor):
            raise RateLimitedError
        recipients = tuple(
            person.id
            for person in committed.round.participants.values()
            if person.room is sender.room and isinstance(person.presence, Connected)
        )
        message = ReactionMessage(
            round_id=round_id,
            epoch=committed.epoch,
            version=committed.round.version,
            room=sender.room,
            participant_id=actor,
            reaction=reaction,
            nonce=self._random.token(12),
        )
        try:
            await self._gateway.send_reaction(message, recipients)
        except MediaUnavailableError, TimeoutError:
            # Reactions are ephemeral: no durable receipt, retry, or optimistic second render.
            return
