import { fixtureAcceptResult } from "../src/jobs/fixtures.js";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, test } from "node:test";
import { promisify } from "node:util";
import { registerRecording } from "../src/admission/recordings.js";
import { appendReview } from "../src/catalog/catalog.js";
import type { ReadSigner } from "../src/datasets/broker.js";
import {
  datasetRoutes,
  type DatasetAuthenticate,
} from "../src/datasets/http.js";
import {
  createActors,
  expectCode,
  freshDatabase,
  ownerPoolFor,
  processedRecording,
  type Actors,
  type TestDb,
} from "./harness.js";

/**
 * SA-47 operator dry run. It drives the REAL operator CLIs
 * (ingest-permission-cli.ts, dataset-sharing-cli.ts) as child processes with
 * the owner credential of a throwaway database, and the access SQL in
 * docs/components/pilot-operations.md, then checks the effect through the
 * restricted application role. Synthetic users and evidence references only;
 * the real Better Auth HTTP path is covered by web:auth-e2e.
 */
const exec = promisify(execFile);
const cliDir = new URL("..", import.meta.url).pathname;
let db: TestDb;
let actors: Actors;
// Each test gets its own throwaway database.
beforeEach(async () => {
  db = await freshDatabase();
  actors = await createActors(db.owner);
});
afterEach(() => db.close());

async function cli(file: string, args: string[]): Promise<any> {
  const { stdout } = await exec(
    process.execPath,
    ["--conditions=react-server", "--import", "tsx", `src/${file}.ts`, ...args],
    {
      cwd: cliDir,
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
      env: {
        PATH: process.env.PATH,
        APP_ENV: "local",
        MIGRATION_DATABASE_URL: db.ownerUrl,
      },
    },
  );
  return JSON.parse(stdout.trim().split("\n").at(-1)!);
}
const ingest = (...args: string[]) => cli("ingest-permission-cli", args);
const sharing = (...args: string[]) => cli("dataset-sharing-cli", args);

// The documented access SQL (section 1.1), with bound parameters.
const enableRole = (uid: string, role: string) =>
  db.owner.query(
    `INSERT INTO access (user_id, role, enabled, granted_by) VALUES ($1, $2, true, $3)
     ON CONFLICT (user_id, role)
     DO UPDATE SET enabled = true, granted_by = EXCLUDED.granted_by, updated_at = now()`,
    [uid, role, "operator-role-ref"],
  );
const disableRole = (uid: string, role: string) =>
  db.owner.query(
    `UPDATE access SET enabled = false, granted_by = $3, updated_at = now()
     WHERE user_id = $1 AND role = $2`,
    [uid, role, "operator-role-ref"],
  );

