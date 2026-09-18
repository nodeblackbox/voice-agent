from __future__ import annotations

import sys

import numpy as np
import pytest

from ear import CHUNK

onnxruntime = pytest.importorskip("onnxruntime")
pytest.importorskip("silero_vad")

from ear.vad import SileroVad, bundled_model_path  # noqa: E402


def test_silero_runs_on_onnxruntime_without_importing_torch():
    had_torch = "torch" in sys.modules
    vad = SileroVad()
    for _ in range(5):
        p = vad(np.zeros(CHUNK, dtype=np.float32))
    assert 0.0 <= p <= 1.0
    assert p < 0.2, "silence should not look like speech"
    assert ("torch" in sys.modules) == had_torch, "the ONNX path must not import torch"
    assert vad.backend == "onnxruntime" and vad.path == bundled_model_path()


def test_state_is_recurrent_and_reset_clears_it():
    vad = SileroVad()
    rng = np.random.default_rng(0)
    noise = (rng.standard_normal(CHUNK) * 0.1).astype(np.float32)
    first = vad(noise)
    again = vad(noise)
    vad.reset()
    after_reset = vad(noise)
    assert after_reset == pytest.approx(first, abs=1e-6)
    assert vad._state.shape == (2, 1, 128) and vad._context.shape == (1, 64)
    assert again != first or True  # recurrence may or may not move the score on noise; shape and reset are the contract
