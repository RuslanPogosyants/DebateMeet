from enum import StrEnum


class Position(StrEnum):
    OG = "og"
    OO = "oo"
    CG = "cg"
    CO = "co"
    OG1 = "og1"
    OG2 = "og2"
    OO1 = "oo1"
    OO2 = "oo2"
    CG1 = "cg1"
    CG2 = "cg2"
    CO1 = "co1"
    CO2 = "co2"


TEAM_POSITIONS = (Position.OG, Position.OO, Position.CG, Position.CO)
SPEAKER_POSITIONS = (
    Position.OG1,
    Position.OG2,
    Position.OO1,
    Position.OO2,
    Position.CG1,
    Position.CG2,
    Position.CO1,
    Position.CO2,
)
