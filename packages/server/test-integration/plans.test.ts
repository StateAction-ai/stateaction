import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { createDataset } from "../src/catalog/catalog.js";
import {
  DATASET_CLIPS_SQL,
  LIST_DATASETS_SQL,
} from "../src/datasets/queries.js";
import {
  grantDatasetAccess,
  recordSharingPermission,
} from "../src/datasets/operator.js";
import {
  fixtureAcceptResult,
  fixtureCloseOutputs,
} from "../src/jobs/fixtures.js";
import {
  createActors,
  freshDatabase,
  ownerPoolFor,
  processedRecording,
  writeArtifact,
  type Actors,
  type TestDb,
} from "./harness.js";

/**
 * Bounded catalog reads on a non-trivial catalog: plans must use the
 * membership/review indexes with LIMIT rather than scanning whole tables.
 */
const CLIPS = 6000;
let db: TestDb;
let actors: Actors;
const datasetId = randomUUID();
const BULK_PER_JOB = 320; // 6 files per clip + manifest within the 2000-file job cap
const jobIds: string[] = [];
before(async () => {
  db = await freshDatabase();
  actors = await createActors(db.owner);
  await createDataset(db.app, {
    datasetId,
    name: "Large",
    actorUserId: actors.staff,
  });
  // Bulk fixture through the same triggers and guards: per job the outputs are
  // reserved and completed while it runs, the inventory is closed, the job
  // moves to result_pending and the owner-only fixture proves the result
  // before the unchanged acceptProcessingResult inserts every clip.
  const names = [
    ["clip_mp4", "rgb.mp4"],
    ["hand_arrays_npz", "hand-arrays.npz"],
    ["hand_observations_json", "hand-observations.json"],
    ["frame_map_json", "frame-map.json"],
    ["thumbnail_jpeg", "thumbnail.jpg"],
    ["viewer_rrd", "viewer.rrd"],
  ];
  const owner = ownerPoolFor(db.app);
  for (let done = 0; done < CLIPS; ) {
    const n = Math.min(BULK_PER_JOB, CLIPS - done);
    const p = await processedRecording(db.app, actors, 1, { open: true });
    jobIds.push(p.jobId);
    await db.owner.query(
      `WITH g AS MATERIALIZED (
         SELECT gen_random_uuid() AS id, o.ord, r.role, r.name
         FROM generate_series(1, $3::int) o(ord) CROSS JOIN unnest($4::text[], $5::text[]) r(role, name)),
       ins AS (
         INSERT INTO files (id, recording_id, job_id, purpose, role, size_bytes, sha256, object_key, part_size_bytes, part_count)
         SELECT g.id, $1::uuid, $2::uuid, 'output', g.role, 100, encode(sha256(g.id::text::bytea), 'hex'),
                'jobs/' || $2::text || '/outputs/' || g.id || '/e1/' || g.role, 67108864, 1
         FROM g RETURNING id)
       INSERT INTO job_output_slots (job_id, slot, file_id, request_digest)
       SELECT $2::uuid, 'clips/' || lpad(g.ord::text, 3, '0') || '/' || g.name, g.id,
              encode(sha256(g.id::text::bytea), 'hex')
       FROM g JOIN ins USING (id)`,
      [
        p.recordingId,
        p.jobId,
        n - 1,
        names.map(([role]) => role),
        names.map(([, name]) => name),
      ],
    );
    await db.owner.query(
      "UPDATE files SET state = 'completed', observed_size_bytes = size_bytes, completed_at = now() WHERE job_id = $1 AND state = 'reserved'",
      [p.jobId],
    );
    const rows = await db.owner.query<{
      ord: number;
      role: string;
      id: string;
    }>(
      `SELECT substr(s.slot, 7, 3)::int AS ord, f.role, f.id FROM job_output_slots s
       JOIN files f ON f.id = s.file_id WHERE s.job_id = $1 AND f.role <> 'result_manifest'
         AND substr(s.slot, 7, 3)::int > 0`,
      [p.jobId],
    );
    const byOrd = new Map<number, Record<string, string>>();
    for (const r of rows.rows)
      byOrd.set(r.ord, { ...(byOrd.get(r.ord) ?? {}), [r.role]: r.id });
    const clips = [...p.clips];
    for (const [ord, f] of [...byOrd].sort((a, b) => a[0] - b[0]))
      clips.push({
        clipId: randomUUID(),
        ordinal: ord,
        title: `bulk ${done + ord}`,
        sourceStartNs: String(ord * 1000),
        sourceEndNs: String(ord * 1000 + 900),
        durationNs: "900",
        clockDomain: "test",
        raster: { width: 64, height: 48 },
        frameCount: 3,
        files: {
          rgbMp4: f.clip_mp4!,
          handArraysNpz: f.hand_arrays_npz!,
          handObservationsJson: f.hand_observations_json!,
          frameMapJson: f.frame_map_json!,
          thumbnailJpeg: f.thumbnail_jpeg!,
          viewerRrd: f.viewer_rrd!,
        },
      });
    await fixtureCloseOutputs(owner, {
      jobId: p.jobId,
      manifestFileId: p.manifestFileId,
      clips,
    });
    await db.owner.query(
      "UPDATE jobs SET state = 'result_pending' WHERE id = $1",
      [p.jobId],
    );
    // Clips are inserted while the result is pending with spread creation times
    // (the catalog reads order by them); the owner-only fixture then proves the
    // result facts and the unchanged helper marks the job succeeded.
    for (const [i, c] of clips.entries())
      await db.owner.query(
        `INSERT INTO clips (id, job_id, recording_id, ordinal, title, source_start_ns, source_end_ns, duration_ns,
           clock_domain, raster_width, raster_height, frame_count, rgb_mp4_file_id, hand_arrays_file_id,
           hand_observations_file_id, frame_map_file_id, thumbnail_file_id, viewer_rrd_file_id, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,900,'test',64,48,3,$8,$9,$10,$11,$12,$13, now() - ($14 || ' seconds')::interval)`,
        [
          c.clipId,
          p.jobId,
          p.recordingId,
          c.ordinal,
          c.title,
          c.sourceStartNs,
          c.sourceEndNs,
          c.files.rgbMp4,
          c.files.handArraysNpz,
          c.files.handObservationsJson,
          c.files.frameMapJson,
          c.files.thumbnailJpeg,
          c.files.viewerRrd,
          String(done + i),
        ],
      );
    await fixtureAcceptResult(owner, db.app, {
      jobId: p.jobId,
      manifestFileId: p.manifestFileId,
      manifestSha256: p.manifestSha256,
      clips: [],
    });
    await db.owner.query(
      `INSERT INTO reviews (id, clip_id, job_id, result_manifest_sha256, revision, reviewer_user_id, decision, task_label)
       SELECT gen_random_uuid(), id, job_id, $2, 1, $3, CASE WHEN ordinal % 6 = 0 THEN 'rejected' ELSE 'approved' END, 'bulk'
       FROM clips WHERE job_id = $1 AND ordinal % 6 <> 1`,
      [p.jobId, p.manifestSha256, actors.staff],
    );
    done += n;
  }
  // Fresh statistics so the fixture's own bulk joins are planned sanely.
  await db.owner.query("ANALYZE");
  // Approved half join the dataset.
  await db.owner.query(
    `INSERT INTO dataset_clips (dataset_id, clip_id, added_by, added_at)
     SELECT $1, clip_id, $2, now() - (row_number() OVER () || ' seconds')::interval FROM reviews
     WHERE job_id = ANY($3::uuid[]) AND decision = 'approved' AND random() < 0.5`,
    [datasetId, actors.staff, jobIds],
  );
  for (let i = 0; i < 40; i++)
    await createDataset(db.app, {
      datasetId: randomUUID(),
      name: `Extra ${i}`,
      actorUserId: actors.staff,
    });
  // Spread the remaining approved clips over the extra datasets.
  await db.owner.query(
    `WITH ds AS (SELECT id, row_number() OVER (ORDER BY id) - 1 AS k FROM datasets WHERE name LIKE 'Extra %'),
          cand AS (SELECT clip_id, row_number() OVER (ORDER BY clip_id) AS n FROM reviews
                   WHERE job_id = ANY($1::uuid[]) AND decision = 'approved'
                     AND clip_id NOT IN (SELECT clip_id FROM dataset_clips))
     INSERT INTO dataset_clips (dataset_id, clip_id, added_by)
     SELECT ds.id, cand.clip_id, $2 FROM cand JOIN ds ON ds.k = cand.n % 40`,
    [jobIds, actors.staff],
  );
  await db.owner.query("ANALYZE");
  // Operator setup (owner credential) after the bulk members exist: record
  // evidence, clear every current member, then grant.
  await recordSharingPermission(db.owner, {
    permissionRef: "plan-share",
    datasetId,
    recipientUserId: actors.customer,
    evidenceRef: "plan",
    recordedBy: "operator",
  });
  await db.owner.query(
    `INSERT INTO dataset_sharing_clearances (permission_id, clip_id, cleared_by)
     SELECT (SELECT id FROM dataset_sharing_permissions WHERE permission_ref = 'plan-share'),
            clip_id, 'operator'
     FROM dataset_clips WHERE dataset_id = $1`,
    [datasetId],
  );
  await grantDatasetAccess(db.owner, {
    permissionRef: "plan-share",
    actorUserId: actors.staff,
  });
  await db.owner.query("ANALYZE");
});
after(() => db.close());

