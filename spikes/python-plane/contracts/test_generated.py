import base64
import json
import unittest
from typing import get_args, get_overloads

from contracts.generate import API, CATALOG, HERE, HTTP_CONTRACTS, generate
from contracts.generated import JobsStageReceiptV1, parse_wire
from stateaction_contracts import ContractViolation

FIXTURES = API.parent / "conformance" / "fixtures"


def fixture_bytes(data):
    if "document" in data:
        return json.dumps(data["document"], separators=(",", ":")).encode()
    if "json" in data:
        return data["json"].encode("utf-8", "surrogatepass")
    if "base64" in data:
        return base64.b64decode(data["base64"])
    if "file" in data:
        return (FIXTURES / data["file"]).read_bytes()
    if "pad" in data:
        raw = (FIXTURES / data["pad"]["file"]).read_bytes()
        return raw + b" " * (data["pad"]["totalBytes"] - len(raw))
    if "repeat" in data:
        spec = data["repeat"]
        document = spec["document"]
        items = document
        for part in spec["pointer"].split("/")[1:]:
            key = part.replace("~1", "/").replace("~0", "~")
            items = items[int(key)] if isinstance(items, list) else items[key]
        items.extend([items[0]] * (spec["count"] - len(items)))
        return json.dumps(document, separators=(",", ":")).encode()
    raise ValueError("Unknown fixture input")


class GeneratedContractsTest(unittest.TestCase):
    def test_generated_module_is_current(self):
        self.assertEqual((HERE / "generated.py").read_text(), generate())

    def test_static_names_match_the_catalog(self):
        catalog = json.loads((API / CATALOG).read_text())["contracts"]
        generated = {
            get_args(variant.__annotations__["contract"])[0]
            for variant in get_overloads(parse_wire)
        }
        self.assertEqual(
            generated,
            {key for key in catalog if key.startswith("jobs.")} | HTTP_CONTRACTS,
        )
        self.assertIn("jobId", JobsStageReceiptV1.__required_keys__)

    def test_existing_fixtures_through_generated_parser(self):
        for variant in get_overloads(parse_wire):
            (contract,) = get_args(variant.__annotations__["contract"])
            cases = json.loads(
                (FIXTURES / "contracts" / f"{contract}.json").read_text()
            )["cases"]
            for case in cases:
                with self.subTest(contract=contract, case=case["name"]):
                    data = fixture_bytes(case["input"])
                    expected = case["expect"]
                    if expected["valid"]:
                        self.assertEqual(parse_wire(contract, data), json.loads(data))
                    else:
                        with self.assertRaises(ContractViolation) as failed:
                            parse_wire(contract, data)
                        result = failed.exception.result
                        self.assertEqual(result.code, expected["code"])
                        self.assertLessEqual(
                            set(expected.get("paths", [])),
                            {error["path"] for error in result.errors},
                        )
