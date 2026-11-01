import assert from "node:assert/strict";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import test from "node:test";
import {
  canonicalJsonText,
  classifyReplay,
  contractIds,
  requestSha256,
  sha256Hex,
  validateBytes,
  validateValue,
  verifyStoredBytes,
  type ValidationResult,
} from "../src/index.js";

const root = new URL("../conformance/fixtures/", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root));
const json = (path: string) => JSON.parse(read(path).toString("utf8"));
type Case = {
  name: string;
  input: Record<string, unknown>;
  expect: { valid: boolean; code?: string; paths?: string[] };
};

function pointerGet(doc: unknown, pointer: string): unknown {
  return pointer
    .split("/")
    .slice(1)
    .reduce(
      (node: any, part) => node[part.replace(/~1/g, "/").replace(/~0/g, "~")],
      doc,
    );
}

/** Shared fixture input forms; mirrored in the Python and Dart runners. */
export function runCase(
  contract: string,
  input: Record<string, any>,
): ValidationResult {
  if ("document" in input) return validateValue(contract, input.document);
  if ("json" in input)
    return validateBytes(contract, Buffer.from(input.json, "utf8"));
  if ("base64" in input)
    return validateBytes(contract, Buffer.from(input.base64, "base64"));
  if ("file" in input) return validateBytes(contract, read(input.file));
  if ("pad" in input) {
    const bytes = read(input.pad.file);
    const padded = Buffer.alloc(input.pad.totalBytes, 0x20);
    bytes.copy(padded);
    return validateBytes(contract, padded);
  }
  if ("repeat" in input) {
    const doc = structuredClone(input.repeat.document);
    const items = pointerGet(doc, input.repeat.pointer) as unknown[];
    while (items.length < input.repeat.count)
      items.push(structuredClone(items[0]));
    return validateValue(contract, doc);
  }
  throw new Error(`Unknown fixture input ${Object.keys(input)}`);
}

const fixtureFiles = readdirSync(new URL("contracts/", root)).sort();
const report: Record<string, string> = {};

test("every published contract has positive and negative fixtures", () => {
  assert.deepEqual(
    fixtureFiles.map((f) => f.replace(/\.json$/, "")),
    [...contractIds],
  );
  for (const file of fixtureFiles) {
    const cases: Case[] = json(`contracts/${file}`).cases;
    assert.ok(
      cases.some((c) => c.expect.valid),
      `${file} has a positive case`,
    );
    assert.ok(
      cases.some((c) => !c.expect.valid),
      `${file} has a negative case`,
    );
  }
});

for (const file of fixtureFiles) {
  const fixture = json(`contracts/${file}`);
  test(`fixtures ${fixture.contract}`, () => {
    for (const c of fixture.cases as Case[]) {
      const result = runCase(fixture.contract, c.input);
      const label = `${fixture.contract} / ${c.name}`;
      if (c.expect.valid) {
        assert.equal(result.valid, true, `${label}: ${JSON.stringify(result)}`);
      } else {
        assert.equal(result.valid, false, `${label} must be rejected`);
        if (!result.valid) {
          assert.equal(
            result.code,
            c.expect.code,
            `${label}: ${JSON.stringify(result.errors)}`,
          );
          const paths = result.errors.map((e) => e.path);
          for (const p of c.expect.paths ?? [])
            assert.ok(
              paths.includes(p),
              `${label}: expected path ${p} in ${paths}`,
            );
        }
      }
      report[label] = result.valid ? "valid" : result.code;
    }
  });
}

const digests = json("digests.v1.json");
test("sa-cjson-v1 request digests match independent golden values", () => {
  for (const c of digests.requestDigests) {
    if (c.error) {
      assert.throws(() => canonicalJsonText(c.json), { code: c.error }, c.name);
      continue;
    }
    const value = JSON.parse(c.json);
    assert.equal(canonicalJsonText(c.json), c.canonical, c.name);
    assert.equal(requestSha256(value), c.sha256, c.name);
    assert.equal(sha256Hex(Buffer.from(c.canonical, "utf8")), c.sha256, c.name);
  }
});
test("idempotent replay versus changed request digest", () => {
  for (const c of digests.idempotency)
    assert.equal(
      classifyReplay(c.storedSha256, JSON.parse(c.json)),
      c.expect,
      c.name,
    );
});
test("manifest digests are over exact stored bytes", () => {
  for (const c of digests.manifestBytes) {
    const declared = c.sha256From
      ? (pointerGet(json(c.sha256From.file), c.sha256From.pointer) as string)
      : c.sha256;
    assert.equal(verifyStoredBytes(read(c.file), declared), c.expect, c.name);
  }
});
test.after(() => {
  const out = process.env.CONTRACT_REPORT;
  if (out) {
    const sorted = Object.fromEntries(Object.entries(report).sort());
    writeFileSync(out, `${JSON.stringify(sorted, null, 1)}\n`);
  }
});
test("unknown contracts fail closed", () => {
  assert.throws(() => validateValue("http.nope.v1", {}), RangeError);
});
