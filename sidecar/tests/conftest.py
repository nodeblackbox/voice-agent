from __future__ import annotations

from typing import Any, Callable

import numpy as np
import pytest

from ear import CHUNK
from ear.config import EndpointConfig, SttConfig
from ear.pipeline import Pipeline


class FakeVad:
    """Returns scripted speech probabilities, then `default` forever."""

    def __init__(self, probs: list[float] | None = None, default: float = 0.0) -> None:
        self.probs = list(probs or [])
        self.default = default
        self.resets = 0

    def __call__(self, chunk: np.ndarray) -> float:
        return self.probs.pop(0) if self.probs else self.default

    def reset(self) -> None:
        self.resets += 1


class FakeTurn:
    def __init__(self, p: float = 0.95) -> None:
        self.p = p
        self.calls = 0

    def __call__(self, audio: np.ndarray) -> float:
        self.calls += 1
        return self.p


class FakeAsr:
    providers = ["CPUExecutionProvider"]
    load_s = 0.0

    def __init__(self, text: str = "hello world") -> None:
        self.text = text
        self.calls: list[int] = []

    def recognize(self, audio: np.ndarray) -> str:
        self.calls.append(len(audio))
        return self.text

    def warm_up(self) -> None:
        pass


class Clock:
    def __init__(self) -> None:
        self.t = 100.0

    def __call__(self) -> float:
        return self.t


def inline_spawn(fn: Callable[..., None], args: tuple) -> None:
    fn(*args)


@pytest.fixture
def cfg() -> EndpointConfig:
    return EndpointConfig()


@pytest.fixture
def events() -> list[dict[str, Any]]:
    return []


@pytest.fixture
def make_pipeline(events: list[dict[str, Any]], tmp_path):
    def build(*, vad: FakeVad | None = None, turn: FakeTurn | None = None, asr: FakeAsr | None = None,
              endpoint: EndpointConfig | None = None) -> Pipeline:
        p = Pipeline(events.append, tmp_path, endpoint or EndpointConfig(), SttConfig(),
                     vad=vad or FakeVad(), turn=turn or FakeTurn(), asr=asr or FakeAsr(),
                     start_threads=False, spawn=inline_spawn, clock=Clock(), probe_gpu=False)
        p.load()
        events.clear()
        return p

    return build


def frames(n: int) -> list[np.ndarray]:
    return [np.zeros(CHUNK, dtype=np.float32) for _ in range(n)]


def kinds(events: list[dict[str, Any]]) -> list[str]:
    return [e["type"] for e in events if e["type"] != "level"]
