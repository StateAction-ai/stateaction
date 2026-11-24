"""SA-87 stage contract helpers agree with the shared golden fixtures."""

from __future__ import annotations

import json
import unittest
from pathlib import Path

from stateaction_contracts import (
    caption_steps,
    request_sha256,
    segment_id,
    validate_bytes,
    validate_value,
)

CONTRACTS = Path(__file__).resolve().parents[2]
FIXTURES = CONTRACTS / "conformance" / "fixtures" / "contracts"


def first_valid(contract: str) -> dict:  # type: ignore[type-arg]
    cases = json.loads((FIXTURES / f"{contract}.json").read_text("utf-8"))["cases"]
    return next(c["input"]["document"] for c in cases if c["expect"]["valid"])


class StageContracts(unittest.TestCase):
    def test_segment_ids_recompute_from_the_header(self) -> None:
        doc = first_valid("artifacts.segments.v1")
        producer = doc["producer"]
        ref = f"{producer['module_id']}@{producer['module_version']}"
        for row in doc["rows"]:
            self.assertEqual(
                row["segment_id"],
                segment_id(
                    doc["source_manifest_sha256"],
                    ref,
                    producer["params_sha256"],
                    row["start"]["source_frame_id"],
                    row["end"]["source_frame_id"],
                ),
            )

    def test_only_imported_segments_preserve_native_overlap(self) -> None:
        doc = first_valid("artifacts.segments.v1")
        first, second, *_ = doc["rows"]
        doc["rows"].insert(1, {**first, "end": second["end"]})

        def rekey():
            for idx, row in enumerate(doc["rows"]):
                row["ordinal"] = idx
                producer = doc["producer"]
                row["segment_id"] = segment_id(
                    doc["source_manifest_sha256"],
                    f"{producer['module_id']}@{producer['module_version']}",
                    producer["params_sha256"],
                    row["start"]["source_frame_id"],
                    row["end"]["source_frame_id"],
                )

        rekey()
        self.assertFalse(validate_value("artifacts.segments.v1", doc).valid)
        doc["producer"]["module_id"] = "imported_segment"
        rekey()
        self.assertFalse(validate_value("artifacts.segments.v1", doc).valid)
        doc["schema"] = "stateaction.segments.v2"
        self.assertTrue(validate_value("artifacts.segments.v2", doc).valid)
        doc["producer"]["module_version"] = 2
        rekey()
        self.assertFalse(validate_value("artifacts.segments.v2", doc).valid)

    def test_caption_steps(self) -> None:
        self.assertEqual(
            caption_steps(" hold cup with left hand,,\tpour water ,"),
            ["hold cup with left hand", "pour water"],
        )

    def test_committed_module_manifest_is_valid(self) -> None:
        data = (CONTRACTS / "api" / "modules.json").read_bytes()
        result = validate_bytes("jobs.module-manifest.v1", data)
        self.assertTrue(result.valid, result)
        for module in json.loads(data)["modules"]:
            local = module["moduleId"].startswith(("stub_", "replay_"))
            self.assertIs(module["localOnly"], local, module["moduleId"])

    def test_task_input_pins_the_recipe_digest(self) -> None:
        task = first_valid("jobs.task-input.v3")
        self.assertEqual(task["recipeSha256"], request_sha256(task["recipe"]))
        self.assertTrue(validate_value("jobs.recipe.v1", task["recipe"]).valid)


if __name__ == "__main__":
    unittest.main()
