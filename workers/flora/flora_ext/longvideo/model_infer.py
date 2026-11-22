"""Real-model infer callable: reference `temporal_inputs` + reference `generate` (batch 1, greedy)."""

import time

from ..models import Session, generate
from ..preprocessing import temporal_inputs


class ModelInfer:
    def __init__(self, pool="human", instruction=""):
        import torch

        self.torch, self.pool, self.instruction = torch, pool, instruction
        t = time.monotonic()
        self.session = Session()
        self.model, self.proc = self.session.load("tempseg")
        self.load_s = time.monotonic() - t
        self.gpu_s = 0.0
        self.windows = 0
        torch.cuda.reset_peak_memory_stats()

    def __call__(self, window, frames):
        torch = self.torch
        inputs, _ = temporal_inputs(
            frames, window, self.pool, self.proc, ["main"], self.instruction
        )
        torch.cuda.synchronize()
        t = time.monotonic()
        try:
            return generate(self.model, self.proc, inputs, 1024)
        finally:
            torch.cuda.synchronize()
            self.gpu_s += time.monotonic() - t
            self.windows += 1

    def stats(self):
        t = self.torch
        return dict(
            model_load_s=round(self.load_s, 2),
            generate_s=round(self.gpu_s, 2),
            windows_generated=self.windows,
            peak_gpu_allocated_gib=round(t.cuda.max_memory_allocated() / 1024**3, 2),
            peak_gpu_reserved_gib=round(t.cuda.max_memory_reserved() / 1024**3, 2),
        )
