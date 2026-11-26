"""Emit synthetic results for a local rehearsal."""


def run_stub(inputs, params):
    return {
        "video": {"fixture": True, "sourceSeconds": inputs["source"]["sourceSeconds"]}
    }
