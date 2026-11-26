import argparse
import hashlib
import os
import signal
import stat
import sys
import time
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any

from jsonschema import Draft202012Validator
from stateaction_contracts import request_sha256, validate_value

from .artifact_types import sha256_file
from .flora_adapter import canonical_bytes
from .recipe_adapters import JSON_ARTIFACTS, hand_pose, plan_source, replay_flora
from .recipe_graph import (
    MODULES,
    RecipeRefused,
    VerifiedGraph,
    budget_seconds,
    read_json,
    require,
)
from .source_range import ClipBinding

METADATA_LIMIT = 512 * 1024
JSON_LIMIT = 16 * 1024**2
VIDEO_LIMIT = 4 * 1024**3
OUTPUT_LIMIT = 16 * 1024**3
IDENTITY = (
    "recipeSha256",
    "nodeId",
    "module",
    "recordingId",
    "sourceFileId",
    "sourceManifestSha256",
    "sourceSha256",
    "claimRef",
    "executionRef",
    "binding",
    "clipId",
)


def schema(repo: Path, name: str) -> dict[str, Any]:
    result: dict[str, Any] = read_json(
        repo / "packages/contracts/recipe" / f"{name}.schema.json", METADATA_LIMIT
    )
    return result


def checked_json(path: Path, contract: str) -> dict[str, Any]:
    value: dict[str, Any] = read_json(path, JSON_LIMIT)
    require(validate_value(contract, value).valid, "artifact_contract_invalid")
    return value


def copy_checked(root: Path, entry: dict[str, Any], target: Path, cap: int) -> None:
    path = root / entry["name"]
    size = entry["sizeBytes"]
    digest = hashlib.sha256()
    total = 0
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as original:
        st = os.fstat(original.fileno())
        require(
            stat.S_ISREG(st.st_mode) and st.st_size == size <= cap, "input_size_or_kind"
        )
        with target.open("xb") as copy:
            while chunk := original.read(1024**2):
                total += len(chunk)
                require(total <= size, "input_size_or_kind")
                digest.update(chunk)
                copy.write(chunk)
    require(
        total == size and digest.hexdigest() == entry["sha256"], "input_digest_mismatch"
    )


def clip_binding(request: dict[str, Any], path: Path) -> ClipBinding:
    plan = checked_json(path, JSON_ARTIFACTS["plan"])
    spans = plan["spans"]
    require(
        plan["state"] == "succeeded"
        and plan["mode"] == "passthrough"
        and plan["recording_id"] == request["recordingId"]
        and plan["source_manifest_sha256"] == request["sourceManifestSha256"]
        and len(spans) == 1
        and spans[0]["kind"] == "clip"
        and spans[0]["start_ordinal"] == 0
        and spans[0]["end_ordinal"] == plan["frame_count"],
        "clip_plan_mismatch",
    )
    return ClipBinding.from_task(
        {
            "clip": {
                "id": request["clipId"],
                "planSha256": request["clipPlan"]["sha256"],
                "sourceRange": spans[0],
            }
        }
    )


class NodeDeadlineExpired(BaseException):
    code = "deadline_expired"


@contextmanager
def deadline(deadline_ms: int, seconds: int) -> Iterator[Callable[[], None]]:
    remaining = deadline_ms / 1000 - time.time()
    require(remaining >= seconds, "deadline_budget_unavailable")
    ends = time.monotonic() + seconds

    def expire(*_: object) -> None:
        raise NodeDeadlineExpired()

    def before_publish() -> None:
        signal.setitimer(signal.ITIMER_REAL, 0)
        if time.monotonic() >= ends or time.time() * 1000 >= deadline_ms:
            raise NodeDeadlineExpired()

    old = signal.signal(signal.SIGALRM, expire)
    try:
        signal.setitimer(signal.ITIMER_REAL, seconds)
        yield before_publish
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, old)


