"""Kokoro-82M as a local fallback voice: POST /synth {text, voice, speed} -> audio/wav (24 kHz mono).

Started by the app only when Edge TTS is unreachable (or Kokoro is picked as the engine). Prints
`MOUTH_PORT <n>` once the model is loaded and warm, and exits when its stdin closes (parent gone).
"""
from __future__ import annotations

import argparse
import io
import json
import logging
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np

log = logging.getLogger("mouth")

SR = 24000
REPO = "hexgrad/Kokoro-82M"


class Kokoro:
    def __init__(self, device: str, voice: str) -> None:
        import torch
        from kokoro import KModel, KPipeline

        self.torch = torch
        if device == "cuda" and not torch.cuda.is_available():
            log.warning("CUDA unavailable, running Kokoro on CPU")
            device = "cpu"
        self.device = device
        self.model = KModel(repo_id=REPO).to(device).eval()
        self.KPipeline = KPipeline
        self.pipelines: dict[str, object] = {}
        self.lock = threading.Lock()
        self.synth("Warm up.", voice, 1.0)

    def pipeline(self, voice: str):
        lang = voice[0]  # 'a' American, 'b' British, ...
        p = self.pipelines.get(lang)
        if p is None:
            p = self.KPipeline(lang_code=lang, model=self.model, repo_id=REPO)
            self.pipelines[lang] = p
        return p

    def synth(self, text: str, voice: str, speed: float) -> np.ndarray:
        with self.lock, self.torch.inference_mode():
            parts = [r.audio.detach().float().cpu().numpy() for r in self.pipeline(voice)(text, voice=voice, speed=speed, split_pattern=r"\n+") if r.audio is not None]
        return np.concatenate(parts).astype(np.float32) if parts else np.zeros(0, dtype=np.float32)


def wav_bytes(audio: np.ndarray) -> bytes:
    import soundfile as sf

    buf = io.BytesIO()
    sf.write(buf, audio, SR, format="WAV", subtype="PCM_16")
    return buf.getvalue()


def make_handler(tts: Kokoro, default_voice: str):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args) -> None:  # keep stderr for real logs
            pass

        def _reply(self, code: int, body: bytes, ctype: str) -> None:
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self) -> None:
            if self.path == "/health":
                self._reply(200, json.dumps({"ok": True, "device": tts.device}).encode(), "application/json")
            else:
                self._reply(404, b"", "text/plain")

        def do_POST(self) -> None:
            if self.path != "/synth":
                self._reply(404, b"", "text/plain")
                return
            try:
                req = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))) or b"{}")
                text = str(req.get("text", "")).strip()
                voice = str(req.get("voice") or default_voice)
                speed = float(req.get("speed", 1.0))
                if not text:
                    self._reply(400, b"empty text", "text/plain")
                    return
                t0 = time.perf_counter()
                audio = tts.synth(text, voice, speed)
                log.info("synth %d chars -> %.2fs audio in %.0f ms", len(text), len(audio) / SR, (time.perf_counter() - t0) * 1e3)
                self._reply(200, wav_bytes(audio), "audio/wav")
            except Exception as exc:  # noqa: BLE001
                log.exception("synth failed")
                self._reply(500, str(exc).encode(), "text/plain")

    return Handler


def go_offline_if_cached(voice: str) -> None:
    """Edge failing often means the network is down; don't let Hugging Face lookups stall the load."""
    if os.environ.get("HF_HUB_OFFLINE"):
        return
    home = os.environ.get("HF_HUB_CACHE") or os.path.join(os.environ.get("HF_HOME") or os.path.join(os.path.expanduser("~"), ".cache", "huggingface"), "hub")
    snapshots = os.path.join(home, "models--" + REPO.replace("/", "--"), "snapshots")
    try:
        for snap in os.listdir(snapshots):
            base = os.path.join(snapshots, snap)
            if os.path.exists(os.path.join(base, "kokoro-v1_0.pth")) and os.path.exists(os.path.join(base, "voices", f"{voice}.pt")):
                os.environ["HF_HUB_OFFLINE"] = "1"
                return
    except OSError:
        pass


def exit_when_parent_goes() -> None:
    try:
        while sys.stdin.read(1024):
            pass
    except Exception:  # noqa: BLE001
        pass
    os._exit(0)


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(prog="mouth", description="Kokoro fallback TTS server")
    ap.add_argument("--port", type=int, default=0)
    ap.add_argument("--device", default="cuda", choices=("cuda", "cpu"))
    ap.add_argument("--voice", default="af_heart")
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, stream=sys.stderr, format="%(levelname)s %(name)s: %(message)s")

    threading.Thread(target=exit_when_parent_goes, daemon=True).start()
    go_offline_if_cached(args.voice)
    t0 = time.perf_counter()
    try:
        tts = Kokoro(args.device, args.voice)
    except Exception:  # noqa: BLE001
        log.exception("Kokoro failed to load")
        return 1
    server = ThreadingHTTPServer(("127.0.0.1", args.port), make_handler(tts, args.voice))
    log.info("ready on %s in %.1fs", tts.device, time.perf_counter() - t0)
    print(f"MOUTH_PORT {server.server_address[1]}", flush=True)
    server.serve_forever()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
