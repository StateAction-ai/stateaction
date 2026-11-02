import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

/**
 * The catalog CHECK vocabularies must match the published v1 contract enums
 * (packages/contracts/api). export_release is deliberately excluded until the
 * Dataset-version follow-up adds releases.
 */
const sql = await readFile(
  new URL("../migrations/003_catalog.sql", import.meta.url),
  "utf8",
);
const schema = async (path: string) =>
  JSON.parse(
    await readFile(
      new URL(`../../contracts/api/${path}`, import.meta.url),
      "utf8",
    ),
  );
const common = await schema("common.v1.schema.json");
const recording = await schema("http/recording.v1.schema.json");
const checkList = (marker: RegExp) => {
  const match = marker.exec(sql);
  assert.ok(match?.[1], `CHECK list not found: ${marker}`);
  return [...match[1].matchAll(/'([a-z_0-9.]+)'/g)].map((m) => m[1]).sort();
};
const sorted = (values: string[]) => [...values].sort();

test("file roles match source and output contract roles", () => {
  assert.deepEqual(
    checkList(
      /role text NOT NULL CHECK \(role IN \((\s*'source_manifest'[^)]*)\)\)/,
    ),
    sorted([
      ...common.$defs.sourceFileRole.enum,
      ...common.$defs.outputFileRole.enum,
    ]),
  );
});
test("recording status and file state match the recording contract", () => {
  assert.deepEqual(
    checkList(
      /status text NOT NULL DEFAULT 'registered' CHECK \(status IN \(([^)]*)\)\)/,
    ),
    sorted(recording.properties.status.enum),
  );
  assert.deepEqual(
    checkList(
      /state text NOT NULL DEFAULT 'reserved' CHECK \(state IN \(([^)]*)\)\)/,
    ),
    sorted(recording.properties.files.items.properties.state.enum),
  );
});
test("job states match and job kinds are the MVP subset", () => {
  assert.deepEqual(
    checkList(
      /state text NOT NULL DEFAULT 'queued' CHECK \(state IN \(([^)]*)\)\)/,
    ),
    sorted(common.$defs.jobState.enum),
  );
  const kinds = checkList(/kind text NOT NULL CHECK \(kind = ('[a-z_]+')\)/);
  assert.deepEqual(kinds, ["process_recording"]);
  assert.ok(common.$defs.jobKind.enum.includes("process_recording"));
  assert.doesNotMatch(sql, /CREATE TABLE releases/);
});
