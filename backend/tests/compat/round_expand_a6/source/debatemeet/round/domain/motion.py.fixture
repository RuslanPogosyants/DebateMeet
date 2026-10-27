from dataclasses import dataclass

from debatemeet.shared.domain.text import multiline_text


@dataclass(frozen=True, slots=True)
class Motion:
    text: str = ""
    infoslide: str = ""

    def __post_init__(self) -> None:
        object.__setattr__(
            self,
            "text",
            multiline_text(
                self.text, maximum_characters=300, maximum_bytes=600, error_code="invalid_motion"
            ),
        )
        object.__setattr__(
            self,
            "infoslide",
            multiline_text(
                self.infoslide,
                maximum_characters=1500,
                maximum_bytes=3000,
                error_code="invalid_motion",
            ),
        )
