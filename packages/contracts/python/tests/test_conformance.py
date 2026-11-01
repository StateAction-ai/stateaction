"""Run the shared SA-12 fixtures through the Python adapter."""

from __future__ import annotations

import base64
import copy
import json
import os
import subprocess
import sys
import unittest
from pathlib import Path
from typing import Any

from stateaction_contracts import (
    MalformedJsonError,
    NoncanonicalValueError,
    canonical_json_text,
    check_sealed_inventory,
    classify_replay,
    contract_ids,
    request_sha256,
    sha256_hex,
    validate_bytes,
    validate_value,
    verify_stored_bytes,
)
from stateaction_contracts.canonical import loads_strict

CONTRACTS = Path(__file__).resolve().parents[2]
FIXTURES = CONTRACTS / "conformance" / "fixtures"


def read(path: str) -> bytes:
    return (FIXTURES / path).read_bytes()


def pointer_get(doc: Any, pointer: str) -> Any:
    for part in pointer.split("/")[1:]:
        part = part.replace("~1", "/").replace("~0", "~")
        doc = doc[int(part)] if isinstance(doc, list) else doc[part]
    return doc


def run_case(contract: str, spec: dict[str, Any]):  # type: ignore[no-untyped-def]
    if "document" in spec:
        return validate_value(contract, spec["document"])
    if "json" in spec:
        return validate_bytes(contract, spec["json"].encode("utf-8", "surrogatepass"))
    if "base64" in spec:
        return validate_bytes(contract, base64.b64decode(spec["base64"]))
    if "file" in spec:
        return validate_bytes(contract, read(spec["file"]))
    if "pad" in spec:
        data = read(spec["pad"]["file"])
        return validate_bytes(
            contract, data + b" " * (spec["pad"]["totalBytes"] - len(data))
        )
    if "repeat" in spec:
        doc = copy.deepcopy(spec["repeat"]["document"])
        items = pointer_get(doc, spec["repeat"]["pointer"])
        while len(items) < spec["repeat"]["count"]:
            items.append(copy.deepcopy(items[0]))
        return validate_value(contract, doc)
    raise ValueError(f"Unknown fixture input {sorted(spec)}")


class ContractFixtures(unittest.TestCase):
    def test_every_contract_has_fixtures(self) -> None:
        files = sorted(p.stem for p in (FIXTURES / "contracts").glob("*.json"))
        self.assertEqual(files, contract_ids())

    def test_fixture_cases(self) -> None:
        report: dict[str, str] = {}
        for path in sorted((FIXTURES / "contracts").glob("*.json")):
            fixture = json.loads(path.read_text("utf-8"))
            contract = fixture["contract"]
            for case in fixture["cases"]:
                label = f"{contract} / {case['name']}"
                with self.subTest(label):
                    result = run_case(contract, case["input"])
                    expect = case["expect"]
                    self.assertEqual(
                        result.valid, expect["valid"], f"{label}: {result}"
                    )
                    if not expect["valid"]:
                        self.assertEqual(
                            result.code, expect["code"], f"{label}: {result.errors}"
                        )
                        paths = [e["path"] for e in result.errors]
                        for p in expect.get("paths", []):
                            self.assertIn(p, paths, label)
                report[label] = "valid" if result.valid else str(result.code)
        out = os.environ.get("CONTRACT_REPORT")
        if out:
            Path(out).write_text(json.dumps(report, indent=1, sort_keys=True) + "\n")


class Digests(unittest.TestCase):
    digests = json.loads(read("digests.v1.json"))

    def test_request_digests(self) -> None:
        for case in self.digests["requestDigests"]:
            with self.subTest(case["name"]):
                if "error" in case:
                    error = (
                        MalformedJsonError
                        if case["error"] == "malformed_json"
                        else NoncanonicalValueError
                    )
                    with self.assertRaises(error):
                        canonical_json_text(case["json"])
                    continue
                self.assertEqual(canonical_json_text(case["json"]), case["canonical"])
                self.assertEqual(
                    request_sha256(loads_strict(case["json"])), case["sha256"]
                )
                self.assertEqual(
                    sha256_hex(case["canonical"].encode("utf-8")), case["sha256"]
                )

    def test_idempotency(self) -> None:
        for case in self.digests["idempotency"]:
            with self.subTest(case["name"]):
                self.assertEqual(
                    classify_replay(case["storedSha256"], json.loads(case["json"])),
                    case["expect"],
                )

    def test_manifest_bytes(self) -> None:
        for case in self.digests["manifestBytes"]:
            with self.subTest(case["name"]):
                if "sha256From" in case:
                    source = json.loads(read(case["sha256From"]["file"]))
                    declared = pointer_get(source, case["sha256From"]["pointer"])
                else:
                    declared = case["sha256"]
                self.assertEqual(
                    verify_stored_bytes(read(case["file"]), declared), case["expect"]
                )

    def test_sealed_inventory(self) -> None:
        for case in self.digests["sealedInventory"]:
            with self.subTest(case["name"]):
                found = check_sealed_inventory(
                    case["seal"], json.loads(read(case["declaration"]))
                )
                expect = case["expect"]
                if expect["valid"]:
                    self.assertIsNone(found)
                else:
                    self.assertEqual(found, (expect["code"], expect["path"]))


class Reproducible(unittest.TestCase):
    def test_fixtures_regenerate_exactly(self) -> None:
        script = CONTRACTS / "conformance" / "generate_fixtures.py"
        subprocess.run([sys.executable, "-I", str(script), "--check"], check=True)

    def test_unknown_contract_fails_closed(self) -> None:
        with self.assertRaises(LookupError):
            validate_value("http.nope.v1", {})


if __name__ == "__main__":
    unittest.main()
