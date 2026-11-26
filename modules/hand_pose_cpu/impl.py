"""Emit synthetic results for a local rehearsal."""


def run_stub(inputs, params):
    return {"poses": {"fixture": True, "windowIndex": inputs["video"]["index"]}}
