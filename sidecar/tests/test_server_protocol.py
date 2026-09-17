from __future__ import annotations

import json
from typing import Any

from ear.server import handle_message


class FakePipeline:
    def __init__(self) -> None:
        self.calls: list[tuple[str, Any]] = []
        self.agent_speaking = False
        self.agent_thinking = False
        self.muted = False

    def configure(self, endpoint, stt) -> None:
        self.calls.append(("configure", (endpoint, stt)))

    def set_agent_speaking(self, on: bool) -> None:
        self.agent_speaking = on
        self.calls.append(("agent_speaking", on))

    def set_agent_thinking(self, on: bool) -> None:
        self.agent_thinking = on
        self.calls.append(("agent_thinking", on))

    def set_muted(self, on: bool) -> None:
        self.muted = on
        self.calls.append(("mute", on))

    def reset(self) -> None:
        self.calls.append(("reset", None))


def send(p: FakePipeline, msg: dict[str, Any]) -> list[dict[str, Any]]:
    return handle_message(p, json.dumps(msg))  # type: ignore[arg-type]


def test_config_forwards_endpoint_and_stt():
    p = FakePipeline()
    assert send(p, {"type": "config", "endpoint": {"minSilenceMs": 300}, "stt": {"device": "cpu"}}) == []
    assert p.calls == [("configure", ({"minSilenceMs": 300}, {"device": "cpu"}))]


def test_config_without_sections_passes_none():
    p = FakePipeline()
    send(p, {"type": "config"})
    assert p.calls == [("configure", (None, None))]


def test_agent_flags_and_mute_are_coerced_to_bool():
    p = FakePipeline()
    send(p, {"type": "agent_speaking", "on": 1})
    send(p, {"type": "agent_thinking", "on": "yes"})
    send(p, {"type": "mute", "on": 0})
    assert p.agent_speaking is True and p.agent_thinking is True and p.muted is False
    send(p, {"type": "agent_speaking"})
    assert p.agent_speaking is False


def test_reset_and_ping():
    p = FakePipeline()
    assert send(p, {"type": "reset"}) == []
    assert p.calls == [("reset", None)]
    assert send(p, {"type": "ping"}) == [{"type": "pong"}]


def test_bad_json_and_unknown_commands_are_ignored():
    p = FakePipeline()
    assert handle_message(p, "{not json")  == []  # type: ignore[arg-type]
    assert handle_message(p, "[1, 2]") == []  # type: ignore[arg-type]
    assert send(p, {"type": "teleport"}) == []
    assert p.calls == []
