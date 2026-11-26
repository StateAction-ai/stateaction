"""Emit synthetic results for a local rehearsal."""


def run_stub(inputs, params):
    return {
        "plan": {
            "mode": "passthrough",
            "excludedSpans": [],
            "startSeconds": 0,
            "endSeconds": inputs["source"]["sourceSeconds"],
        }
    }
