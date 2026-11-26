import hashlib
import json
import os
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from copy import deepcopy
from pathlib import Path
from unittest.mock import patch

from indexed_fixture import chunked
from stage_helpers import GOLDEN_MCAP, JOB, MANIFEST_SHA, RECORDING
from stateaction_contracts import request_sha256

from stateaction_processing.hand_model import PINS
from stateaction_processing.node_entry import (
    NodeDeadlineExpired,
    deadline,
    describe_outputs,
    schema,
)
from stateaction_processing.recipe_graph import (
    MODULES,
    NodeState,
    RecipeRefused,
    VerifiedGraph,
    VerifiedPort,
)

ROOT = Path(__file__).resolve().parents[3]
GRAPH = ROOT / "recipes/compiled/egocentric_default.json"
FLORA = Path(__file__).with_name("fixtures") / "flora_native"
CLIP = "019a4b2c-3d4e-7f50-8a6b-7c8d9e0f1a2c"


def read(path):
    return json.loads(path.read_bytes())


def write(path, value):
    path.write_text(json.dumps(value), encoding="utf-8")
    return path


def sign(graph):
    graph["recipeSha256"] = request_sha256(
        {k: v for k, v in graph.items() if k not in {"recipeSha256", "authoring"}}
    )
    return graph


def renamed():
    graph = read(GRAPH)
    graph["nodes"]["detect"] = graph["nodes"].pop("segment")
    graph["nodes"]["caption"]["inputs"]["segments"]["from"] = "detect.segments"
    graph["nodes"]["caption"]["producers"] = ["clips", "detect"]
    graph["authoring"]["nodeSources"]["detect"] = graph["authoring"]["nodeSources"].pop(
        "segment"
    )
    graph["topoOrder"] = ["clips", "detect", "caption", "hand_pose", "review_video"]
    return sign(graph)


def module_lock(ref):
    return read(ROOT / "modules" / ref.split("@")[0] / "module.lock.json")


def verified(graph, digest=None, *, fixture_locks=None):
    fixtures = fixture_locks or {}
    locks = {ref: module_lock(ref) for ref in MODULES if ref not in fixtures}
    return VerifiedGraph(
        graph,
        digest or graph["recipeSha256"],
        schema(ROOT, "compiled-graph.v1"),
        locks | fixtures,
    )


def port(kind):
    return VerifiedPort(kind, object())


