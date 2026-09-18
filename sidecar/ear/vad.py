from __future__ import annotations

import numpy as np

from . import SR


class SileroVad:
    """Silero VAD on onnxruntime.

    The ONNX build is used deliberately: onnxruntime is already loaded for Parakeet and Smart
    Turn, whereas the torch build pulls a second ~1 GB runtime into the process purely to score
    32 ms frames. Falls back to the torch build only if the ONNX one is unavailable.
    """

    def __init__(self, onnx: bool = True) -> None:
        from silero_vad import load_silero_vad

        self._torch = None
        try:
            self.model = load_silero_vad(onnx=onnx)
            self.onnx = onnx
        except Exception:
            import torch

            self._torch = torch
            torch.set_num_threads(1)
            self.model = load_silero_vad()
            self.onnx = False

    def __call__(self, chunk: np.ndarray) -> float:
        import torch
        
        # Convert numpy array to torch tensor for both ONNX and torch backends
        # The silero_vad library expects a torch tensor in _validate_input
        tensor_chunk = torch.from_numpy(chunk)
        return float(self.model(tensor_chunk, SR).item())

    def reset(self) -> None:
        self.model.reset_states()
