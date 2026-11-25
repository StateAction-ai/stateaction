"""A temporary CPU-only Modal function that accepts a run ID and no data."""

import json
import re

import modal


def identity_probe(argument: str):
    value = json.loads(argument)
    if set(value) != {"probe", "runId"} or value["probe"] != "python-plane-cpu":
        raise ValueError("unexpected probe input")
    if not re.fullmatch(r"trn-[A-Za-z0-9]+", value["runId"]):
        raise ValueError("unexpected task ID")
    return {**value, "callId": modal.current_function_call_id()}


def build_app(name: str):
    app = modal.App(name)
    image = modal.Image.debian_slim(python_version="3.12")
    app.function(
        name="identity_probe",
        image=image,
        cpu=(0.5, 0.5),
        memory=(256, 256),
        gpu=None,
        min_containers=0,
        max_containers=1,
        buffer_containers=0,
        scaledown_window=5,
        retries=0,
        timeout=10,
        startup_timeout=60,
        single_use_containers=True,
        nonpreemptible=True,
    )(identity_probe)
    return app
