// UNPUBLISHED proposal check (SA-20): the output upload schemas under
// docs/proposals/output-contract are validated here with a private Ajv and
// are NOT registered in catalog.v3, schemas.ts or schemas.lock.json.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import { Ajv2020 } from "ajv/dist/2020.js";
import { catalog, commonSchema } from "../src/schemas.js";

const dir = new URL(
  "../../../docs/proposals/output-contract/",
  import.meta.url,
);
const read = (name: string) =>
  JSON.parse(readFileSync(new URL(name, dir), "utf8")) as Record<
    string,
    unknown
  >;

const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
  validateFormats: false,
});
ajv.addSchema(commonSchema);
const create = ajv.compile(read("output-create.v1.schema.json"));
const plan = ajv.compile(read("output-plan.v1.schema.json"));
const fixture = (name: string) => read(`fixtures/${name}`);

test("proposal is not published in the current catalog", () => {
  const ids = Object.keys(catalog.contracts);
  assert.ok(!ids.some((id) => id.includes("output-")), ids.join());
});

test("output-create fixtures: one valid, every invalid refused", () => {
  assert.equal(create(fixture("output-create.valid.json")), true);
  for (const name of readdirSync(new URL("fixtures/", dir)).filter((n) =>
    n.startsWith("output-create.invalid-"),
  ))
    assert.equal(create(fixture(name)), false, name);
});

test("output-plan is closed and uses output roles, not source roles", () => {
  assert.equal(plan(fixture("output-plan.valid.json")), true);
  assert.equal(
    plan({ ...fixture("output-plan.valid.json"), role: "source_mcap" }),
    false,
  );
  assert.equal(
    plan({ ...fixture("output-plan.valid.json"), objectKey: "jobs/x" }),
    false,
  );
  assert.equal(
    plan({ ...fixture("output-plan.valid.json"), partSizeBytes: "1" }),
    false,
  );
});
