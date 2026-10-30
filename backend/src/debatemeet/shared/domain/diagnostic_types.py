"""Finite diagnostic vocabulary, shared by boundary schemas and neutral data."""

from typing import Literal

type SliName = Literal[
    "join_decoded_playback_ms",
    "room_switch_decoded_playback_ms",
    "reconnect_media_ms",
    "snapshot_delivery_ms",
    "clock_offset_uncertainty_ms",
]
type Outcome = Literal[
    "observed", "empty_room", "not_observed", "cancelled", "superseded", "unknown"
]
type Quality = Literal["excellent", "good", "poor", "lost", "unknown"]
type Phase = Literal["prejoin", "joining", "connected", "reconnecting", "left"]
type ErrorCode = Literal[
    "unexpected_error",
    "unhandled_rejection",
    "preload_error",
    "media_unavailable",
    "device_unavailable",
    "playback_blocked",
    "control_unavailable",
    "diagnostics_unavailable",
]
type ErrorClass = Literal["Error", "TypeError", "RangeError", "DOMException", "unknown"]
type SafeEvent = Literal[
    "join_started",
    "join_connected",
    "join_cancelled",
    "room_switch_started",
    "room_switch_completed",
    "reconnect_started",
    "reconnect_completed",
    "snapshot_applied",
    "clock_synchronized",
    "clock_degraded",
    "media_quality_changed",
    "playback_blocked",
    "playback_resumed",
    "device_changed",
    "device_failed",
    "control_failed",
    "diagnostics_dropped",
    "preload_failed",
    "call_left",
]