describe("pilot operator dry run", () => {
  test("collector: role plus recorded permission admit; revocation refuses", async () => {
    const deps = {
      pool: db.app,
      reader: {
        read: async (): Promise<Uint8Array> => {
          throw new Error("no storage in this dry run");
        },
      },
      config: {
        processingProfileRevision: "dry-run-1",
        supportedRgbProfiles: ["h264_mcap_v1"],
      },
    };
    const body = () => ({
      clientRecordingId: randomUUID(),
      captureFormat: "stateaction.capture.v1",
      rgbProfile: "h264_mcap_v1",
      startedAt: "2026-11-02T12:00:00Z",
      device: { model: "Synthetic", osVersion: "16", appVersion: "0.0.0" },
    });
    const me = { userId: actors.collector };

    // Enabled role alone is not admission.
    await expectCode(registerRecording(deps, me, body()), "forbidden");

    const ref = `dry-${randomUUID().slice(0, 8)}`;
    const recorded = await ingest(
      "record",
      "--ref",
      ref,
      "--owner",
      actors.collector,
      "--scope",
      "dry-run",
      "--evidence",
      "doc://synthetic/capture-and-processing",
      "--by",
      "operator-role-ref",
    );
    assert.equal(recorded.status, "active");
    assert.equal(recorded.coversProcessing, true);
    const listed = await ingest("list", "--owner", actors.collector);
    assert.deepEqual(
      listed.map((p: { permissionRef: string }) => p.permissionRef),
      [ref],
    );
    await registerRecording(deps, me, body());

    // Role disabled: refused although permission stays active.
    await disableRole(actors.collector, "collector");
    await expectCode(registerRecording(deps, me, body()), "forbidden");
    await enableRole(actors.collector, "collector");
    await registerRecording(deps, me, body());

    const revoked = await ingest(
      "revoke",
      "--ref",
      ref,
      "--by",
      "operator-role-ref",
      "--reason",
      "dry-run revocation",
    );
    assert.equal(revoked.status, "revoked");
    await expectCode(registerRecording(deps, me, body()), "forbidden");
    // Revocation is one-way.
    await assert.rejects(
      ingest("revoke", "--ref", ref, "--by", "x", "--reason", "again"),
    );

    // --capture-only records capture cover without processing cover.
    const capOnly = await ingest(
      "record",
      "--ref",
      `${ref}-b`,
      "--owner",
      actors.collector,
      "--scope",
      "dry-run",
      "--evidence",
      "doc://synthetic/capture-only",
      "--by",
      "operator-role-ref",
      "--capture-only",
    );
    assert.equal(capOnly.coversCapture, true);
    assert.equal(capOnly.coversProcessing, false);
  });

  test("customer: record, clear, grant, revoke and disable control visibility", async () => {
    const p = await processedRecording(db.app, actors, 2);
    await fixtureAcceptResult(ownerPoolFor(db.app), db.app, {
      jobId: p.jobId,
      manifestFileId: p.manifestFileId,
      manifestSha256: p.manifestSha256,
      clips: p.clips,
    });
    for (const c of p.clips)
      await appendReview(db.app, {
        reviewId: randomUUID(),
        clipId: c.clipId,
        jobId: p.jobId,
        resultManifestSha256: p.manifestSha256,
        reviewerUserId: actors.staff,
        expectedRevision: 0,
        decision: "approved",
        taskLabel: "dry-run",
        notes: "synthetic",
      });
    const authenticate: DatasetAuthenticate = async (request) => {
      const userId = request.headers.get("x-test-user")!;
      const { rows } = await db.owner.query(
        "SELECT 1 FROM access WHERE user_id = $1 AND enabled",
        [userId],
      );
      return rows.length
        ? { ok: true, principal: { userId } }
        : {
            ok: false,
            response: Response.json({ error: {} }, { status: 403 }),
          };
    };
    const signer: ReadSigner = {
      presignRead: async ({ key }) => `https://objects.test/${key}`,
    };
    const r = datasetRoutes({ pool: db.app, signer, authenticate });
    const as = (user: string, init: RequestInit = {}) =>
      new Request("http://x/y", {
        ...init,
        headers: {
          "x-test-user": user,
          ...(init.body ? { "content-type": "application/json" } : {}),
        },
      });
    const datasetId = randomUUID();
    await r.createDataset(
      as(actors.staff, {
        method: "POST",
        body: JSON.stringify({ datasetId, name: "Dry run" }),
      }),
    );
    const add = await r.addDatasetClips(
      as(actors.staff, {
        method: "POST",
        body: JSON.stringify({
          clipIds: p.clips.map((c) => c.clipId),
          expectedRevision: 1,
        }),
      }),
      datasetId,
    );
    assert.equal(add.status, 200);
    const visible = async () =>
      (await (await r.listDatasets(as(actors.customer))).json()).data.datasets
        .length;
    assert.equal(await visible(), 0, "no access before any evidence");

    // A disabled customer cannot be a recipient; enabling is by the access SQL.
    await disableRole(actors.customer, "customer");
    const base = [
      "--dataset",
      datasetId,
      "--recipient",
      actors.customer,
      "--evidence",
      "doc://synthetic/external-inspection",
      "--by",
      "operator-role-ref",
    ];
    await assert.rejects(sharing("record", "--ref", "dry-share-0", ...base));
    await enableRole(actors.customer, "customer");

    const ref1 = `dry-share-${randomUUID().slice(0, 6)}`;
    await sharing("record", "--ref", ref1, ...base);
    // Evidence alone, or evidence plus clearance, without a grant shows nothing.
    assert.equal(await visible(), 0);
    const cleared = await sharing(
      "clear",
      "--ref",
      ref1,
      "--all-members",
      "--by",
      "operator-role-ref",
    );
    assert.ok(cleared);
    assert.equal(await visible(), 0);
    await sharing("grant", "--ref", ref1, "--actor", actors.staff);
    assert.equal(await visible(), 1);
    const listed = await sharing("list", "--dataset", datasetId);
    assert.ok(JSON.stringify(listed).includes(ref1));

    // Revoke evidence: visibility ends and the grant is disabled with it.
    await sharing(
      "revoke",
      "--ref",
      ref1,
      "--by",
      "operator-role-ref",
      "--reason",
      "dry-run revoke",
    );
    assert.equal(await visible(), 0);

    // Fresh evidence, then `disable` withdraws the grant alone.
    const ref2 = `dry-share-${randomUUID().slice(0, 6)}`;
    await sharing("record", "--ref", ref2, ...base);
    await sharing(
      "clear",
      "--ref",
      ref2,
      "--clips",
      p.clips.map((c) => c.clipId).join(","),
      "--by",
      "operator-role-ref",
    );
    await sharing("grant", "--ref", ref2, "--actor", actors.staff);
    assert.equal(await visible(), 1);
    await sharing(
      "disable",
      "--dataset",
      datasetId,
      "--recipient",
      actors.customer,
      "--actor",
      actors.staff,
    );
    assert.equal(await visible(), 0);

    // A disabled customer role also ends visibility on the next request.
    await sharing("grant", "--ref", ref2, "--actor", actors.staff);
    assert.equal(await visible(), 1);
    await disableRole(actors.customer, "customer");
    assert.equal((await r.listDatasets(as(actors.customer))).status, 403);
  });
});