type PlanNode = {
  "Node Type": string;
  "Relation Name"?: string;
  "Index Name"?: string;
  Plans?: PlanNode[];
};
const walk = (node: PlanNode, out: PlanNode[] = []) => {
  out.push(node);
  for (const child of node.Plans ?? []) walk(child, out);
  return out;
};

test("bounded catalog reads use indexes and LIMIT on a large catalog", async () => {
  const reads: Record<string, [string, unknown[]]> = {
    customerDatasetGrid: [
      DATASET_CLIPS_SQL,
      [actors.customer, datasetId, null, null, 25],
    ],
    staffAllClipsPending: [
      `SELECT c.id, coalesce(lr.decision, 'pending') FROM clips c
       LEFT JOIN LATERAL (SELECT decision, revision FROM reviews r WHERE r.clip_id = c.id ORDER BY r.revision DESC LIMIT 1) lr ON true
       WHERE coalesce(lr.decision, 'pending') = 'pending'
       ORDER BY c.created_at DESC, c.id DESC LIMIT 25`,
      [],
    ],
    customerDatasetList: [LIST_DATASETS_SQL, [actors.customer, null, null, 25]],
    staffDatasetListAfterCursor: [
      LIST_DATASETS_SQL,
      [
        actors.staff,
        new Date().toISOString(),
        "ffffffff-ffff-4fff-bfff-ffffffffffff",
        25,
      ],
    ],
    latestReview: [
      "SELECT decision FROM reviews WHERE clip_id = (SELECT id FROM clips ORDER BY created_at LIMIT 1) ORDER BY revision DESC LIMIT 1",
      [],
    ],
  };
  const plans: Record<string, unknown> = {};
  for (const [name, [sql, params]] of Object.entries(reads)) {
    const { rows } = await db.app.query(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`,
      params,
    );
    const plan = rows[0]["QUERY PLAN"][0];
    plans[name] = plan;
    const nodes = walk(plan.Plan);
    const seq = nodes.filter(
      (n) =>
        n["Node Type"] === "Seq Scan" &&
        ["clips", "reviews", "dataset_clips", "files"].includes(
          n["Relation Name"] ?? "",
        ),
    );
    assert.deepEqual(
      seq.map((n) => n["Relation Name"]),
      [],
      `${name} must not scan whole catalog tables: ${seq.map((n) => n["Relation Name"]).join(",")}`,
    );
    assert.ok(
      nodes.some((n) => n["Node Type"] === "Limit"),
      `${name} is bounded`,
    );
    assert.ok(
      plan["Execution Time"] < 250,
      `${name} took ${plan["Execution Time"]}ms`,
    );
  }
  const counts = await db.owner.query(
    "SELECT (SELECT count(*) FROM clips)::int AS clips, (SELECT count(*) FROM reviews)::int AS reviews, (SELECT count(*) FROM dataset_clips)::int AS members, (SELECT count(*) FROM files)::int AS files",
  );
  await writeArtifact("query-plans.json", { rows: counts.rows[0], plans });
});
