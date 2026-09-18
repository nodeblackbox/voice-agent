from __future__ import annotations

import re
from dataclasses import fields
from pathlib import Path

import pytest

from ear.config import EndpointConfig, SttConfig, _snake

PROTOCOL = Path(__file__).resolve().parent.parent / "PROTOCOL.md"


def test_camel_case_keys_map_to_fields():
    cfg = EndpointConfig()
    ignored = cfg.update({"minSilenceMs": 400, "turnHighThreshold": 0.95, "bargeInReleaseChunks": 9})
    assert ignored == []
    assert (cfg.min_silence_ms, cfg.turn_high_threshold, cfg.barge_in_release_chunks) == (400, 0.95, 9)


def test_unknown_and_null_keys_are_ignored_and_reported():
    cfg = EndpointConfig()
    ignored = cfg.update({"noSuchKey": 1, "minSilenceMs": None, "vadThreshold": 0.6})
    assert sorted(ignored) == ["minSilenceMs", "noSuchKey"]
    assert cfg.min_silence_ms == 250
    assert cfg.vad_threshold == 0.6


def test_partial_update_keeps_other_values():
    cfg = EndpointConfig(max_silence_ms=900)
    cfg.update({"checkEveryMs": 100})
    assert cfg.max_silence_ms == 900
    assert cfg.check_every_ms == 100


def test_values_are_coerced_to_field_type():
    cfg = EndpointConfig()
    cfg.update({"bargeInChunks": 12.0, "vadThreshold": 1})
    assert cfg.barge_in_chunks == 12 and isinstance(cfg.barge_in_chunks, int)
    assert cfg.vad_threshold == 1.0 and isinstance(cfg.vad_threshold, float)


def test_defaults_match_protocol_md():
    doc = PROTOCOL.read_text(encoding="utf-8")
    documented = {_snake(k): v for k, v in re.findall(r"`(\w+)` \((\d[\d.]*|true|false|see below)\)", doc)}
    cfg = EndpointConfig()
    assert documented, "PROTOCOL.md should list endpoint defaults as `name` (value)"
    for name, value in documented.items():
        current = getattr(cfg, name)
        if isinstance(current, bool):
            assert value.lower() == str(current).lower(), name
        elif isinstance(current, str):
            continue  # free text, documented in prose
        else:
            assert float(current) == float(value), name
    # every tunable the sidecar accepts must be documented, not only the documented ones checked
    undocumented = {f.name for f in fields(EndpointConfig)} - set(documented)
    assert not undocumented, f"PROTOCOL.md is missing endpoint fields: {sorted(undocumented)}"


def test_text_and_bool_fields_are_coerced():
    cfg = EndpointConfig()
    cfg.update({"fillerWords": "um, so, then", "fillerHoldsHighTier": "false"})
    assert cfg.filler_set() == {"um", "so", "then"}
    assert cfg.filler_holds_high_tier is False
    cfg.update({"fillerHoldsHighTier": True})
    assert cfg.filler_holds_high_tier is True


@pytest.mark.parametrize("camel, snake", [("vadThreshold", "vad_threshold"), ("bargeInDecay", "barge_in_decay"), ("x", "x")])
def test_snake(camel, snake):
    assert _snake(camel) == snake


def test_stt_config_update_validates_device():
    stt = SttConfig()
    stt.update({"model": "nemo-parakeet-tdt-0.6b-v3", "device": "cpu"})
    assert (stt.model, stt.device) == ("nemo-parakeet-tdt-0.6b-v3", "cpu")
    stt.update({"device": "tpu", "model": 5})
    assert (stt.model, stt.device) == ("nemo-parakeet-tdt-0.6b-v3", "cpu")
