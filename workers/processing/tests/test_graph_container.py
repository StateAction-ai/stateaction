import json
import unittest
from unittest import mock

from stateaction_processing.graph_container import container_facts, run_graph_bootstrap


class ContainerBindingTests(unittest.TestCase):
    def setUp(self):
        self.env = {
            "STATEACTION_CODE_REVISION": "a" * 40,
            "STATEACTION_IMAGE_SPEC_SHA256": "b" * 64,
            "STATEACTION_GRAPH_PARAMS_SHA256": "c" * 64,
        }
        self.boot = {
            "schemaVersion": 1,
            "apiUrl": "https://stateaction.invalid",
            "jobId": "00000000-0000-4000-8000-000000000037",
            "nodeId": "track_hands",
            "recipeSha256": "d" * 64,
            "bindingSha256": "e" * 64,
            "functionId": "fu-Example",
            "runtimeDefinitionSha256": "1" * 64,
            "nodeDeadline": "2026-11-27T00:00:00.000Z",
            "module": "hand_pose_cpu@1",
            "codeRevision": self.env["STATEACTION_CODE_REVISION"],
            "imageSha256": self.env["STATEACTION_IMAGE_SPEC_SHA256"],
            "paramsSha256": self.env["STATEACTION_GRAPH_PARAMS_SHA256"],
            "gpu": None,
            "bootstrapToken": "sa_svc_" + "t" * 43,
        }

    def test_rejects_mismatched_definition_or_gpu_without_starting_a_worker(self):
        mistakes = {
            "schemaVersion": 2,
            "module": "clip_filter_passthrough@1",
            "codeRevision": "f" * 40,
            "imageSha256": "f" * 64,
            "paramsSha256": "f" * 64,
            "runtimeDefinitionSha256": "2" * 64,
            "functionId": "fu-Unapproved",
            "gpu": "RTX-PRO-6000",
        }
        for field, wrong in mistakes.items():
            with (
                self.subTest(field=field),
                mock.patch("subprocess.Popen") as spawn,
                mock.patch(
                    "stateaction_processing.graph_container.runtime_definition",
                    return_value=("fu-Example", "1" * 64),
                ),
            ):
                result = run_graph_bootstrap(
                    json.dumps({**self.boot, field: wrong}),
                    "fc-example",
                    module="hand_pose_cpu@1",
                    budget_seconds=10,
                    env=self.env,
                )
                self.assertEqual(result["functionCallId"], "fc-example")
                self.assertEqual(result["exitCode"], 70)
                self.assertIsNone(result["receipt"])
                spawn.assert_not_called()

    def test_accepts_the_exact_running_definition(self):
        with (
            mock.patch(
                "stateaction_processing.graph_container.runtime_definition",
                return_value=("fu-Example", "1" * 64),
            ),
            mock.patch("pathlib.Path.exists", return_value=False),
        ):
            self.assertIsNone(container_facts(self.boot, "hand_pose_cpu@1", self.env))
