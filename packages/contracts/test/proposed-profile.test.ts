import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Ajv2020 } from "ajv/dist/2020.js";

// PROPOSED contracts (SA-16 profile update). They are deliberately outside
// api/, the catalog and schemas.lock.json: nothing here is published. They move
// verbatim into api/ + conformance/fixtures/contracts/ with catalog.v4, which
// is an exact superset of catalog.v3 and appears only after SA-19's v3 merge.
const base = new URL("../proposed/profile/", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, base), "utf8");
const common = JSON.parse(
  readFileSync(
    new URL("../api/common.v1.schema.json", import.meta.url),
    "utf8",
  ),
);

// Same options as src/validate.ts.
const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
  allowUnionTypes: true,
  validateFormats: false,
});
ajv.addSchema(common);
const ids = {
  "http.profile-update.v1": "http/profile-update.v1.schema.json",
  "http.profile.v1": "http/profile.v1.schema.json",
} as const;
for (const file of Object.values(ids)) ajv.addSchema(JSON.parse(read(file)));

type Case = {
  name: string;
  input: { document: unknown };
  expect: { valid: boolean; code?: string; paths?: string[] };
};

for (const [contract, file] of Object.entries(ids)) {
  const schema = JSON.parse(read(file));
  const validate = ajv.getSchema(schema.$id)!;
  const cases: Case[] = JSON.parse(read(`fixtures/${contract}.json`)).cases;
  test(`${contract}: ${cases.length} proposed fixture cases`, () => {
    for (const c of cases) {
      const valid = validate(c.input.document) as boolean;
      assert.equal(valid, c.expect.valid, c.name);
      if (!valid)
        for (const p of c.expect.paths ?? [])
          assert.ok(
            (validate.errors ?? []).some((e) => e.instancePath === p),
            `${c.name}: expected path ${p}`,
          );
    }
  });
}

test("fixtures are exactly reproducible from the generator", () => {
  execFileSync(
    "python3",
    [new URL("generate_fixtures.py", base).pathname, "--check"],
    { stdio: "pipe" },
  );
});

test("the request is closed, requires only name and carries no authority fields", () => {
  const schema = JSON.parse(read(ids["http.profile-update.v1"]));
  assert.deepEqual(schema.required, ["name"]);
  assert.deepEqual(Object.keys(schema.properties), ["name"]);
  assert.equal(schema.additionalProperties, false);
});

test("proposed schemas are not in the published catalog or lock", () => {
  const api = new URL("../api/", import.meta.url);
  const lock = readFileSync(new URL("schemas.lock.json", api), "utf8");
  assert.ok(!lock.includes("profile"), "lock must not list proposed schemas");
});

// Differential property: the shipped display-name rules and the proposed
// response schema agree. Pure module, no server imports.
import { parseDisplayName } from "../../server/src/auth/display-name.ts";

test("service rules and the response schema agree on a deterministic corpus", () => {
  const validate = ajv.getSchema(JSON.parse(read(ids["http.profile.v1"])).$id)!;
  const accepts = (name: string) =>
    validate({
      user: { id: "Xk9pQ2rT7vW1yZ4bN6mC8dF3hJ5kL0sA", email: "a@b.test", name },
    }) as boolean;
  const alphabet = [
    "a",
    "Z",
    "7",
    " ",
    "\t",
    "\n",
    " ",
    "　",
    " ",
    " ",
    "\u0000",
    "\u007f",
    "\u0085",
    "​",
    "‍",
    " ",
    "‮",
    "⁦",
    "⁠",
    "﻿",
    "́",
    "é",
    "e",
    "\u{1f600}",
    "漢",
    "-",
    "'",
    "<",
  ];
  let seed = 0x5eed;
  const next = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0);
  const corpus: string[] = [];
  for (let i = 0; i < 20000; i++) {
    const len = 1 + (next() % 6);
    let s = "";
    for (let j = 0; j < len; j++) s += alphabet[next() % alphabet.length];
    corpus.push(s);
  }
  corpus.push(
    "a".repeat(80),
    "a".repeat(81),
    "\u{1f600}".repeat(80),
    "\u{1f600}".repeat(81),
    "",
  );
  let acceptedByService = 0;
  for (const raw of corpus) {
    const parsed = parseDisplayName(raw);
    if (parsed.ok) {
      acceptedByService++;
      assert.equal(
        accepts(parsed.value),
        true,
        `service output ${JSON.stringify(parsed.value)} must satisfy the response contract`,
      );
    }
    // A response-valid NFC value is exactly a fixed point of the service.
    if (raw === raw.normalize("NFC") && accepts(raw)) {
      assert.deepEqual(parsed, { ok: true, value: raw }, JSON.stringify(raw));
    }
    // A stored value already outside the response contract must not come out
    // of the service unchanged.
    if (raw === raw.normalize("NFC") && !accepts(raw) && parsed.ok)
      assert.notEqual(parsed.value, raw, JSON.stringify(raw));
  }
  assert.ok(acceptedByService > 1000, `corpus too weak: ${acceptedByService}`);
});
