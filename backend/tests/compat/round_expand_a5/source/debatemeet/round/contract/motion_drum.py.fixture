"""Canonical inputs for judge-controlled motion and position draw commands."""

from typing import Annotated, Self

from pydantic import Field, ValidationInfo, field_validator, model_validator

from debatemeet.round.contract.rooms import EmptyCommandBody
from debatemeet.round.domain.motion import Motion
from debatemeet.round.domain.position import Position
from debatemeet.shared.domain.errors import DomainError


class SetMotionBody(EmptyCommandBody):
    text: Annotated[str, Field(strict=True, max_length=300)]
    infoslide: Annotated[str, Field(strict=True, max_length=1500)]

    @field_validator("text", "infoslide", mode="before")
    @classmethod
    def canonical_text(cls, value: object, info: ValidationInfo) -> object:
        # Keep field normalization in the actual value object, before schema length checks.
        # Pydantic still owns strict input types; non-strings reach its normal validator.
        if not isinstance(value, str):
            return value
        try:
            return (
                Motion(text=value).text
                if info.field_name == "text"
                else Motion(infoslide=value).infoslide
            )
        except DomainError as error:
            raise ValueError("invalid motion text") from error


class ConfigureDrumBody(EmptyCommandBody):
    enabled: Annotated[list[Position], Field(max_length=4)]
    remove_drawn: Annotated[bool, Field(strict=True)]

    @model_validator(mode="after")
    def unique_positions(self) -> Self:
        if len(set(self.enabled)) != len(self.enabled):
            raise ValueError("enabled positions must be unique")
        return self
