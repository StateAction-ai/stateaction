"""Run a compiled graph on one synthetic passthrough clip."""

from copy import deepcopy
from decimal import Decimal
from pathlib import Path
from runpy import run_path

from compiler import charge_usd, dollars
from sandbox import canonical_json


def run_local(
    graph: dict, root: Path, *, seconds: int, fail_node=None, fail_window=None
):
    limits = graph["meta"]["limits"]
    if not 1 <= seconds <= limits["maxSourceSeconds"]:
        raise ValueError("Use a synthetic fixture duration within maxSourceSeconds.")
    if fail_node and fail_node not in graph["nodes"]:
        raise ValueError("Choose an existing node for failure injection.")
    if fail_window is not None and (
        not fail_node
        or graph["nodes"][fail_node]["scope"] != "clip"
        or not 0 <= fail_window < seconds
    ):
        raise ValueError(
            "Choose a valid window index and a clip node for failure injection."
        )
    total = sum(charge_usd(node, seconds) for node in graph["nodes"].values())
    if Decimal(dollars(total)) > Decimal(limits["maxRecordingCostUsd"]):
        raise ValueError("Synthetic run exceeds the recording cost cap.")

    runs = []
    completed = {}
    plan_node, plan_port = (
        graph["fanOut"]["clip"].split(".") if graph["fanOut"] else (None, None)
    )
    recording_source = {"sourceSeconds": seconds}

    def input_value(ref, window):
        if ref == "recording.source":
            return recording_source
        if ref == "clip.video":
            return {
                "index": window,
                "startSeconds": window,
                "endSeconds": window + 1,
                "syntheticValues": [window, window + 2, window + 5],
            }
        producer, port = ref.split(".")
        index = window if graph["nodes"][producer]["scope"] == "clip" else None
        return completed[producer, index]["outputs"][port]["syntheticValue"]

    for node_id in graph["topoOrder"]:
        node = graph["nodes"][node_id]
        is_clip = node["scope"] == "clip"
        implementation = root / "modules" / node["module"].split("@")[0] / "impl.py"
        stub = None
        for window in range(seconds) if is_clip else [None]:
            row = {
                "node": node_id,
                "scope": node["scope"],
                "clip": "synthetic-whole-recording" if is_clip else None,
                "window": None
                if window is None
                else {
                    "index": window,
                    "startSeconds": window,
                    "endSeconds": window + 1,
                },
                "provenance": {
                    "kind": "stub",
                    "synthetic": True,
                    "module": node["module"],
                    "moduleLockSha256": node["moduleLockSha256"],
                },
            }
            failed_parents = [
                parent
                for parent in node["producers"]
                if completed[
                    parent,
                    window if graph["nodes"][parent]["scope"] == "clip" else None,
                ]["status"]
                != "stubbed"
            ]
            if failed_parents:
                row.update(
                    status="blocked", reason="upstream_failed", upstream=failed_parents
                )
            elif node_id == fail_node and (
                fail_window is None or window == fail_window
            ):
                row.update(status="failed", reason="injected_stub_failure")
            else:
                try:
                    if stub is None:
                        stub = run_path(str(implementation))["run_stub"]
                    inputs = {
                        port: input_value(binding["from"], window)
                        for port, binding in node["inputs"].items()
                    }
                    outputs = stub(deepcopy(inputs), deepcopy(node["params"]))
                    if (
                        type(outputs) is not dict
                        or outputs.keys() != node["outputs"].keys()
                    ):
                        raise ValueError("Stub returned the wrong output ports.")
                    canonical_json(outputs)
                    if node_id == plan_node:
                        plan = outputs[plan_port]
                        if plan != {
                            "mode": "passthrough",
                            "excludedSpans": [],
                            "startSeconds": 0,
                            "endSeconds": seconds,
                        } or any(
                            type(plan[field]) is not int
                            for field in ("startSeconds", "endSeconds")
                        ):
                            raise ValueError(
                                "Expected a single passthrough clip covering the recording."
                            )
                except Exception:
                    row.update(status="failed", reason="stub_error")
                else:
                    row.update(
                        status="stubbed",
                        outputs={
                            name: {
                                "type": node["outputs"][name],
                                "syntheticValue": value,
                            }
                            for name, value in outputs.items()
                        },
                    )
            completed[node_id, window] = row
            runs.append(row)
    return {
        "recipe": graph["recipe"],
        "recipeSha256": graph["recipeSha256"],
        "sourceSeconds": seconds,
        "status": "passed"
        if all(row["status"] == "stubbed" for row in runs)
        else "failed",
        "runs": runs,
    }
