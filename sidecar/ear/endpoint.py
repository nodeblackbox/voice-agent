"""End-of-turn decision: Silero says "quiet", Smart Turn says "finished".

Below `min_silence_ms` nothing happens. Between min and the cap, Smart Turn scores the last 8 s of
audio every `check_every_ms` of silence. The cap depends on what the model last said: while it is
sure the speaker is NOT done (`p < turn_low_threshold`) the turn may stay open for
`max_silence_low_ms` (the user is thinking); otherwise `max_silence_ms` is the hard limit.

Three confidence tiers (from live use: Smart Turn cut people off mid-hedge at 0.56-0.66):
  score <  turn_threshold        -> not done
  threshold <= score < high      -> done, unless the last live-partial word is a filler/continuation
  score >= turn_high_threshold   -> done, unless the last word is a filler AND nothing has held this
                                    utterance yet (`filler_holds_high_tier`): the next check decides

Every check is recorded in `trace` for the current utterance so the app can show *why* a turn ended.
"""
from __future__ import annotations

import collections
import re
import time
from typing import Any, Callable, Protocol

import numpy as np

from .config import DEFAULT_FILLER_WORDS, EndpointConfig


class TurnModel(Protocol):
    def __call__(self, audio: np.ndarray) -> float: ...


FILLER_ENDINGS = frozenset(w.strip() for w in DEFAULT_FILLER_WORDS.split(","))

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
        self.last_word = ""
        self.cap_ms = cfg.max_silence_ms
        self.held_on_filler = 0          # lifetime: cuts deferred by the filler-word guard
        self.checks = 0                  # lifetime: Smart Turn evaluations
        self.cost_ms: collections.deque[float] = collections.deque(maxlen=200)
        self.trace: list[dict[str, Any]] = []  # this utterance's checks
        self._held_once = False
        self._fillers_src = ""
        self._fillers: frozenset[str] = FILLER_ENDINGS

    def start_utterance(self) -> None:
        self.last_check_ms = -1e9
        self.last_p = None
        self.last_word = ""
        self.cap_ms = self.cfg.max_silence_ms
        self.trace = []
        self._held_once = False

    def fillers(self) -> frozenset[str]:
        if self.cfg.filler_words != self._fillers_src:
            self._fillers_src = self.cfg.filler_words
            self._fillers = self.cfg.filler_set()
        return self._fillers

    def cost_p50_ms(self) -> float | None:
        if not self.cost_ms:
            return None
        return float(np.percentile(np.fromiter(self.cost_ms, dtype=np.float64), 50))

    def current_cap_ms(self) -> int:
        cfg = self.cfg
        if self.last_p is not None and self.last_p < cfg.turn_low_threshold:
            return max(cfg.max_silence_ms, cfg.max_silence_low_ms)
        return cfg.max_silence_ms

    def update(self, audio: Callable[[], np.ndarray], silence_ms: float, trailing_text: str = "") -> str | None:
        cfg = self.cfg
        if silence_ms < cfg.min_silence_ms:
            return None
        self.cap_ms = self.current_cap_ms()
        if silence_ms >= self.cap_ms:
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
        self.last_word = last_word
        is_filler = last_word in self.fillers()
        held = False
        decision: str | None
        if p < cfg.turn_threshold:
            decision = None
        elif p >= cfg.turn_high_threshold:
            # a confident score ends the turn unless a filler word holds it, and that only once per
            # utterance: after any hold, the next confident check wins
            if is_filler and cfg.filler_holds_high_tier and not self._held_once:
                self._held_once = True
                self.held_on_filler += 1
                held = True
                decision = None
            else:
                decision = "done"
        elif is_filler:
            self._held_once = True
            self.held_on_filler += 1
            held = True
            decision = None
        else:
            decision = "done"
        self.trace.append({"silenceMs": round(silence_ms), "p": round(p, 3), "heldOnFiller": held, "lastWord": last_word,
                           "capMs": self.current_cap_ms()})
        self.cap_ms = self.current_cap_ms()
        return decision
