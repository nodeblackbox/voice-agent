from __future__ import annotations

import numpy as np
import pytest

from ear.whisper_features import compute_whisper_log_mel_features

SR = 16000


def tone(seconds: float, hz: float = 440.0) -> np.ndarray:
    t = np.arange(int(SR * seconds)) / SR
    return (0.3 * np.sin(2 * np.pi * hz * t)).astype(np.float32)


def test_shape_and_dtype():
    feats = compute_whisper_log_mel_features(tone(8))
    assert feats.shape == (80, 800)
    assert feats.dtype == np.float32


def test_short_input_is_padded_and_long_input_truncated():
    assert compute_whisper_log_mel_features(tone(1)).shape == (80, 800)
    assert compute_whisper_log_mel_features(tone(12)).shape == (80, 800)


def test_deterministic():
    a = compute_whisper_log_mel_features(tone(3))
    b = compute_whisper_log_mel_features(tone(3))
    np.testing.assert_array_equal(a, b)


def test_silence_is_finite_and_bounded():
    feats = compute_whisper_log_mel_features(np.zeros(SR * 8, dtype=np.float32))
    assert np.isfinite(feats).all()
    assert feats.max() <= 1.0 + 1e-6


def test_dynamic_range_is_clamped_to_8_db_below_peak():
    feats = compute_whisper_log_mel_features(tone(8))
    # log_spec is floored at (max - 8) before the (x + 4) / 4 rescale, so the spread is exactly 2.0
    assert feats.max() - feats.min() == pytest.approx(2.0, abs=1e-5)


def test_tone_energy_lands_in_the_right_mel_band():
    low = compute_whisper_log_mel_features(tone(8, 200.0))
    high = compute_whisper_log_mel_features(tone(8, 4000.0))
    assert low.mean(axis=1).argmax() < high.mean(axis=1).argmax()


def test_normalisation_makes_gain_irrelevant():
    quiet = compute_whisper_log_mel_features(tone(8) * 0.25, do_normalize=True)
    loud = compute_whisper_log_mel_features(tone(8) * 1.0, do_normalize=True)
    np.testing.assert_allclose(quiet, loud, atol=2e-3)


def test_no_normalisation_keeps_gain():
    quiet = compute_whisper_log_mel_features(tone(8) * 0.25, do_normalize=False)
    loud = compute_whisper_log_mel_features(tone(8) * 1.0, do_normalize=False)
    assert not np.allclose(quiet, loud, atol=1e-2)


def test_rejects_non_1d_input():
    with pytest.raises(ValueError):
        compute_whisper_log_mel_features(np.zeros((2, SR), dtype=np.float32))
