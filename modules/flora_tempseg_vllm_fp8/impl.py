"""Emit synthetic results for a local rehearsal."""


def run_stub(inputs, params):
    return {"segments": {"fixture": True, "windowIndex": inputs["video"]["index"]}}
