"""Parakeet via onnx-asr, with the CUDA provider verified rather than trusted.

ONNX Runtime silently rebuilds a session on CPU when a CUDA kernel fails; that turns a 50 ms decode into
a multi-second one with no error. Every session gets `disable_fallback()` and the active providers are
re-checked after warm-up so a broken driver stack is a loud failure, not a slow one.
"""
from __future__ import annotations

import logging
import os
import time
from pathlib import Path

import numpy as np

log = logging.getLogger("ear.asr")

_INT8_REPOS = {
    "nemo-parakeet-tdt-0.6b-v2": "istupakov/parakeet-tdt-0.6b-v2-onnx",
    "nemo-parakeet-tdt-0.6b-v3": "istupakov/parakeet-tdt-0.6b-v3-onnx",
}


class CudaUnavailable(RuntimeError):
    pass


class Parakeet:
    def __init__(self, model_name: str, device: str) -> None:
        import onnx_asr
        import onnxruntime as ort

        self.model_name = model_name
        self.device = device
        wants_cuda = device in ("cuda", "hybrid")
        if wants_cuda:
            if hasattr(ort, "preload_dlls"):
                ort.preload_dlls()
            avail = ort.get_available_providers()
            if "CUDAExecutionProvider" not in avail:
                raise CudaUnavailable(f"CUDAExecutionProvider not available (providers: {avail})")
            providers = [("CUDAExecutionProvider", {"device_id": 0}), "CPUExecutionProvider"]
        else:
            providers = ["CPUExecutionProvider"]

        t0 = time.perf_counter()
        self.model = onnx_asr.load_model(model_name, providers=providers)
        if device == "hybrid":
            self._move_decoder_to_cpu(int8=os.environ.get("HYBRID_DEC_INT8", "1") == "1")
        for sess in self._sessions():
            sess.disable_fallback()
        self.load_s = time.perf_counter() - t0
        self.providers = self._active_providers()
        if wants_cuda and not any("CUDA" in p for p in self.providers):
            raise CudaUnavailable(f"model loaded but CUDA is not active (active: {self.providers})")

    def recognize(self, audio: np.ndarray) -> str:
        return str(self.model.recognize(audio)).strip()

    def warm_up(self) -> None:
        self.recognize(np.zeros(16000, dtype=np.float32))
        self.providers = self._active_providers()
        if self.device in ("cuda", "hybrid") and not any("CUDA" in p for p in self.providers):
            raise CudaUnavailable(f"CUDA dropped after first inference (active: {self.providers})")

    def _move_decoder_to_cpu(self, int8: bool) -> None:
        """The transducer decoder runs once per encoder frame with tiny tensors: launch-bound on GPU,
        ~0.2 ms/frame as int8 on CPU."""
        import onnxruntime as ort

        asr = self.model.asr
        sess = getattr(asr, "_decoder_joint", None)
        if sess is None:
            log.warning("no _decoder_joint session on %s; hybrid mode has no effect", self.model_name)
            return
        path = Path(sess._model_path)
        if int8:
            cand = path.with_name(path.name.replace(".onnx", ".int8.onnx"))
            if not cand.exists():
                repo = _INT8_REPOS.get(self.model_name)
                if repo:
                    try:
                        from huggingface_hub import hf_hub_download

                        cand = Path(hf_hub_download(repo, cand.name))
                    except Exception as exc:  # noqa: BLE001
                        log.warning("int8 decoder unavailable (%s); using fp32 decoder on CPU", exc)
                        cand = path
                else:
                    cand = path
            path = cand
        so = ort.SessionOptions()
        so.intra_op_num_threads = int(os.environ.get("HYBRID_DEC_THREADS", "0"))
        so.inter_op_num_threads = 1
        asr._decoder_joint = ort.InferenceSession(str(path), sess_options=so, providers=["CPUExecutionProvider"])
        asr._decoder_joint_path = str(path)

    def _sessions(self) -> list:
        import onnxruntime as ort

        found, stack, visited = [], [self.model], set()
        while stack:
            obj = stack.pop()
            if id(obj) in visited:
                continue
            visited.add(id(obj))
            if isinstance(obj, ort.InferenceSession):
                found.append(obj)
                continue
            for attr in getattr(obj, "__dict__", {}).values():
                if hasattr(attr, "__dict__") or isinstance(attr, ort.InferenceSession):
                    stack.append(attr)
        return found

    def _active_providers(self) -> list[str]:
        seen: set[str] = set()
        for s in self._sessions():
            seen.update(s.get_providers())
        return sorted(seen)
