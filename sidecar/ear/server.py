from __future__ import annotations

import asyncio
import json
import logging
import socket
from typing import Any

from websockets.asyncio.server import Server, ServerConnection, serve
from websockets.exceptions import ConnectionClosed

from .pipeline import Pipeline

log = logging.getLogger("ear.server")


def handle_message(pipeline: Pipeline, raw: str) -> list[dict[str, Any]]:
    """Apply one client text message to the pipeline; returns the replies to send back."""
    try:
        msg = json.loads(raw)
    except json.JSONDecodeError:
        log.warning("bad JSON from client: %.80r", raw)
        return []
    if not isinstance(msg, dict):
        log.warning("client message is not an object: %.80r", raw)
        return []
    kind = msg.get("type")
    if kind == "config":
        pipeline.configure(msg.get("endpoint"), msg.get("stt"))
    elif kind == "agent_speaking":
        pipeline.set_agent_speaking(bool(msg.get("on")))
    elif kind == "agent_thinking":
        pipeline.set_agent_thinking(bool(msg.get("on")))
    elif kind == "mute":
        pipeline.set_muted(bool(msg.get("on")))
    elif kind == "reset":
        pipeline.reset()
    elif kind == "ping":
        return [{"type": "pong"}]
    else:
        log.warning("unknown command %r", kind)
    return []


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


class EarServer:
    def __init__(self, pipeline: Pipeline, out_q: asyncio.Queue[dict[str, Any]]) -> None:
        self.pipeline = pipeline
        self.out_q = out_q
        self.client: ServerConnection | None = None
        self._server: Server | None = None

    async def start(self, port: int) -> int:
        if port == 0:
            port = free_port()
        self._server = await serve(self._handler, "127.0.0.1", port, max_size=None, compression=None)
        return port

    async def serve_forever(self) -> None:
        assert self._server is not None
        await self._server.serve_forever()

    async def _handler(self, ws: ServerConnection) -> None:
        if self.client is not None:
            await ws.close(1013, "another client is connected")
            return
        self.client = ws
        log.info("client connected")
        while not self.out_q.empty():
            self.out_q.get_nowait()
        if self.pipeline.ready:
            self.out_q.put_nowait(self.pipeline.ready_event())
        else:
            self.out_q.put_nowait({"type": "status", "stage": self.pipeline.stage})
        sender = asyncio.create_task(self._sender(ws))
        try:
            async for message in ws:
                if isinstance(message, bytes):
                    self.pipeline.feed(message)
                else:
                    for reply in handle_message(self.pipeline, message):
                        self.out_q.put_nowait(reply)
        except ConnectionClosed:
            pass
        finally:
            sender.cancel()
            self.client = None
            self.pipeline.set_agent_speaking(False)
            self.pipeline.set_agent_thinking(False)
            self.pipeline.reset()
            log.info("client disconnected")

    async def _sender(self, ws: ServerConnection) -> None:
        while True:
            msg = await self.out_q.get()
            try:
                await ws.send(json.dumps(msg))
            except ConnectionClosed:
                return
