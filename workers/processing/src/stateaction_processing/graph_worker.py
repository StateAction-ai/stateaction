import hashlib
import json
import os
import sys
from pathlib import Path
from secrets import token_urlsafe
from tempfile import TemporaryDirectory
from urllib.request import Request

from stateaction_contracts import parse_contract, request_sha256
from stateaction_contracts.recipe_graph import (
    MODULES,
    VerifiedGraph,
    read_json,
    require,
)

from .artifact_types import OutputFile
from .hand_pose_cpu_v1 import Api, ServerOutputSink, _http
from .node_entry import METADATA_LIMIT, NodeDeadlineExpired, execute, schema
from .run_job import _OPENER, _strict_origin, confirm_local_isolation

ROLE = {
    "plan": "diagnostic_blob",
    "video": "recording_mp4",
    "observations": "hand_observations_json",
    "frame_map": "frame_map_json",
    "rrd": "viewer_rrd",
    "hand_presence": "hand_presence_json",
    "arrays": "hand_arrays_npz",
    "rgb": "clip_mp4",
    "thumbnail": "thumbnail_jpeg",
    "segments": "segments_json",
    "captions": "captions_json",
    "windows": "diagnostic_blob",
    "replay_provenance": "diagnostic_blob",
    "producer_provenance": "diagnostic_blob",
}


def download(file, destination: Path) -> dict:
    size = int(file["sizeBytes"])
    require(0 < size <= 32 * 1024**3, "input_size_invalid")
    digest = hashlib.sha256()
    remaining = size
    with (
        _OPENER.open(Request(file["readUrl"], method="GET"), timeout=120) as response,
        destination.open("xb") as target,
    ):
        while remaining:
            chunk = response.read(min(remaining, 1024**2))
            require(bool(chunk), "input_size_mismatch")
            target.write(chunk)
            remaining -= len(chunk)
            digest.update(chunk)
        require(not response.read(1), "input_size_mismatch")
    require(digest.hexdigest() == file["sha256"], "input_digest_mismatch")
    return {"name": destination.name, "sizeBytes": size, "sha256": file["sha256"]}


