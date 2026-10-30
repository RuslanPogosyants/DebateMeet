"""Synthetic allowlisted payloads, deliberately unrelated to browser or participant secrets."""

from typing import Any
from uuid import uuid4


def sli(**changes: Any) -> dict[str, Any]:
    return {
        "kind": "sli",
        "name": "snapshot_delivery_ms",
        "outcome": "observed",
        "elapsedMs": 125,
        "resolutionMs": 1,
        "clockUncertaintyMs": 2,
        **changes,
    }


def media(**changes: Any) -> dict[str, Any]:
    return {
        "kind": "media",
        "elapsedMs": 5000,
        "observedMs": 5000,
        "unknownMs": 0,
        "quality": "good",
        "playbackAllowed": True,
        "wantedAudio": 2,
        "attachedAudio": 2,
        "decodedActiveAudio": None,
        "jitterMs": None,
        "audioRtcpRttMs": None,
        "iceRttMs": None,
        "receivedPacketsDelta": None,
        "lostPacketsDelta": None,
        "receivedBytesDelta": None,
        "bitrateBps": None,
        "candidateType": None,
        "protocol": None,
        "qualityLimitation": None,
        **changes,
    }


def telemetry(**changes: Any) -> dict[str, Any]:
    return {
        "schemaVersion": 1,
        "batchId": str(uuid4()),
        "clientSessionId": str(uuid4()),
        "appVersion": "test",
        "records": [sli(), media()],
        "droppedRecords": 0,
        **changes,
    }


def client_error(**changes: Any) -> dict[str, Any]:
    return {
        "code": "unexpected_error",
        "phase": "connected",
        "class": "TypeError",
        "frames": [{"asset": "index-AbCd1234.js", "line": 1, "column": 2}],
        **changes,
    }


def report(**changes: Any) -> dict[str, Any]:
    return {
        "phase": "connected",
        "epoch": 1,
        "version": 2,
        "clock": {"synchronized": True, "degraded": False, "ageMs": 100, "uncertaintyMs": 2},
        "media": media(),
        "events": ["join_started", "snapshot_applied"],
        "dropped": {"records": 0, "errors": 0, "events": 0},
        **changes,
    }


def errors(**changes: Any) -> dict[str, Any]:
    value = telemetry()
    del value["records"], value["droppedRecords"]
    return {**value, "errors": [client_error()], "report": report(), **changes}
