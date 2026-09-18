"""Barge-in credit: the user always has priority, the only question is how fast we are sure.

A leaky bucket rather than a run counter: a missed frame mid-sentence (natural VAD flutter) costs
`barge_in_decay`, not a reset, so continuous speech reliably reaches the threshold.

Two modes:
- instant (`barge_in_instant`, the default): `duck_chunks` of net credit (~100 ms) cuts the agent
  outright. Nothing is ducked, nothing is released; a backchannel also cuts, and the app decides
  what to do with it (it resumes the reply from the cut sentence when the transcript is just "mhm").
- staged: `duck_chunks` ducks playback, `barge_in_chunks` cuts, and `barge_in_release_chunks` quiet
  frames after a duck call it a backchannel and restore the volume.
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
        self.backchannels = 0  # lifetime: ducks that were released without a cut (staged mode only)
        self.cuts = 0          # lifetime: real interruptions

    def reset(self) -> None:
        self.hot = self.miss_run = 0
        self.ducked = False

    def reset_counters(self) -> None:
        self.backchannels = self.cuts = 0

    @property
    def cut_at(self) -> int:
        return self.cfg.duck_chunks if self.cfg.barge_in_instant else self.cfg.barge_in_chunks

    def update(self, hit: bool, can_duck: bool = True) -> Stage | None:
        cfg = self.cfg
        if hit:
            self.miss_run = 0
            self.hot = min(self.hot + 1, cfg.barge_in_chunks + cfg.duck_chunks)
            if self.hot >= self.cut_at:
                self.reset()
                self.cuts += 1
                return "cut"
            if not cfg.barge_in_instant and self.hot >= cfg.duck_chunks and not self.ducked and can_duck:
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
            self.backchannels += 1
            return "release"
        return None