def run_graph_worker(bootstrap, execution_ref: str, repo: Path, *, backend="local"):
    from datetime import datetime

    api_url = _strict_origin(bootstrap["apiUrl"])
    job_id, node_id = bootstrap["jobId"], bootstrap["nodeId"]
    nonce = token_urlsafe(32)
    request = parse_contract(
        "jobs.graph-claim.v1",
        {
            "nodeId": node_id,
            "invocationNonce": nonce,
            "executionRef": execution_ref,
            "backend": backend,
            "bindingSha256": bootstrap["bindingSha256"],
        },
    )
    reply, _ = _http(
        "POST",
        f"{api_url}/internal/v1/jobs/{job_id}/graph/claim",
        bootstrap["bootstrapToken"],
        request,
    )
    grant = parse_contract("jobs.graph-grant.v1", reply)
    task, binding = grant["task"], grant["binding"]
    require(
        task["jobId"] == job_id
        and task["recipeSha256"] == bootstrap["recipeSha256"]
        and request_sha256(binding) == bootstrap["bindingSha256"],
        "node_grant_mismatch",
    )
    if backend == "modal":
        require(
            binding["mode"] == "modal"
            and binding["definitionFormat"] == "modal-python-v1"
            and all(
                binding[key] == bootstrap[key]
                for key in ("codeRevision", "imageSha256", "paramsSha256", "gpu")
            ),
            "node_container_binding_mismatch",
        )
    locks = {
        ref: read_json(
            repo / "modules" / ref.split("@")[0] / "module.lock.json", METADATA_LIMIT
        )
        for ref in MODULES
    }
    graph = VerifiedGraph(
        grant["graph"], task["recipeSha256"], schema(repo, "compiled-graph.v1"), locks
    )
    node = graph.node(node_id)
    worker = Api(
        {
            "apiUrl": api_url,
            "jobId": job_id,
            "nonce": nonce,
            "capability": grant["uploadToken"],
        }
    )
    sink = ServerOutputSink(worker)
    with TemporaryDirectory(prefix="stateaction-node-") as path:
        scratch = Path(path)
        source = download(grant["source"], scratch / "source.mcap")
        request = {
            "schema": "stateaction.recipe-node-input/v2",
            "recipeSha256": graph.sha256,
            "recipeRef": task["recipeRef"],
            "nodeId": node_id,
            "module": node["module"],
            "recordingId": task["targetId"],
            "sourceFileId": grant["source"]["fileId"],
            "sourceSha256": source["sha256"],
            "sourceManifestSha256": task["sourceManifestSha256"],
            "claimRef": nonce,
            "executionRef": execution_ref,
            "binding": binding,
            "jobId": job_id,
            "rgbProfile": task["rgbProfile"],
            "profileRevision": task["profileRevision"],
            "sourceSeconds": task["sourceSeconds"],
            "deadlineUnixMs": int(
                datetime.fromisoformat(grant["deadline"]).timestamp() * 1000
            ),
            "inputs": {},
        }
        if task["kind"] == "clip_pipeline":
            plan = download(grant["clipPlan"], scratch / "clip-plan.json")
            require(
                plan["sha256"] == task["clip"]["planSha256"],
                "clip_plan_digest_mismatch",
            )
            request.update(clipPlan=plan, clipId=task["clip"]["id"])
        if backend == "modal":
            require(
                node["module"] == bootstrap["module"], "node_container_module_mismatch"
            )
            request["observedGpu"] = bootstrap["observedGpu"]
        for port, edge in node["inputs"].items():
            if edge["from"] in {"recording.source", "clip.video"}:
                files = {"mcap": source}
            else:
                files = {
                    key: download(item, scratch / f"{port}-{key}.json")
                    for key, item in grant["producerFiles"][port].items()
                }
            request["inputs"][port] = {"kind": edge["type"], "files": files}
        result = scratch / "result-dir"
        execute(
            request,
            request_sha256(request),
            graph,
            {node["module"]: binding},
            scratch,
            result,
            repo,
        )
        result /= "result"
        receipt_text = (result / "receipt.json").read_text()
        receipt = json.loads(receipt_text)
        output_ids = []
        for port, entry in receipt["outputs"].items():
            for key, file in entry["files"].items():
                role_key = (
                    key.rpartition("_")[0]
                    if entry["kind"] == "hand_pose@2" and key != "hand_presence"
                    else key
                )
                role = ROLE[role_key]
                name = file["name"]
                output = sink.put(
                    OutputFile(
                        role,
                        f"nodes/{node_id}/{name}",
                        result / name,
                        file["sizeBytes"],
                        file["sha256"],
                        None,
                    )
                )
                output_ids.append(
                    {
                        "port": port,
                        "logicalFile": key,
                        "name": name,
                        "fileId": output.file_id,
                    }
                )
    return {"receipt": receipt_text, "files": output_ids}


def main():
    local = len(sys.argv) == 2
    if local:
        require(
            os.environ.get("APP_ENV") == "local"
            and os.environ.get("STATEACTION_THREADED_ISOLATION_FD") == "3",
            "local_controller_required",
        )
        confirm_local_isolation(allow_threads=True)
    execution_ref = sys.argv[1]
    raw = sys.stdin.buffer.read(32769)
    require(len(raw) <= 32768, "node_bootstrap_too_large")
    try:
        result = run_graph_worker(
            json.loads(raw),
            execution_ref,
            Path(__file__).resolve().parents[4],
            backend="local" if local else "modal",
        )
    except (Exception, NodeDeadlineExpired) as error:
        code = (
            str(error)
            if isinstance(error, NodeDeadlineExpired)
            else getattr(error, "code", "node_failed")
        )
        print(json.dumps({"stateactionNodeError": code}), flush=True)
        return 1
    if local:
        print(json.dumps({"stateactionNodeResult": result}), flush=True)
    else:
        with Path(sys.argv[2]).open("x") as proof:
            json.dump(result, proof)
    return 0


if __name__ == "__main__":
    sys.exit(main())
