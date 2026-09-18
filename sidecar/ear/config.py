from __future__ import annotations

import re
from dataclasses import dataclass, fields
from typing import Any

_CAMEL = re.compile(r"(?<!^)(?=[A-Z])")


def _snake(key: str) -> str:
    return _CAMEL.sub("_", key).lower()


@dataclass
class EndpointConfig:
    vad_threshold: float = 0.5
    min_speech_ms: int = 250
    min_silence_ms: int = 250
    max_silence_ms: int = 1200
    check_every_ms: int = 200
    turn_threshold: float = 0.7
    turn_high_threshold: float = 0.9
    barge_in_threshold: float = 0.75
    barge_in_chunks: int = 10
    duck_chunks: int = 3
    duck_gain: float = 0.25
    barge_in_decay: int = 1
    barge_in_release_chunks: int = 6
    partial_every_ms: int = 600
    preroll_ms: int = 1000
    max_utterance_ms: int = 30000
    level_every_frames: int = 3

    def update(self, values: dict[str, Any]) -> list[str]:
        """Apply camelCase JSON keys in place; returns the keys that were ignored."""
        known = {f.name: f.type for f in fields(self)}
        ignored: list[str] = []
        for key, value in values.items():
            name = _snake(key)
            if name not in known or value is None:
                ignored.append(key)
                continue
            current = getattr(self, name)
            setattr(self, name, type(current)(value))
        return ignored


@dataclass
class SttConfig:
    model: str = "nemo-parakeet-tdt-0.6b-v2"
    device: str = "hybrid"  # hybrid | cuda | cpu

    def update(self, values: dict[str, Any]) -> None:
        if isinstance(values.get("model"), str):
            self.model = values["model"]
        if values.get("device") in ("hybrid", "cuda", "cpu"):
            self.device = values["device"]
