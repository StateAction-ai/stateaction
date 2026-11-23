"""The pinned hosted config digest (config/render-deploy.json) equals the exporter's value (SA-41)."""

import contextlib
import io
import json
import unittest
from pathlib import Path

from stateaction_processing import artifact_cli


class RenderDeployPin(unittest.TestCase):
    def test_hosted_config_digest_pin_matches_the_exporter(self):
        pin = json.loads(
            (Path(__file__).parents[3] / "config/render-deploy.json").read_text()
        )["pins"]["configSha256"]
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            artifact_cli.main(["config-digest"])
        self.assertEqual(json.loads(out.getvalue())["config_sha256"], pin)


if __name__ == "__main__":
    unittest.main()