def validate_binding(
    request: dict[str, Any], node: dict[str, Any], release: dict[str, Any], repo: Path
) -> None:
    ref = request["module"]
    binding = request["binding"]
    require(binding == release.get(ref), "binding_unavailable_or_incompatible")
    require(
        binding["moduleLockSha256"] == node["moduleLockSha256"], "binding_lock_mismatch"
    )
    if node["resources"]["gpu"] is not None:
        pins = {
            "volumeName",
            "volumeVersion",
            "modelRevision",
            "functionId",
            "definitionId",
            "imageId",
            "volumeManifestSha256",
            "modelSha256",
            "promptSha256",
        }
        require(
            binding["mode"] == "local_replay" and pins <= binding.keys(),
            "replay_binding_invalid",
        )
        published = read_json(
            repo / "packages/contracts/api/flora-checkpoints.v1.json", METADATA_LIMIT
        )
        model = "tempseg" if ref == "flora_tempseg_vllm_fp8@1" else "captioner"
        checkpoint = published["checkpoints"][model]
        require(
            binding["volumeName"] == published["volumeName"]
            and binding["volumeVersion"] == published["volumeVersion"]
            and binding["volumeManifestSha256"] == checkpoint["manifestSha256"]
            and binding["modelRevision"] == checkpoint["modelRevision"],
            "replay_checkpoint_mismatch",
        )
    else:
        require(binding["mode"] == "local_cpu", "cpu_binding_invalid")


def execute(
    request: dict[str, Any],
    admitted_request_sha256: str,
    graph: VerifiedGraph,
    release: dict[str, Any],
    input_root: Path,
    result_dir: Path,
    repo: Path,
) -> None:
    require(
        Draft202012Validator(schema(repo, "node-input.v1")).is_valid(request),
        "node_input_schema",
    )
    require(
        request_sha256(request) == admitted_request_sha256, "request_digest_mismatch"
    )
    require(request["recipeSha256"] == graph.sha256, "graph_digest_mismatch")
    node = graph.node(request["nodeId"])
    require(node["module"] == request["module"], "binding_module_mismatch")
    validate_binding(request, node, release, repo)
    duration = request["sourceSeconds"]
    require(duration <= graph.max_source_seconds, "source_duration_exceeded")
    inputs = request["inputs"]
    require(
        {name: port["kind"] for name, port in inputs.items()}
        == {name: edge["type"] for name, edge in node["inputs"].items()},
        "input_ports_mismatch",
    )
    is_clip = node["scope"] == "clip"
    require(
        ("clipId" in request) == is_clip and ("clipPlan" in request) == is_clip,
        "clip_scope_mismatch",
    )
    media = inputs["video" if is_clip else "source"]["files"]
    require(
        media.keys() == {"mcap"} and media["mcap"]["sha256"] == request["sourceSha256"],
        "source_identity_mismatch",
    )
    if "segments" in inputs:
        require(
            inputs["segments"]["files"].keys()
            in (
                {"segments", "replay_provenance"},
                {"segments", "replay_provenance", "windows"},
            ),
            "segments_inventory",
        )

    with (
        deadline(
            request["deadlineUnixMs"], budget_seconds(node, duration)
        ) as before_publish,
        TemporaryDirectory(prefix=".node-", dir=result_dir.parent) as directory,
    ):
        scratch = Path(directory)
        source = scratch / "verified.mcap"
        copy_checked(input_root, media["mcap"], source, 32 * 1024**3)
        clip = None
        if is_clip:
            plan = scratch / "verified-plan.json"
            copy_checked(input_root, request["clipPlan"], plan, JSON_LIMIT)
            clip = clip_binding(request, plan)
        ref = node["module"]
        if clip is None:
            plan_doc, video = plan_source(request, source, scratch)
            counts = {"frames": plan_doc["frame_count"]}
            if ref == "clip_filter_passthrough@1":
                output = scratch / "plan.json"
                output.write_bytes(canonical_bytes(plan_doc))
                files = {"plan": output}
            else:
                files = {"video": video}
        elif ref == "hand_pose_cpu@1":
            files, counts = hand_pose(request, source, clip, scratch)
        else:
            segment_files = {}
            if "segments" in inputs:
                for role, entry in inputs["segments"]["files"].items():
                    target = scratch / f"verified-{role}.json"
                    copy_checked(input_root, entry, target, JSON_LIMIT)
                    segment_files[role] = target
            files, counts = replay_flora(
                request, node, source, clip, segment_files, scratch
            )
        port, kind = next(iter(node["outputs"].items()))
        bundle = scratch / "result"
        bundle.mkdir()
        descriptors = describe_outputs(kind, files, bundle)
        receipt = {
            "schema": "stateaction.recipe-node-receipt/v1",
            **{key: request[key] for key in IDENTITY if key in request},
            "requestSha256": admitted_request_sha256,
            "status": "succeeded",
            "outputs": {port: {"kind": kind, "files": descriptors}},
            "counts": counts,
        }
        payload = canonical_bytes(receipt)
        require(
            len(payload) <= METADATA_LIMIT
            and Draft202012Validator(schema(repo, "node-receipt.v1")).is_valid(receipt),
            "receipt_schema",
        )
        (bundle / "receipt.json").write_bytes(payload)
        result_dir.mkdir()
        before_publish()
        bundle.rename(result_dir / "result")


