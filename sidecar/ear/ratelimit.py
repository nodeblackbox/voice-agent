"""Keep a repeating fault from flooding stderr and the websocket.

    rl = RateLimiter(window_s=10, burst=3)
    ok, expired = rl.admit("frame_failed")
    for key, n in expired:            # windows that just closed with suppressed repeats
        log.warning("%s repeated %d more times", key, n)
    if ok:                            # first `burst` per window pass
        log.exception(...)

A persistent per-frame exception at 31 frames/s would otherwise write ~31 tracebacks a second.
"""
from __future__ import annotations

import time
from typing import Callable


class RateLimiter:
    def __init__(self, window_s: float = 10.0, burst: int = 3, clock: Callable[[], float] = time.monotonic) -> None:
        self.window_s = window_s
        self.burst = burst
        self._clock = clock
        self._keys: dict[str, tuple[float, int, int]] = {}  # key -> (window start, passed, suppressed)

    def admit(self, key: str) -> tuple[bool, list[tuple[str, int]]]:
        now = self._clock()
        expired = self.sweep(now)
        start, passed, suppressed = self._keys.get(key, (now, 0, 0))
        if passed < self.burst:
            self._keys[key] = (start, passed + 1, suppressed)
            return True, expired
        self._keys[key] = (start, passed, suppressed + 1)
        return False, expired

    def sweep(self, now: float | None = None) -> list[tuple[str, int]]:
        now = self._clock() if now is None else now
        out: list[tuple[str, int]] = []
        for key, (start, _passed, suppressed) in list(self._keys.items()):
            if now - start < self.window_s:
                continue
            del self._keys[key]
            if suppressed:
                out.append((key, suppressed))
        return out
