"""End-of-turn decision: Silero says "quiet", Smart Turn says "finished".

Below `min_silence_ms` nothing happens. Between min and max, Smart Turn scores the last 8 s of audio
every `check_every_ms` of silence. At `max_silence_ms` the turn ends regardless.

Three confidence tiers (from live use: Smart Turn cut people off mid-hedge at 0.56-0.66):
  score <  turn_threshold        -> not done
  threshold <= score < high      -> done, unless the last live-partial word is a filler/continuation
  score >= turn_high_threshold   -> done regardless of the trailing word

Every check is recorded in `trace` for the current utterance so the app can show *why* a turn ended.
"""
from __future__ import annotations

import collections
import re
import time
from typing import Any, Callable, Protocol

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
        self.held_on_filler = 0          # lifetime: cuts deferred by the filler-word guard
        self.checks = 0                  # lifetime: Smart Turn evaluations
        self.cost_ms: collections.deque[float] = collections.deque(maxlen=200)
        self.trace: list[dict[str, Any]] = []  # this utterance's checks

    def start_utterance(self) -> None:
        self.last_check_ms = -1e9
        self.last_p = None
        self.trace = []

    def cost_p50_ms(self) -> float | None:
        if not self.cost_ms:
            return None
        return float(np.percentile(np.fromiter(self.cost_ms, dtype=np.float64), 50))

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
        self.checks += 1
        self.last_p = p
        last_word = _last_word(trailing_text)
        held = False
        decision: str | None
        if p < cfg.turn_threshold:
            decision = None
        elif p >= cfg.turn_high_threshold:
            decision = "done"
        elif last_word in FILLER_ENDINGS:
            self.held_on_filler += 1
            held = True
            decision = None
        else:
            decision = "done"
        self.trace.append({"silenceMs": round(silence_ms), "p": round(p, 3), "heldOnFiller": held, "lastWord": last_word})
        return decision