def describe_outputs(kind: str, files: dict[str, Path], bundle: Path) -> dict[str, Any]:
    primaries = {
        "clip_plan@1": {"plan"},
        "review_video@1": {"video"},
        "segments@2": {"segments", "replay_provenance"},
        "captions@2": {"captions", "replay_provenance"},
    }
    roles = files.keys()
    if kind == "hand_pose@2":
        groups = {role.rpartition("_")[2] for role in roles}
        require(
            bool(groups)
            and roles
            == {
                f"{role}_{i}"
                for i in groups
                for role in ("observations", "frame_map", "arrays", "rrd")
            },
            "output_inventory",
        )
    else:
        required = primaries[kind]
        optional = {"windows"} if kind == "segments@2" else set()
        require(required <= roles <= required | optional, "output_inventory")
    result = {}
    total = 0
    for role, path in files.items():
        base = role.rpartition("_")[0] if kind == "hand_pose@2" else role
        cap = (
            VIDEO_LIMIT
            if base == "video"
            else 128 * 1024**2
            if base in {"arrays", "rrd"}
            else JSON_LIMIT
        )
        st = path.lstat()
        total += st.st_size
        require(
            stat.S_ISREG(st.st_mode)
            and 0 < st.st_size <= cap
            and total <= OUTPUT_LIMIT,
            "output_size_or_kind",
        )
        if contract := JSON_ARTIFACTS.get(base):
            checked_json(path, contract)
        elif base in {"windows", "replay_provenance"}:
            read_json(path, JSON_LIMIT)
        name = f"{role}{path.suffix}"
        result[role] = {
            "name": name,
            "sizeBytes": st.st_size,
            "sha256": sha256_file(path),
        }
        path.rename(bundle / name)
    return result


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Run one admitted compiled recipe node"
    )
    for path in ("repo", "graph", "release", "request", "inputs", "output"):
        parser.add_argument(f"--{path}", type=Path, required=True)
    parser.add_argument("--graph-sha256", required=True)
    parser.add_argument("--request-sha256", required=True)
    args = parser.parse_args()
    try:
        graph = read_json(args.graph, METADATA_LIMIT)
        locks = {
            ref: read_json(
                args.repo / "modules" / ref.split("@")[0] / "module.lock.json",
                METADATA_LIMIT,
            )
            for ref in MODULES
        }
        verified = VerifiedGraph(
            graph, args.graph_sha256, schema(args.repo, "compiled-graph.v1"), locks
        )
        execute(
            read_json(args.request, METADATA_LIMIT),
            args.request_sha256,
            verified,
            read_json(args.release, METADATA_LIMIT),
            args.inputs,
            args.output,
            args.repo,
        )
    except (Exception, NodeDeadlineExpired) as error:
        code = (
            str(error)
            if isinstance(error, RecipeRefused)
            else getattr(error, "code", "node_failed")
        )
        print(code, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
