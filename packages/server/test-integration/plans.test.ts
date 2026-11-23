import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import {
  DATASET_CLIPS_SQL,
  LIST_DATASETS_SQL,
} from "../src/datasets/queries.js";
import {
  seededDatabase,
  writeArtifact,
  type Actors,
  type TestDb,
} from "./harness.js";
import { seedLargeCatalog } from "./plans-seed.js";

/**
 * Bounded catalog reads on a non-trivial catalog: plans must use the
 * membership/review indexes with LIMIT rather than scanning whole tables.
 */
let db: TestDb;
let actors: Actors;
let datasetId: string;
before(async () => {
  // Cloned from the sealed large-catalog template; the 6000-clip seed lives in
  // plans-seed.ts and runs only when its content key (or a migration) changes.
  const seeded = await seededDatabase(
    "plans",
    [
      "packages/server/test-integration/plans-seed.ts",
      "packages/server/test-integration/harness.ts",
      "packages/server/src/catalog",
      "packages/server/src/jobs",
      "packages/server/src/datasets",
      "packages/server/src/admission",
    ],
    seedLargeCatalog,
  );
  db = seeded.db;
  actors = seeded.meta.actors;
  datasetId = seeded.meta.datasetId;
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

/** Plan outline with estimated vs actual cardinalities, for failure diagnosis. */
const outline = (
  node: PlanNode & {
    "Plan Rows"?: number;
    "Actual Rows"?: number;
    "Actual Loops"?: number;
  },
  depth = 0,
): string =>
  [
    `${"  ".repeat(depth)}${node["Node Type"]} ${node["Relation Name"] ?? ""} ${node["Index Name"] ?? ""} est=${node["Plan Rows"]} actual=${node["Actual Rows"]} loops=${node["Actual Loops"]}`,
    ...(node.Plans ?? []).map((c) => outline(c, depth + 1)),
  ].join("\n");

test("bounded catalog reads use indexes and LIMIT on a large catalog", async () => {
  const reads: Record<string, [string, unknown[]]> = {
    customerDatasetGrid: [
      DATASET_CLIPS_SQL,
      [actors.customer, datasetId, null, null, 25, "", ""],
    ],
    staffAllClipsPending: [
      `SELECT c.id, coalesce(lr.decision, 'pending') FROM clips c
       LEFT JOIN LATERAL (SELECT decision, revision FROM reviews r WHERE r.clip_id = c.id ORDER BY r.revision DESC LIMIT 1) lr ON true
       WHERE coalesce(lr.decision, 'pending') = 'pending'
       ORDER BY c.created_at DESC, c.id DESC LIMIT 25`,
      [],
    ],
    customerDatasetList: [
      LIST_DATASETS_SQL,
      [actors.customer, null, null, 25, ""],
    ],
    staffDatasetListAfterCursor: [
      LIST_DATASETS_SQL,
      [
        actors.staff,
        new Date().toISOString(),
        "ffffffff-ffff-4fff-bfff-ffffffffffff",
        25,
        "",
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
      `${name} must not scan whole catalog tables: ${seq.map((n) => n["Relation Name"]).join(",")}\n${outline(plan.Plan)}`,
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