class SchedulerTests(unittest.TestCase):
    def test_changed_dependency_selects_verified_ports_in_graph_order(self):
        graph = renamed()
        nodes = graph["nodes"]
        nodes["other"] = deepcopy(nodes["detect"])
        graph["topoOrder"].insert(1, "other")
        nodes["caption"]["inputs"]["segments"]["from"] = "other.segments"
        nodes["caption"]["producers"] = ["clips", "other"]
        scheduler = verified(sign(graph))
        states = {"clips": NodeState("reused", {"plan": port("clip_plan@1")})}
        inputs = {"clip.video": port("video_range@1")}
        available = set(nodes)
        self.assertEqual(
            scheduler.next("clip", states, inputs, available).node_id, "other"
        )
        states["detect"] = NodeState("failed")
        states["other"] = NodeState("reused", {"segments": port("segments@2")})
        caption = scheduler.next("clip", states, inputs, available)
        self.assertEqual((caption.node_id, caption.action), ("caption", "ready"))
        self.assertIs(caption.inputs["segments"], states["other"].outputs["segments"])
        states["other"] = NodeState("reused")
        self.assertEqual(
            scheduler.next("clip", states, inputs, available).reason,
            "input_unverified:segments",
        )
        states["other"] = NodeState("failed")
        self.assertEqual(
            scheduler.next("clip", states, inputs, available).reason,
            "producer_failed:other",
        )
        states["caption"] = NodeState("skipped")
        self.assertEqual(
            scheduler.next("clip", states, inputs, available).node_id, "hand_pose"
        )
        self.assertEqual(scheduler.next("clip", states, inputs, set()).action, "refuse")
        states["hand_pose"] = NodeState("refused")
        self.assertIsNone(scheduler.next("clip", states, inputs, available))

    def test_cpu_gpu_overlap_holds_slots_until_each_intent_settles(self):
        graph = renamed()
        nodes = graph["nodes"]
        nodes["extra_hands"] = deepcopy(nodes["hand_pose"])
        gpu_hand = deepcopy(nodes["hand_pose"])
        ref = "hand_pose_gpu@1"
        lock = module_lock("hand_pose_cpu@1")
        lock["manifest"].update(id="hand_pose_gpu", gpus=["H100"])
        gpu_hand["module"] = ref
        gpu_hand["moduleLockSha256"] = request_sha256(lock)
        gpu_hand["resources"]["gpu"] = "H100"
        nodes["hand_tracker_gpu"] = gpu_hand
        graph["topoOrder"].extend(["hand_tracker_gpu", "extra_hands"])
        with patch.dict(MODULES, {ref: MODULES["hand_pose_cpu@1"]}):
            scheduler = verified(sign(graph), fixture_locks={ref: lock})
        states = {"clips": NodeState("succeeded", {"plan": port("clip_plan@1")})}
        inputs = {"clip.video": port("video_range@1")}
        available = set(nodes)

        def next_node():
            decision = scheduler.next("clip", states, inputs, available)
            return decision.node_id if decision else None

        self.assertEqual(next_node(), "detect")
        states["detect"] = NodeState("outstanding")
        self.assertEqual(next_node(), "hand_pose")
        states["hand_pose"] = NodeState("outstanding")
        self.assertIsNone(next_node())
        states["detect"] = NodeState("unknown")
        self.assertIsNone(next_node())
        states["hand_pose"] = NodeState("succeeded", {"poses": port("hand_pose@2")})
        self.assertEqual(next_node(), "extra_hands")
        states["extra_hands"] = NodeState("outstanding")
        states["detect"] = NodeState("succeeded", {"segments": port("segments@2")})
        self.assertEqual(next_node(), "caption")
        states["caption"] = NodeState("outstanding")
        self.assertIsNone(next_node())
        states["caption"] = NodeState("failed")
        self.assertEqual(next_node(), "hand_tracker_gpu")

    def test_untrusted_graph_rejected_before_decisions(self):
        for field, replacement, reason in (
            ("module", "frame_motion_energy@1", "module_ineligible"),
            ("moduleLockSha256", "0" * 64, "module_lock_mismatch"),
            (
                "inputs",
                {
                    "segments": {"from": "detect.unknown", "type": "segments@2"},
                    "video": {"from": "clip.video", "type": "video_range@1"},
                },
                "graph_port_mismatch",
            ),
        ):
            with self.subTest(field=field):
                graph = renamed()
                graph["nodes"]["caption"][field] = replacement
                with self.assertRaisesRegex(RecipeRefused, "graph_digest_mismatch"):
                    verified(graph)
                with self.assertRaisesRegex(RecipeRefused, reason):
                    verified(sign(graph))


class SubprocessTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.graph = renamed()
        self.graph_path = write(self.root / "graph.json", self.graph)
        self.source = self.root / "source.mcap"
        self.source.write_bytes(chunked(GOLDEN_MCAP.read_bytes()))
        self.source_sha = self.file(self.source)["sha256"]
        self.release = {}
        published = read(ROOT / "packages/contracts/api/flora-checkpoints.v1.json")
        for node in self.graph["nodes"].values():
            module = node["module"]
            binding = {
                "mode": "local_cpu",
                "moduleLockSha256": node["moduleLockSha256"],
                "definitionSha256": "d" * 64,
                "imageSha256": "e" * 64,
                "codeRevision": "f" * 40,
            }
            if module == "hand_pose_cpu@1":
                binding["modelSha256"] = PINS["sha256"]
            if node["resources"]["gpu"]:
                model = "tempseg" if "tempseg" in module else "captioner"
                checkpoint = published["checkpoints"][model]
                binding.update(
                    volumeName=published["volumeName"],
                    volumeVersion=published["volumeVersion"],
                    modelRevision=checkpoint["modelRevision"],
                    mode="local_replay",
                    functionId="fu-test",
                    definitionId="def-test",
                    imageId="im-test",
                    volumeManifestSha256=checkpoint["manifestSha256"],
                    modelSha256="b" * 64,
                    promptSha256="c" * 64,
                )
            self.release[module] = binding
        self.release_path = write(self.root / "release.json", self.release)

    def file(self, path):
        data = path.read_bytes()
        return {
            "name": path.name,
            "sha256": hashlib.sha256(data).hexdigest(),
            "sizeBytes": len(data),
        }

    def request(self, node_id, plan=None):
        node = self.graph["nodes"][node_id]
        clip = node["scope"] == "clip"
        data = {
            "schema": "stateaction.recipe-node-input/v1",
            "recipeSha256": self.graph["recipeSha256"],
            "nodeId": node_id,
            "module": node["module"],
            "jobId": JOB,
            "recordingId": RECORDING,
            "sourceFileId": RECORDING,
            "sourceManifestSha256": MANIFEST_SHA,
            "sourceSha256": self.source_sha,
            "claimRef": "n" * 43,
            "executionRef": "local_test",
            "sourceSeconds": 1,
            "deadlineUnixMs": int(time.time() * 1000) + 900_000,
            "binding": deepcopy(self.release[node["module"]]),
            "rgbProfile": "h264_mcap_v1",
            "inputs": {
                "video" if clip else "source": {
                    "kind": "video_range@1" if clip else "recording_source@2",
                    "files": {"mcap": self.file(self.source)},
                }
            },
        }
        if clip:
            data.update(clipId=CLIP, clipPlan=self.file(plan))
        return data

    def run_node(self, request, name, expected=None, admitted=None):
        output = self.root / name
        path = write(self.root / "request.json", request)
        result = subprocess.run(
            [
                sys.executable,
                "-m",
                "stateaction_processing.node_entry",
                "--repo",
                str(ROOT),
                "--graph",
                str(self.graph_path),
                "--graph-sha256",
                self.graph["recipeSha256"],
                "--request",
                str(path),
                "--request-sha256",
                admitted or request_sha256(request),
                "--release",
                str(self.release_path),
                "--inputs",
                str(self.root),
                "--output",
                str(output),
            ],
            env={
                **os.environ,
                "APP_ENV": "local",
                "STATEACTION_REPLAY_DIR": str(self.root / "replay"),
            },
            capture_output=True,
            text=True,
            timeout=35,
        )
        if expected:
            self.assertEqual(result.returncode, 1, result.stderr)
            self.assertTrue(result.stderr.strip().endswith(expected), result.stderr)
            self.assertFalse((output / "result" / "receipt.json").exists())
            return None, {}
        self.assertEqual(result.returncode, 0, result.stderr)
        receipt = read(output / "result" / "receipt.json")
        self.assertEqual(receipt["module"], request["module"])
        self.assertEqual(receipt["nodeId"], request["nodeId"])
        self.assertEqual(receipt["requestSha256"], request_sha256(request))
        (port_output,) = receipt["outputs"].values()
        paths = {}
        for role, descriptor in port_output["files"].items():
            path = output / "result" / descriptor["name"]
            self.assertEqual(self.file(path), descriptor)
            target = self.root / f"{name}-{path.name}"
            target.write_bytes(path.read_bytes())
            paths[role] = target
        return receipt, paths

    def test_plan_review_video_and_pinned_cpu_hand_pose(self):
        _, outputs = self.run_node(self.request("clips"), "planner")
        plan = read(outputs["plan"])
        self.assertEqual(plan["spans"][0]["last_source_frame_id"], "5")
        _, review = self.run_node(self.request("review_video"), "player")
        self.assertGreater(review["video"].stat().st_size, 0)
        receipt, hand = self.run_node(
            self.request("hand_pose", outputs["plan"]), "hands"
        )
        self.assertEqual(receipt["clipId"], CLIP)
        self.assertEqual(receipt["counts"]["frames"], 5)
        frames = read(hand["frame_map_0"])["rows"]
        self.assertEqual(frames[-1]["source_frame_id"], "5")
        self.assertEqual(frames[0]["timestamp_ns"], plan["origin_ts_ns"])
        observations = read(hand["observations_0"])["frames"]
        self.assertEqual(len(observations), 5)
        self.assertTrue(all(not frame["hands"] for frame in observations), observations)

    def test_replay_preserves_failed_window_and_caption_evidence(self):
        _, outputs = self.run_node(self.request("clips"), "planner")
        flora = self.root / "replay" / self.source_sha / "flora"
        flora.mkdir(parents=True)
        native = read(FLORA / "segments_failed_window.json")
        native["source"].update(frames=5, sha256=self.source_sha)
        native["segments"] = [dict(native["segments"][0], end_frame_exclusive=1)]
        native["windows"] = {
            "total": 2,
            "failed": [
                {
                    "window_index": 1,
                    "error_code": "fixture_failure",
                    "start_s": 0.025,
                    "end_s": 1,
                }
            ],
        }
        native_file = write(flora / "segments.json", native)
        (flora / "env.json").write_bytes((FLORA / "env.json").read_bytes())
        captions = read(FLORA / "captions_failed_window.json")
        captions.update(
            source_sha256=self.source_sha,
            segments_sha256=self.file(native_file)["sha256"],
        )
        captions["captions"] = captions["captions"][:1]
        write(flora / "captions.json", captions)
        receipt, segments = self.run_node(
            self.request("detect", outputs["plan"]), "segmented"
        )
        self.assertEqual(receipt["counts"]["failed_windows"], 1)
        self.assertIn(
            "failed_window",
            {row["status"] for row in read(segments["segments"])["rows"]},
        )
        request = self.request("caption", outputs["plan"])
        request["inputs"]["segments"] = {
            "kind": "segments@2",
            "files": {role: self.file(path) for role, path in segments.items()},
        }
        _, result = self.run_node(request, "captioned")
        self.assertIn(
            "not_captioned", {row["status"] for row in read(result["captions"])["rows"]}
        )

        native["segments"][0].update(start_frame=1, end_frame_exclusive=2)
        write(native_file, native)
        captions["segments_sha256"] = self.file(native_file)["sha256"]
        captions["captions"][0].update(status="complete", caption="Replacement caption")
        write(flora / "captions.json", captions)
        self.run_node(request, "replacement-cache", "replay_segments_changed")

    def test_refused_request_publishes_no_receipt(self):
        request = self.request("clips")
        self.run_node(
            request, "wrong-lease", "request_digest_mismatch", admitted="0" * 64
        )
        request["binding"]["definitionSha256"] = "0" * 64
        self.run_node(request, "wrong-binding", "binding_unavailable_or_incompatible")
        _, plan = self.run_node(self.request("clips"), "planner")
        request = self.request("detect", plan["plan"])
        request["binding"]["volumeManifestSha256"] = "0" * 64
        write(self.release_path, self.release | {request["module"]: request["binding"]})
        self.run_node(request, "wrong-checkpoint", "replay_checkpoint_mismatch")
        request = self.request("clips")
        request["deadlineUnixMs"] = 1
        self.run_node(request, "late", "deadline_budget_unavailable")
        request = self.request("clips")
        data = self.source.read_bytes()
        self.source.write_bytes(data[:-1] + bytes([data[-1] ^ 1]))
        self.run_node(request, "corrupt", "input_digest_mismatch")

    def test_alarm_escapes_parser_handler_and_elapsed_budget_blocks_publication(self):
        absolute = int(time.time() * 1000) + 900_000
        with self.assertRaises(NodeDeadlineExpired), deadline(absolute, 600):
            try:
                signal.raise_signal(signal.SIGALRM)
            except ValueError:
                pass

        with patch(
            "stateaction_processing.node_entry.time.monotonic",
            side_effect=[100, 104],
        ):
            with deadline(absolute, 3) as before_publish:
                with self.assertRaises(NodeDeadlineExpired):
                    before_publish()

    def test_output_verifier_rejects_oversized_and_invalid_output(self):
        path = write(self.root / "plan.json", {"state": "succeeded"})
        with self.assertRaisesRegex(RecipeRefused, "artifact_contract_invalid"):
            describe_outputs("clip_plan@1", {"plan": path}, self.root)
        with patch("stateaction_processing.node_entry.JSON_LIMIT", 1):
            with self.assertRaisesRegex(RecipeRefused, "output_size_or_kind"):
                describe_outputs("clip_plan@1", {"plan": path}, self.root)
