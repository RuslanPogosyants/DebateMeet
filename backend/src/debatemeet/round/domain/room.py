from enum import StrEnum


class Room(StrEnum):
    """One of the six logical rooms of a round; all of them exist from the start.

    `room` without a prefix is always a logical room: a LiveKit room is a MediaRoom.
    """

    BASE = "base"
    OG = "og"
    OO = "oo"
    CG = "cg"
    CO = "co"
    JUDGES = "judges"


# Every room but the base: `recall` works only for them.
SUBROOMS = frozenset(Room) - {Room.BASE}
