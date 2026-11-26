"""Emit synthetic results for a local rehearsal."""


def run_stub(inputs, params):
    frames = inputs["video"]["syntheticValues"]
    energy = sum(abs(b - a) for a, b in zip(frames, frames[1:], strict=False))
    return {"energy": {"syntheticMotionEnergy": energy * params["scale"]}}
