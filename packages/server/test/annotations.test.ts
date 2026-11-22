import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type pg from "pg";
import { ObjectReadUnavailableError } from "../src/admission/object-reader.js";
import {
  ObjectTooLargeError,
  type ObjectReader,
} from "../src/admission/recordings.js";
import { loadRecordingAnnotations } from "../src/annotations/annotations.js";
import { recordingMp4MaxBytes } from "../src/datasets/broker.js";

/**
 * SA-98 reader behaviour that needs no database: a stage that wrote no file is
 * null, and a file that exists but cannot be read or validated is an error,
 * never an empty result. SQL and authorization are covered by the integration
 * test against real Postgres.
 */
const JOB = "019a4b2c-3d4e-7f50-8a6b-7c8d9e0f1a2b";
const REC = "3f1b8c2e-6a4d-4e7b-9c1a-2b5d8e9f0a11";
const doc = (name: string) =>
  JSON.parse(
    readFileSync(
      new URL(
        `../../contracts/conformance/fixtures/contracts/${name}.json`,
        import.meta.url,
      ),
      "utf8",
    ),
  ).cases[0].input.document as Record<string, any>;

type Files = Record<string, Uint8Array | Error>;
const enc = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));

function fixture(files: Files, accepted = true) {
  const slots = Object.keys(files).map((slot) => ({
    slot,
    object_key: `k/${slot}`,
    size_bytes: "10",
  }));
  const pool = {
    async query(sql: string) {
      if (sql.includes("FROM recordings rec"))
        return { rows: accepted ? [{ job_id: JOB, recording_id: REC }] : [] };
      if (sql.includes("FROM job_output_slots")) return { rows: slots };
      return { rows: [{ rows: [] }] }; // getDagRun: the job has no recipe
    },
  } as unknown as pg.Pool;
  const reader: ObjectReader = {
    async read(key, max) {
      const entry = files[key.slice(2)];
      if (entry instanceof Error) throw entry;
      assert.ok(entry);
      assert.equal(max, 16 * 1024 * 1024, "bounded by the contract limit");
      return entry;
    },
  };
  return { pool, reader };
}
const load = (f: ReturnType<typeof fixture>) =>
  loadRecordingAnnotations(f, "staff-user", REC);

test("a stage without a file is null, never an empty document; unaccepted is null", async () => {
  assert.equal(await load(fixture({}, false)), null);
  const only = await load(
    fixture({ "hand-presence.json": enc(doc("artifacts.hand-presence.v1")) }),
  );
  assert.ok(only);
  assert.equal(only.segments, null);
  assert.equal(only.captions, null);
  assert.equal(only.dag_run, null);
  assert.equal(only.hand_presence?.frame_count, 600);
  assert.equal(only.job_id, JOB);
});

test("a file of another job or recording is refused", async () => {
  const f = fixture({
    "segments.json": enc({ ...doc("artifacts.segments.v1"), job_id: REC }),
  });
  await assert.rejects(load(f), /different job or recording/);
});

test("invalid bytes are an error naming the contract, not an empty document", async () => {
  const f = fixture({ "captions.json": new TextEncoder().encode("{nope") });
  await assert.rejects(
    load(f),
    /captions\.json is not a valid artifacts\.captions\.v1 document \(malformed_json\)/,
  );
});

test("storage failures map to retryable and conflict errors", async () => {
  await assert.rejects(
    load(fixture({ "segments.json": new ObjectReadUnavailableError("down") })),
    (e: any) => e.code === "provider_unavailable",
  );
  await assert.rejects(
    load(fixture({ "segments.json": new ObjectTooLargeError("big") })),
    (e: any) => e.code === "conflict" && /exceeds/.test(e.message),
  );
});

test("recording_mp4 limit: default 8 GiB, configurable, invalid fails closed", () => {
  assert.equal(recordingMp4MaxBytes({}), 8 * 1024 ** 3);
  assert.equal(
    recordingMp4MaxBytes({ STATEACTION_RECORDING_MP4_MAX_BYTES: "1048576" }),
    1048576,
  );
  for (const bad of ["0", "-1", "1.5", "8GiB", "9".repeat(17)])
    assert.throws(() =>
      recordingMp4MaxBytes({ STATEACTION_RECORDING_MP4_MAX_BYTES: bad }),
    );
});
