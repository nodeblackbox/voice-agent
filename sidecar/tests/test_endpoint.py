from __future__ import annotations

import numpy as np
import pytest

from ear.config import EndpointConfig
from ear.endpoint import FILLER_ENDINGS, Endpointer, _last_word

AUDIO = np.zeros(16000, dtype=np.float32)


class ScriptedTurn:
    def __init__(self, *ps: float) -> None:
        self.ps = list(ps)
        self.calls = 0

    def __call__(self, audio: np.ndarray) -> float:
        self.calls += 1
        return self.ps.pop(0) if len(self.ps) > 1 else self.ps[0]


def make(*ps: float, **overrides) -> tuple[Endpointer, ScriptedTurn]:
    cfg = EndpointConfig(**overrides)
    model = ScriptedTurn(*(ps or (0.95,)))
    ep = Endpointer(cfg, model)
    ep.start_utterance()
    return ep, model


def test_below_min_silence_never_scores():
    ep, model = make()
    assert ep.update(lambda: AUDIO, 0) is None
    assert ep.update(lambda: AUDIO, 249) is None
    assert model.calls == 0


def test_max_silence_is_a_timeout_even_without_a_model():
    ep = Endpointer(EndpointConfig(), None)
    ep.start_utterance()
    assert ep.update(lambda: AUDIO, 1199) is None
    assert ep.update(lambda: AUDIO, 1200) == "timeout"


def test_no_model_degrades_to_plain_hangover():
    ep = Endpointer(EndpointConfig(), None)
    ep.start_utterance()
    assert all(ep.update(lambda: AUDIO, ms) is None for ms in (250, 400, 800, 1100))
    assert ep.update(lambda: AUDIO, 1300) == "timeout"


def test_scoring_cadence_honours_check_every_ms():
    ep, model = make(0.1)
    for ms in (250, 300, 400, 449):
        ep.update(lambda: AUDIO, ms)
    assert model.calls == 1
    ep.update(lambda: AUDIO, 450)
    assert model.calls == 2
    assert ep.last_p == pytest.approx(0.1)


def test_audio_is_only_materialised_when_scoring():
    ep, _ = make(0.1)
    calls = 0

    def audio() -> np.ndarray:
        nonlocal calls
        calls += 1
        return AUDIO

    ep.update(audio, 100)
    assert calls == 0
    ep.update(audio, 300)
    assert calls == 1


def test_low_confidence_is_not_done():
    ep, _ = make(0.69)
    assert ep.update(lambda: AUDIO, 300, "so I think that is") is None


@pytest.mark.parametrize("trailing", ["um", "and then, so", "I was thinking that's", "Yeah yeah"])
def test_mid_confidence_holds_on_filler_word(trailing):
    ep, _ = make(0.8)
    assert ep.update(lambda: AUDIO, 300, trailing) is None
    assert ep.held_on_filler == 1


def test_mid_confidence_ends_on_a_real_word():
    ep, _ = make(0.8)
    assert ep.update(lambda: AUDIO, 300, "what time is it in Tokyo") == "done"
    assert ep.held_on_filler == 0


def test_high_confidence_overrides_filler_word():
    ep, _ = make(0.95)
    assert ep.update(lambda: AUDIO, 300, "and um") == "done"


def test_mid_confidence_with_no_transcript_ends():
    ep, _ = make(0.8)
    assert ep.update(lambda: AUDIO, 300, "") == "done"


def test_start_utterance_resets_cadence_and_score():
    ep, model = make(0.1)
    ep.update(lambda: AUDIO, 300)
    assert model.calls == 1 and ep.last_p is not None
    ep.start_utterance()
    assert ep.last_p is None
    ep.update(lambda: AUDIO, 300)
    assert model.calls == 2


def test_held_then_released_when_score_rises():
    ep, model = make(0.8, 0.95)
    assert ep.update(lambda: AUDIO, 300, "and") is None
    assert ep.update(lambda: AUDIO, 500, "and") == "done"


@pytest.mark.parametrize(
    "text, word",
    [
        ("", ""),
        ("Hello world.", "world"),
        ("that's", "that's"),
        ("It's fine, isn't it?!", "it"),
        ("UM...", "um"),
        ("numbers 123 end", "end"),
        ("  trailing space   ", "space"),
        ("123", ""),
    ],
)
def test_last_word(text, word):
    assert _last_word(text) == word


def test_filler_endings_are_lowercase_words():
    assert all(w == w.lower() and w == _last_word(w) for w in FILLER_ENDINGS)
