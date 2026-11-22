"""Deterministic stub predictor (no model) that emits consistent global events so stitching succeeds."""

import json

from flora_runtime.video_segmentation.fine_temporal import TICK_US

from ..config import MODELS  # noqa: F401


def make_stub(period_s=7.0, length_s=5.0, fail_windows=(), calls=None):
    def infer(window, frames):
        if calls is not None:
            calls.append(window.window_index)
        if window.window_index in fail_windows:
            raise RuntimeError("injected failure")
        assert len(frames) == 64
        off = window.global_tick_offset
        vs, ve = window.valid_start_tick, window.valid_end_tick
        rows = []
        n = 0
        while True:
            gs = round(n * period_s * 1e6 / TICK_US)
            ge = gs + round(length_s * 1e6 / TICK_US)
            n += 1
            if gs - off >= ve:
                break
            s, e = gs - off, ge - off
            if e <= vs:
                continue
            lo, ro = s < vs, e > ve
            rows.append(dict(s=max(s, vs), e=min(e, ve), lo=lo, ro=ro))
        rows.sort(key=lambda r: (r["s"], r["e"], r["lo"], r["ro"]))
        return json.dumps(
            {
                "segments": [
                    dict(s=r["s"], e=r["e"], lo=r["lo"], ro=r["ro"]) for r in rows
                ]
            }
        )

    return infer
