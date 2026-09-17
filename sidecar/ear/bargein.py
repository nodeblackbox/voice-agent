"""Two-stage barge-in credit: duck on a little sustained speech, cut once enough NET credit built up.

A leaky bucket rather than a run counter: a missed frame mid-sentence (natural VAD flutter) costs
`barge_in_decay`, not a reset, so continuous speech reliably reaches the cut threshold. A backchannel
("mhm") ducks the agent, then is walked back after `barge_in_release_chunks` quiet frames.
"""
from __future__ import annotations

from typing import Literal

from .config import EndpointConfig

Stage = Literal["duck", "cut", "release"]


class BargeInBucket:
    def __init__(self, cfg: EndpointConfig) -> None:
        self.cfg = cfg
        self.hot = 0
        self.miss_run = 0
        self.ducked = False

    def reset(self) -> None:
        self.hot = self.miss_run = 0
        self.ducked = False

    def update(self, hit: bool, can_duck: bool = True) -> Stage | None:
        cfg = self.cfg
        if hit:
            self.miss_run = 0
            self.hot = min(self.hot + 1, cfg.barge_in_chunks + cfg.duck_chunks)
            if self.hot >= cfg.barge_in_chunks:
                self.reset()
                return "cut"
            if self.hot >= cfg.duck_chunks and not self.ducked and can_duck:
                self.ducked = True
                return "duck"
            return None
        self.hot = max(0, self.hot - cfg.barge_in_decay)
        if not self.ducked:
            self.miss_run = 0
            return None
        self.miss_run += 1
        if self.miss_run >= cfg.barge_in_release_chunks:
            self.reset()
            return "release"
        return None
