from dataclasses import dataclass
from datetime import datetime


@dataclass(frozen=True, slots=True, kw_only=True)
class DomainEvent:
    """A fact in the past tense. `at` is the server time of the command that produced it.

    Events go to the event log in the transaction of their command; they carry ids, never names
    or texts (docs/architecture.md, section 5).
    """

    at: datetime
