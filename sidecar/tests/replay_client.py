"""Replay a wav into a running ear-sidecar and print every event.

    python tests/replay_client.py --port 1234 utterance.wav [--bargein interrupt.wav] [--fast]

Streams int16 16 kHz frames at real time (32 ms per frame) unless --fast. After the first `final`,
with --bargein it flags `agent_speaking on` and streams the second file, expecting `bargein cut` and a
second `final`.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import sys
import time
from pathlib import Path

import numpy as np
from websockets.asyncio.client import connect

SR = 16000
CHUNK = 512


def load_wav_16k(path: Path) -> np.ndarray:
    import soundfile as sf

    data, sr = sf.read(str(path), dtype="float32", always_2d=True)
    data = data.mean(axis=1)
    if sr != SR:
        n = int(np.ceil(len(data) * SR / sr))
        data = np.interp(np.linspace(0, len(data) - 1, n), np.arange(len(data)), data).astype(np.float32)
    return data


def to_pcm(audio: np.ndarray) -> bytes:
    return (np.clip(audio, -1, 1) * 32767).astype("<i2").tobytes()


class Replay:
    def __init__(self, ws, fast: bool) -> None:
        self.ws = ws
        self.fast = fast
        self.t0 = time.perf_counter()
        self.finals: list[dict] = []
        self.bargein_stages: list[str] = []
        self.ready = asyncio.Event()
        self.t_speech_end: float | None = None
        self.final_latencies: list[float] = []

    def log(self, msg: str) -> None:
        print(f"[{time.perf_counter() - self.t0:7.3f}s] {msg}", flush=True)

    async def reader(self) -> None:
        async for raw in self.ws:
            ev = json.loads(raw)
            kind = ev.get("type")
            if kind == "level":
                continue
            if kind == "ready":
                self.ready.set()
            elif kind == "speech_end":
                self.t_speech_end = time.perf_counter()
            elif kind == "final":
                if self.t_speech_end is not None:
                    self.final_latencies.append((time.perf_counter() - self.t_speech_end) * 1e3)
                self.finals.append(ev)
            elif kind == "bargein":
                self.bargein_stages.append(ev["stage"])
            self.log(json.dumps(ev))

    async def stream(self, audio: np.ndarray, trailing_silence_s: float = 1.6) -> None:
        pcm = np.concatenate([audio, np.zeros(int(SR * trailing_silence_s), dtype=np.float32)])
        start = time.perf_counter()
        for n, i in enumerate(range(0, len(pcm), CHUNK), 1):
            await self.ws.send(to_pcm(pcm[i:i + CHUNK]))
            if not self.fast:
                # pace against an absolute deadline: Windows timers are ~15 ms coarse, so per-frame sleeps drift
                await asyncio.sleep(max(0.0, start + n * CHUNK / SR - time.perf_counter()))
        if self.fast:
            await asyncio.sleep(0.05)

    async def wait_finals(self, n: int, timeout: float) -> bool:
        deadline = time.perf_counter() + timeout
        while len(self.finals) < n and time.perf_counter() < deadline:
            await asyncio.sleep(0.05)
        return len(self.finals) >= n


async def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("wav", type=Path)
    ap.add_argument("--port", type=int, required=True)
    ap.add_argument("--bargein", type=Path)
    ap.add_argument("--fast", action="store_true")
    ap.add_argument("--wait-ready", type=float, default=180)
    args = ap.parse_args()

    first = load_wav_16k(args.wav)
    second = load_wav_16k(args.bargein) if args.bargein else None

    async with connect(f"ws://127.0.0.1:{args.port}/", max_size=None) as ws:
        r = Replay(ws, args.fast)
        reader = asyncio.create_task(r.reader())
        await ws.send(json.dumps({"type": "config", "endpoint": {}}))
        r.log("waiting for ready")
        try:
            await asyncio.wait_for(r.ready.wait(), timeout=args.wait_ready)
        except asyncio.TimeoutError:
            r.log("sidecar never became ready")
            return 2

        r.log(f"streaming {args.wav.name} ({len(first) / SR:.2f}s)")
        await r.stream(first)
        ok = await r.wait_finals(1, timeout=10)
        if not ok:
            r.log("FAIL: no final for first file")
            return 1

        if second is not None:
            r.log("agent_speaking on; streaming barge-in file")
            await ws.send(json.dumps({"type": "agent_speaking", "on": True}))
            await asyncio.sleep(0.2)
            await r.stream(second)
            ok = await r.wait_finals(2, timeout=10)
            await ws.send(json.dumps({"type": "agent_speaking", "on": False}))
            if "cut" not in r.bargein_stages:
                r.log(f"FAIL: no bargein cut (stages seen: {r.bargein_stages})")
                return 1
            if not ok:
                r.log("FAIL: no final after barge-in")
                return 1

        reader.cancel()
        print()
        for i, f in enumerate(r.finals, 1):
            print(f"final {i}: {f['text']!r}  (audio {f['durationMs']} ms, asr {f['asrMs']} ms, reason {f['reason']})")
        if r.final_latencies:
            print("speech_end -> final latency ms:", [round(x) for x in r.final_latencies])
        if r.bargein_stages:
            print("bargein stages:", r.bargein_stages)
        return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
