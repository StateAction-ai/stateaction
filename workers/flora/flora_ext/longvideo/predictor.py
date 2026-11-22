"""Checkpointed, cache-fed predictor with per-window failure isolation."""

import time

from .. import bootstrap
from ..preprocessing import instruction_suffix
from .checkpoint import Checkpoint, sha256_json, sha256_text

a = bootstrap.production


class WindowFailed(RuntimeError):
    def __init__(self, code, detail=""):
        super().__init__(f"{code}: {detail}")
        self.code, self.detail = code, detail


def error_code(exc):
    name = type(exc).__name__
    if isinstance(exc, WindowFailed):
        return exc.code
    if name == "OutOfMemoryError":
        return "cuda_oom"
    if name == "InputErrorForModel":
        return "generation_incomplete"
    if name == "FinePredictionParseError":
        return "prediction_parse_error"
    return "unexpected_error"


class CachedPredictor:
    """`infer(window, frames) -> str` produces raw model text (real model or a stub)."""

    def __init__(
        self,
        video,
        source,
        pool,
        bound,
        cache,
        checkpoint,
        infer,
        instruction="",
        retry_failed=True,
        progress=None,
    ):
        self.video, self.source, self.pool, self.bound = video, source, pool, bound
        self.cache, self.ckpt, self.infer = cache, checkpoint, infer
        self.instruction, self.retry_failed = instruction, retry_failed
        self.pts = list(video.pts_us)
        self.progress = progress or (lambda *_: None)
        self.stats = dict(model_s=0.0, read_s=0.0, reused=0, computed=0, failed=0)
        self.calls = 0

    def window_row(self, window):
        t0 = time.monotonic()
        plan = a.temporal_frame_plan(window, self.pts)
        indices = plan["source_frame_indices"]
        prompt = a.temporal_prompt(window, self.pool) + instruction_suffix(
            self.instruction
        )
        payload = window.worker_payload()
        key = Checkpoint.key(
            self.video.sha256,
            window.scope_id,
            sha256_text(prompt),
            sha256_json([payload, indices, self.cache.pixel_digest(indices)]),
        )
        row = self.ckpt.get(key)
        read_s = time.monotonic() - t0
        self.stats["read_s"] += read_s
        if row is not None and (row["status"] == "ok" or not self.retry_failed):
            self.stats["reused"] += 1
            return row
        base = dict(
            source_sha256=key[0],
            window_id=key[1],
            prompt_sha256=key[2],
            input_digest=key[3],
            window_index=window.window_index,
            core_start_us=window.core_start_us,
            core_end_us=window.core_end_us,
            source_frame_indices=indices,
        )
        t1 = time.monotonic()
        try:
            frames = [self.cache.get(i) for i in indices]
            text = self.infer(window, frames)
            if not isinstance(text, str) or not text.strip():
                raise WindowFailed("empty_output", "model returned no text")
            try:  # must parse under the vendor rules or the window is not usable
                a_parse = bootstrap_parse()
                a_parse(text, window, drop_guard_only=True)
            except Exception as exc:
                raise WindowFailed("prediction_parse_error", str(exc)[:300]) from exc
            row = dict(
                base,
                status="ok",
                prediction_json=text,
                error_code=None,
                error_detail=None,
            )
        except Exception as exc:  # isolation: record, never turn into an empty result
            if type(exc).__name__ == "OutOfMemoryError":
                try:
                    import torch

                    torch.cuda.empty_cache()
                except Exception:
                    pass
            row = dict(
                base,
                status="failed",
                prediction_json=None,
                error_code=error_code(exc),
                error_detail=str(exc)[:500],
            )
            self.stats["failed"] += 1
        elapsed = time.monotonic() - t1
        row["elapsed_s"] = round(elapsed, 4)
        self.stats["model_s"] += elapsed
        self.stats["computed"] += 1
        self.ckpt.put(row)
        return row

    def predict(self, request):
        from flora_runtime.video_segmentation.fine_subtask import FINE_RESPONSE_SCHEMA

        if (
            request["source"]["source_id"] != self.source.source_id
            or request["model_binding"] != self.bound
        ):
            raise RuntimeError("Production request binding changed")
        predictions = []
        for payload in request["windows"]:
            window = a.window_from_payload(payload, self.source)
            row = self.window_row(window)
            self.calls += 1
            if row["status"] != "ok":
                raise WindowFailed(
                    row["error_code"], f"window {window.window_index} failed"
                )
            predictions.append(
                dict(scope_id=window.scope_id, prediction_json=row["prediction_json"])
            )
        return dict(
            schema_version=FINE_RESPONSE_SCHEMA,
            source_id=self.source.source_id,
            model_io_contract=self.bound["model_io_contract"],
            model_binding=self.bound,
            predictions=predictions,
        )


def bootstrap_parse():
    from flora_runtime.video_segmentation.fine_temporal import (
        parse_prediction_with_diagnostics,
    )

    return parse_prediction_with_diagnostics
