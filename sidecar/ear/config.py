from __future__ import annotations

import re
from dataclasses import dataclass, fields
from typing import Any

_CAMEL = re.compile(r"(?<!^)(?=[A-Z])")


def _snake(key: str) -> str:
    return _CAMEL.sub("_", key).lower()


DEFAULT_FILLER_WORDS = (
    "um, umm, uh, uhh, er, ah, so, and, but, or, the, a, is, that, that's, like, because, which, yeah, well, wait, "
    "if, i, you, we, it's, with, for, to, then, basically, also, maybe, where, when, what, how, why, i'll, i'm, i've, "
    "we're, it'll, gonna, wanna, of, in, on, at, by, from, about, into, my, your, his, her, our, their, this, these, "
    "those, some, kind, sort, mean, really, actually, just, very"
)


def _coerce(current: Any, value: Any) -> Any:
    if isinstance(current, bool):
        if isinstance(value, str):
            return value.strip().lower() in ("1", "true", "yes", "on")
        return bool(value)
    if isinstance(current, str):
        return str(value)
    return type(current)(value)


@dataclass
class EndpointConfig:
    vad_threshold: float = 0.5
    min_speech_ms: int = 250
    min_silence_ms: int = 250
    max_silence_ms: int = 1500
    check_every_ms: int = 200
    turn_threshold: float = 0.7
    turn_high_threshold: float = 0.9
    # when Smart Turn is this sure the speaker is NOT done, wait `max_silence_low_ms` instead of `max_silence_ms`
    turn_low_threshold: float = 0.3
    max_silence_low_ms: int = 3000
    barge_in_threshold: float = 0.75
    barge_in_chunks: int = 10
    duck_chunks: int = 3
    # instant: the agent is cut as soon as credit reaches `duck_chunks`; no ducking, no release
    barge_in_instant: bool = True
    duck_gain: float = 0.25
    barge_in_decay: int = 1
    barge_in_release_chunks: int = 6
    partial_every_ms: int = 600
    # a partial decode is forced once per pause this soon after speech stops, so the filler-word
    # guard sees the actual last word instead of a caption up to `partial_every_ms` old
    silence_partial_ms: int = 100
    preroll_ms: int = 1000
    max_utterance_ms: int = 120000
    # long monologues are transcribed in segments this long while the utterance stays open
    segment_every_ms: int = 30000
    filler_words: str = DEFAULT_FILLER_WORDS
    # a trailing filler word holds the turn even at a high score, but only on the first check
    filler_holds_high_tier: bool = True
    level_every_frames: int = 3
    # consecutive decode failures before the ASR model is reloaded; failing again after that is fatal
    asr_failure_limit: int = 3

    def filler_set(self) -> frozenset[str]:
        return frozenset(w.strip().lower() for w in self.filler_words.split(",") if w.strip())

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
            setattr(self, name, _coerce(current, value))
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
