from typing import Literal

type ReactionCode = Literal["clap", "thumbs_up", "heart", "laugh", "wow"]

REACTION_CODES: tuple[ReactionCode, ...] = ("clap", "thumbs_up", "heart", "laugh", "wow")
