from __future__ import annotations

import argparse
import asyncio
import logging
import sys
from pathlib import Path
from typing import Any

from .asr import CudaUnavailable
from .config import EndpointConfig, SttConfig
from .pipeline import Pipeline
from .server import EarServer

log = logging.getLogger("ear")

EXIT_FATAL = 1
EXIT_NO_CUDA = 3
EXIT_ASR_BROKEN = 4


def parse_args(argv: list[str]) -> argparse.Namespace:
    ap = argparse.ArgumentParser(prog="ear", description="voice agent ear-sidecar (see PROTOCOL.md)")
    ap.add_argument("--port", type=int, default=0, help="0 = pick a free port")
    ap.add_argument("--models-dir", type=Path, default=Path(__file__).resolve().parent.parent.parent / "models")
    ap.add_argument("--stt-model", default=SttConfig.model)
    ap.add_argument("--stt-device", default=SttConfig.device, choices=("hybrid", "cuda", "cpu"))
    ap.add_argument("--log-level", default="INFO")
    return ap.parse_args(argv)


async def run(args: argparse.Namespace) -> int:
    loop = asyncio.get_running_loop()
    out_q: asyncio.Queue[dict[str, Any]] = asyncio.Queue()

    def emit(msg: dict[str, Any]) -> None:
        loop.call_soon_threadsafe(out_q.put_nowait, msg)

    pipeline = Pipeline(emit, args.models_dir, EndpointConfig(), SttConfig(args.stt_model, args.stt_device))
    fatal: asyncio.Future[int] = loop.create_future()

    def on_fatal(code: int) -> None:
        loop.call_soon_threadsafe(lambda: fatal.done() or fatal.set_result(code))

    pipeline.on_fatal = on_fatal
    server = EarServer(pipeline, out_q)
    port = await server.start(args.port)
    print(f"EAR_PORT {port}", flush=True)
    log.info("listening on ws://127.0.0.1:%d", port)

    try:
        await loop.run_in_executor(None, pipeline.load)
    except CudaUnavailable as exc:
        log.error("CUDA required but unavailable: %s", exc)
        emit({"type": "error", "message": str(exc), "fatal": True})
        await asyncio.sleep(0.2)
        return EXIT_NO_CUDA
    except Exception as exc:  # noqa: BLE001
        log.exception("model load failed")
        emit({"type": "error", "message": f"model load failed: {exc}", "fatal": True})
        await asyncio.sleep(0.2)
        return EXIT_FATAL

    serving = asyncio.ensure_future(server.serve_forever())
    done, _ = await asyncio.wait({serving, fatal}, return_when=asyncio.FIRST_COMPLETED)
    if fatal in done:
        code = fatal.result()
        log.error("fatal: exiting with code %d so the app restarts the ears", code)
        await asyncio.sleep(0.2)  # let the fatal error message drain to the client
        serving.cancel()
        return code
    return 0


def main(argv: list[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    logging.basicConfig(stream=sys.stderr, level=args.log_level.upper(),
                        format="%(asctime)s %(levelname)s %(name)s: %(message)s", datefmt="%H:%M:%S")
    try:
        return asyncio.run(run(args))
    except KeyboardInterrupt:
        return 0


if __name__ == "__main__":
    sys.exit(main())
