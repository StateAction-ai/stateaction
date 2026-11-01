import json
import subprocess
import sys
import unittest
from stateaction_processing.cli import parse_request
from pathlib import Path
import hashlib

REQUEST = {"requestId": "519f19f0-1f9c-49f1-bf88-7343fd2dc358"}

class BoundaryTests(unittest.TestCase):
    def test_real_cli_stdin_roundtrip(self):
        run = subprocess.run([sys.executable, "-m", "stateaction_processing", "health"], input=json.dumps(REQUEST), capture_output=True, text=True, check=True)
        result = json.loads(run.stdout)
        self.assertEqual(result["requestId"], REQUEST["requestId"])
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["protocolVersion"], 1)

    def test_reject_malformed_or_oversized_input(self):
        for raw in ["{}", json.dumps(REQUEST | {"token": "secret"}), "x" * 4097]:
            run = subprocess.run([sys.executable, "-m", "stateaction_processing", "health"], input=raw, capture_output=True, text=True)
            self.assertNotEqual(run.returncode, 0)
            self.assertEqual(run.stdout, "")
            self.assertNotIn("secret", run.stderr)

    def test_uuid_contract(self):
        for value in [None, [], {"requestId": "not-uuid"}, {"requestId": REQUEST["requestId"].upper()}]:
            with self.assertRaises((ValueError, TypeError, AttributeError)):
                parse_request(value)

    def test_frozen_compatibility_snapshot(self):
        root = Path(__file__).resolve().parents[3]
        source = root / "spikes/android/processing/spike.py"
        snapshot = root / "workers/processing/src/stateaction_processing/_compat/android_processing.py"
        provenance = json.loads(snapshot.with_name("provenance.json").read_text())
        self.assertEqual(source.read_bytes(), snapshot.read_bytes())
        self.assertEqual(hashlib.sha256(snapshot.read_bytes()).hexdigest(), provenance["source_sha256"])
