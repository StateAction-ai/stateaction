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
  createActors,
  freshDatabase,
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
before(async () => {
  db = await freshDatabase();
  actors = await createActors(db.owner);
  const p = await processedRecording(db.app, actors, 1);
  await createDataset(db.app, {
    datasetId,
    name: "Large",
    actorUserId: actors.staff,
  });
  // Bulk fixture through the same triggers: outputs reserved then completed,
  // clips inserted while the result is pending, then reviews and membership.
  const roles = [
    "clip_mp4",
    "hand_arrays_npz",
    "hand_observations_json",
    "frame_map_json",
    "thumbnail_jpeg",
    "viewer_rrd",
  ];
  await db.owner.query(
    `WITH f AS MATERIALIZED (
       SELECT gen_random_uuid() AS id, r.role FROM generate_series(1, $3) g CROSS JOIN unnest($4::text[]) r(role))
     INSERT INTO files (id, recording_id, job_id, purpose, role, size_bytes, sha256, object_key, part_size_bytes, part_count)
     SELECT f.id, $1::uuid, $2::uuid, 'output', f.role, 100, encode(sha256(f.id::text::bytea), 'hex'),
            'jobs/' || $2::text || '/outputs/' || f.id || '/e1/' || f.role, 67108864, 1
     FROM f`,
    [p.recordingId, p.jobId, CLIPS, roles],
  );
  await db.owner.query(
    "UPDATE files SET state = 'completed', observed_size_bytes = size_bytes, completed_at = now() WHERE job_id = $1 AND state = 'reserved'",
    [p.jobId],
  );
  // Fresh statistics so the fixture's own bulk join is planned sanely.
  await db.owner.query("ANALYZE files");
  await db.owner.query(
    "UPDATE jobs SET state = 'result_pending' WHERE id = $1",
    [p.jobId],
  );
  await db.owner.query(
    `WITH f AS (
       SELECT role, id, row_number() OVER (PARTITION BY role ORDER BY id) AS n FROM files
       WHERE job_id = $1 AND role <> 'result_manifest')
     INSERT INTO clips (id, job_id, recording_id, ordinal, title, source_start_ns, source_end_ns, duration_ns,
       clock_domain, raster_width, raster_height, frame_count, rgb_mp4_file_id, hand_arrays_file_id,
       hand_observations_file_id, frame_map_file_id, thumbnail_file_id, viewer_rrd_file_id, created_at)
     SELECT gen_random_uuid(), $1, $2, m.n + 10, 'bulk ' || m.n, m.n * 1000, m.n * 1000 + 900, 900, 'test', 64, 48, 3,
       m.id, a.id, o.id, fm.id, t.id, r.id, now() - (m.n || ' seconds')::interval
     FROM f m JOIN f a ON a.n = m.n AND a.role = 'hand_arrays_npz' JOIN f o ON o.n = m.n AND o.role = 'hand_observations_json'
     JOIN f fm ON fm.n = m.n AND fm.role = 'frame_map_json' JOIN f t ON t.n = m.n AND t.role = 'thumbnail_jpeg'
     JOIN f r ON r.n = m.n AND r.role = 'viewer_rrd'
     WHERE m.role = 'clip_mp4'`,
    [p.jobId, p.recordingId],
  );
  await db.owner.query(
    "UPDATE jobs SET state = 'succeeded', result_manifest_file_id = $2, result_manifest_sha256 = $3, finished_at = now() WHERE id = $1",
    [p.jobId, p.manifestFileId, p.manifestSha256],
  );
  // Two thirds approved, a sixth rejected, the rest pending; approved half join the dataset.
  await db.owner.query(
    `INSERT INTO reviews (id, clip_id, job_id, result_manifest_sha256, revision, reviewer_user_id, decision, task_label)
     SELECT gen_random_uuid(), id, job_id, $2, 1, $3, CASE WHEN ordinal % 6 = 0 THEN 'rejected' ELSE 'approved' END, 'bulk'
     FROM clips WHERE job_id = $1 AND ordinal % 6 <> 1`,
    [p.jobId, p.manifestSha256, actors.staff],
  );
  await db.owner.query(
    `INSERT INTO dataset_clips (dataset_id, clip_id, added_by, added_at)
     SELECT $1, clip_id, $2, now() - (row_number() OVER () || ' seconds')::interval FROM reviews
     WHERE job_id = $3 AND decision = 'approved' AND random() < 0.5`,
    [datasetId, actors.staff, p.jobId],
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
                   WHERE job_id = $1 AND decision = 'approved'
                     AND clip_id NOT IN (SELECT clip_id FROM dataset_clips))
     INSERT INTO dataset_clips (dataset_id, clip_id, added_by)
     SELECT ds.id, cand.clip_id, $2 FROM cand JOIN ds ON ds.k = cand.n % 40`,
    [p.jobId, actors.staff],
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
