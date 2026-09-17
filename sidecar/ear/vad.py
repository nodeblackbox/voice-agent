from __future__ import annotations

import numpy as np

from . import SR


class SileroVad:
    def __init__(self) -> None:
        import torch
        from silero_vad import load_silero_vad

        self._torch = torch
        self.model = load_silero_vad()
        torch.set_num_threads(1)

    def __call__(self, chunk: np.ndarray) -> float:
        return float(self.model(self._torch.from_numpy(chunk), SR).item())

    def reset(self) -> None:
        self.model.reset_states()
