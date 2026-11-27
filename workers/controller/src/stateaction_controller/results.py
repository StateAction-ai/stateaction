"""Validate physical completion evidence for exactly the admitted call."""

import json
import re

from stateaction_contracts import validate_value


def call_id_valid(call_id):
    return isinstance(call_id, str) and re.fullmatch(r"fc-[A-Za-z0-9]{1,77}", call_id)


def parse_receipt(value, identity, exit_code):
    if (
        not isinstance(value, dict)
        or not validate_value("jobs.stage-receipt.v1", value).valid
    ):
        return None
    if tuple(value[key] for key in ("jobId", "stage", "module")) != identity:
        return None
    if exit_code is not None and (value["status"] == "succeeded") != (exit_code == 0):
        return None
    return value


def parse_result(value, call_id, stage=None):
    if not isinstance(value, dict) or not call_id_valid(call_id):
        return None
    required = {"schemaVersion", "functionCallId", "exitCode"}
    if stage:
        required.add("receipt")
    if not required <= value.keys() <= required | {"callBinding"}:
        return None
    if (
        type(value["schemaVersion"]) is not int
        or value["schemaVersion"] != (2 if stage else 1)
        or value["functionCallId"] != call_id
        or type(value["exitCode"]) is not int
        or abs(value["exitCode"]) > 255
    ):
        return None
    if "callBinding" in value and (
        not isinstance(value["callBinding"], str)
        or not re.fullmatch(r"[0-9a-f]{64}", value["callBinding"])
    ):
        return None
    if (
        stage
        and value["receipt"] is not None
        and not parse_receipt(value["receipt"], stage, value["exitCode"])
    ):
        return None
    return value


def parse_graph_result(value, call_id):
    if (
        not isinstance(value, dict)
        or not call_id_valid(call_id)
        or value.keys() != {"schemaVersion", "functionCallId", "exitCode", "receipt"}
        or type(value["schemaVersion"]) is not int
        or value["schemaVersion"] != 3
        or value["functionCallId"] != call_id
        or type(value["exitCode"]) is not int
        or abs(value["exitCode"]) > 255
    ):
        return None
    receipt = value["receipt"]
    if value["exitCode"] != 0:
        return value if receipt is None else None
    if (
        not isinstance(receipt, dict)
        or receipt.keys() != {"receipt", "files"}
        or not isinstance(receipt["receipt"], str)
        or len(receipt["receipt"].encode()) > 524288
        or not isinstance(receipt["files"], list)
        or len(receipt["files"]) > 2000
    ):
        return None
    try:
        if len(json.dumps(receipt, allow_nan=False).encode()) <= 1000000:
            return value
    except (ValueError, TypeError, RecursionError):
        pass
    return None
