"""Silero VAD (v5) on onnxruntime, numpy in and out.

onnxruntime is already loaded for Parakeet and Smart Turn; the `silero_vad` package's own wrapper
insists on torch tensors, which would pull a second ~1 GB runtime into the process and build a
tensor per 32 ms frame. This wrapper runs the same ONNX file from that package directly. The model
keeps a (2, 1, 128) recurrent state and needs the last 64 samples of the previous frame prepended.
"""
from __future__ import annotations

from pathlib import Path

import numpy as np

from . import SR

CONTEXT = 64
MODEL_FILE = "silero_vad.onnx"


def bundled_model_path() -> Path:
    try:
        from importlib.resources import files

        return Path(str(files("silero_vad") / "data" / MODEL_FILE))
    except (ImportError, ModuleNotFoundError) as exc:  # pragma: no cover - depends on the environment
        raise FileNotFoundError("silero-vad is not installed (pip install silero-vad)") from exc


class SileroVad:
    backend = "onnxruntime"

    def __init__(self, model_path: Path | None = None) -> None:
        import onnxruntime as ort

        path = model_path or bundled_model_path()
        if not path.exists():
            raise FileNotFoundError(f"Silero VAD model missing: {path}")
        self.path = path
        opts = ort.SessionOptions()
        opts.inter_op_num_threads = 1
        opts.intra_op_num_threads = 1
        self.sess = ort.InferenceSession(str(path), sess_options=opts, providers=["CPUExecutionProvider"])
        self._sr = np.array(SR, dtype=np.int64)
        self.reset()

    def reset(self) -> None:
        self._state = np.zeros((2, 1, 128), dtype=np.float32)
        self._context = np.zeros((1, CONTEXT), dtype=np.float32)

    def __call__(self, chunk: np.ndarray) -> float:
        x = np.concatenate([self._context, np.asarray(chunk, dtype=np.float32).reshape(1, -1)], axis=1)
        out, state = self.sess.run(None, {"input": x, "state": self._state, "sr": self._sr})
        self._state = state
        self._context = x[:, -CONTEXT:]
        return float(np.asarray(out).reshape(-1)[0])
