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

/**
 * SA-88 (migration 011): the replaced CHECK vocabularies match the common.v2
 * and heartbeat.v2 contracts (v2 roles are an exact superset of v1).
 */
const sql011 = await readFile(
  new URL("../migrations/011_stage_runs.sql", import.meta.url),
  "utf8",
);
const common2 = await schema("common.v2.schema.json");
const heartbeat2 = await schema("jobs/heartbeat.v2.schema.json");
const list011 = (marker: RegExp) => {
  const match = marker.exec(sql011);
  assert.ok(match?.[1], `CHECK list not found: ${marker}`);
  return [...match[1].matchAll(/'([A-Za-z_0-9.-]+)'/g)].map((m) => m[1]).sort();
};

test("011 file roles match the v1 source roles plus the common.v2 output roles", () => {
  assert.deepEqual(
    list011(/files_role_v2_check CHECK \(role IN \(([^)]*)\)\)/),
    sorted([
      ...common.$defs.sourceFileRole.enum,
      ...common2.$defs.outputFileRole.enum,
    ]),
  );
  assert.deepEqual(
    sorted(
      common.$defs.outputFileRole.enum.filter(
        (r: string) => !common2.$defs.outputFileRole.enum.includes(r),
      ),
    ),
    [],
  );
});
test("011 heartbeat phases, stages, stage states and GPU types match the contracts", () => {
  assert.deepEqual(
    list011(
      /jobs_heartbeat_phase_v2_check CHECK \(heartbeat_phase IN \(([^)]*)\)\)/,
    ),
    sorted(heartbeat2.properties.phase.enum),
  );
  assert.deepEqual(
    list011(/state text NOT NULL CHECK \(state IN \(([^)]*)\)\)/),
    sorted(common2.$defs.stageRunState.enum),
  );
  assert.deepEqual(
    list011(/stage text NOT NULL CHECK \(stage IN \(([^)]*)\)\)/),
    sorted(common2.$defs.stage.enum),
  );
  assert.deepEqual(
    list011(
      /requested_gpu text NOT NULL CHECK \(requested_gpu IN \(([^)]*)\)\)/,
    ),
    sorted(common2.$defs.gpuType.enum),
  );
});

/**
 * SA-103: the service-level worker output role allow-list is the common.v2
 * outputFileRole enum read from the published schema (no second list), and the
 * http.output-*.v2 contracts reference that same definition.
 */
test("the service output role allow-list equals common.v2 outputFileRole", async () => {
  const { OUTPUT_ROLES } = await import("../src/transport/service.ts");
  assert.deepEqual(
    [...OUTPUT_ROLES],
    common2.$defs.outputFileRole.enum,
    "service OUTPUT_ROLES drifted from common.v2",
  );
  for (const name of ["create", "plan"]) {
    const doc = await schema(`http/output-${name}.v2.schema.json`);
    assert.equal(
      doc.properties.role.$ref,
      "https://stateaction.ai/schemas/common.v2.json#/$defs/outputFileRole",
    );
  }
});
