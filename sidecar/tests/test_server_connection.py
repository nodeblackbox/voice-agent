"""The websocket handler end to end with a fake pipeline: binary frames are fed, text frames are dispatched,
replies flow back, and a second client is refused."""
from __future__ import annotations

import asyncio
import json

import pytest
from websockets.asyncio.client import connect

from ear.server import EarServer
from tests.test_server_protocol import FakePipeline


class FeedingPipeline(FakePipeline):
    ready = False
    stage = "loading_asr"

    def __init__(self) -> None:
        super().__init__()
        self.fed: list[bytes] = []

    def feed(self, pcm: bytes) -> None:
        self.fed.append(pcm)


def run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


def test_binary_frames_are_fed_and_text_frames_answered():
    async def scenario() -> None:
        pipeline = FeedingPipeline()
        out_q: asyncio.Queue = asyncio.Queue()
        server = EarServer(pipeline, out_q)  # type: ignore[arg-type]
        port = await server.start(0)
        async with connect(f"ws://127.0.0.1:{port}/") as ws:
            first = json.loads(await ws.recv())
            assert first == {"type": "status", "stage": "loading_asr"}
            await ws.send(b"\x00\x01" * 512)
            await ws.send(json.dumps({"type": "ping"}))
            assert json.loads(await asyncio.wait_for(ws.recv(), 2)) == {"type": "pong"}
            await ws.send(json.dumps({"type": "agent_speaking", "on": True}))
            out_q.put_nowait({"type": "level", "p": 0.5})
            assert json.loads(await asyncio.wait_for(ws.recv(), 2)) == {"type": "level", "p": 0.5}
        await asyncio.sleep(0.05)
        assert pipeline.fed == [b"\x00\x01" * 512]
        assert ("agent_speaking", True) in pipeline.calls
        # disconnect clears agent flags and resets the pipeline
        assert pipeline.calls[-3:] == [("agent_speaking", False), ("agent_thinking", False), ("reset", None)]
        server._server.close()  # type: ignore[union-attr]
        await server._server.wait_closed()  # type: ignore[union-attr]

    run(scenario())


def test_second_client_is_refused():
    async def scenario() -> None:
        pipeline = FeedingPipeline()
        server = EarServer(pipeline, asyncio.Queue())  # type: ignore[arg-type]
        port = await server.start(0)
        async with connect(f"ws://127.0.0.1:{port}/") as first:
            await first.recv()
            async with connect(f"ws://127.0.0.1:{port}/") as second:
                with pytest.raises(Exception):
                    await asyncio.wait_for(second.recv(), 2)
                assert second.close_code == 1013
        server._server.close()  # type: ignore[union-attr]
        await server._server.wait_closed()  # type: ignore[union-attr]

    run(scenario())
