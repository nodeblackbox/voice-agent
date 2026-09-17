"""End-of-turn decision: Silero says "quiet", Smart Turn says "finished".

Below `min_silence_ms` nothing happens. Between min and max, Smart Turn scores the last 8 s of audio
every `check_every_ms` of silence. At `max_silence_ms` the turn ends regardless.

Three confidence tiers (from live use: Smart Turn cut people off mid-hedge at 0.56-0.66):
  score <  turn_threshold        -> not done
  threshold <= score < high      -> done, unless the last live-partial word is a filler/continuation
  score >= turn_high_threshold   -> done regardless of the trailing word
"""
from __future__ import annotations

import re
import time
from typing import Callable, Protocol

import numpy as np

from .config import EndpointConfig


class TurnModel(Protocol):
    def __call__(self, audio: np.ndarray) -> float: ...

FILLER_ENDINGS = {
    "um", "umm", "uh", "uhh", "er", "ah", "so", "and", "but", "or", "the", "a", "is", "that", "that's",
    "like", "because", "which", "yeah", "well", "wait", "if", "i", "you", "we", "it's", "with", "for", "to",
}

_WORD = re.compile(r"[a-z']+")


def _last_word(text: str) -> str:
    words = _WORD.findall(text.lower())
    return words[-1] if words else ""


class Endpointer:
    def __init__(self, cfg: EndpointConfig, model: TurnModel | None) -> None:
        self.cfg = cfg
        self.model = model
        self.last_check_ms = -1e9
        self.last_p: float | None = None
        self.held_on_filler = 0
        self.cost_ms: list[float] = []

    def start_utterance(self) -> None:
        self.last_check_ms = -1e9
        self.last_p = None

    def update(self, audio: Callable[[], np.ndarray], silence_ms: float, trailing_text: str = "") -> str | None:
        cfg = self.cfg
        if silence_ms < cfg.min_silence_ms:
            return None
        if silence_ms >= cfg.max_silence_ms:
            return "timeout"
        if self.model is None or silence_ms - self.last_check_ms < cfg.check_every_ms:
            return None
        self.last_check_ms = silence_ms
        t0 = time.perf_counter()
        p = self.model(audio())
        self.cost_ms.append((time.perf_counter() - t0) * 1e3)
        self.last_p = p
        if p < cfg.turn_threshold:
            return None
        if p >= cfg.turn_high_threshold:
            return "done"
        if _last_word(trailing_text) in FILLER_ENDINGS:
            self.held_on_filler += 1
            return None
        return "done"
