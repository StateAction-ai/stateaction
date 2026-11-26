"""Emit synthetic results for a local rehearsal."""


def run_stub(inputs, params):
    return {
        "captions": {
            "fixture": True,
            "segmentWindowIndex": inputs["segments"]["windowIndex"],
            "prompt": params["prompt"],
        }
    }
