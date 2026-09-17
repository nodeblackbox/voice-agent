"""Smart Turn v3.2 (Pipecat) end-of-turn classifier on CPU via onnxruntime."""
from __future__ import annotations

from pathlib import Path

import numpy as np

from . import SR
from .whisper_features import compute_whisper_log_mel_features

WINDOW = 8 * SR
MODEL_FILE = "smart-turn-v3.2-cpu.onnx"


class SmartTurn:
    def __init__(self, models_dir: Path) -> None:
        import onnxruntime as ort

        path = models_dir / MODEL_FILE
        if not path.exists():
            raise FileNotFoundError(f"Smart Turn model missing: {path}")
        so = ort.SessionOptions()
        so.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        so.inter_op_num_threads = 1
        so.intra_op_num_threads = 4
        so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        self.sess = ort.InferenceSession(str(path), sess_options=so, providers=["CPUExecutionProvider"])

    def __call__(self, audio: np.ndarray) -> float:
        """Probability that the speaker has finished. audio: float32 16 kHz mono, any length (last 8 s used)."""
        a = audio[-WINDOW:] if len(audio) > WINDOW else np.pad(audio, (WINDOW - len(audio), 0))
        feats = compute_whisper_log_mel_features(a.astype(np.float32), do_normalize=True)
        out = self.sess.run(None, {"input_features": feats[None].astype(np.float32)})
        return float(np.asarray(out[0]).reshape(-1)[0])
