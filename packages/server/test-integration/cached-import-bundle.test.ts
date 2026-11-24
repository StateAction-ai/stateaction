import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { ListObjectsV2Command } from "@aws-sdk/client-s3";
import {
  segmentId,
  sha256Hex,
  type ImportedCaptions,
  type ImportedHandPresence,
  type ImportedSegments,
  type ProcessingResultV1,
  type SegmentsV1,
} from "@stateaction/contracts";
import { checkAnnotations } from "../src/acceptance/service.js";
import {
  importCachedProcessing,
  type CachedImport,
} from "../src/cached-import.js";
import { outputObjectKey } from "../src/catalog/catalog.js";
import { seedLocalCatalog, SEED } from "../src/catalog/seed.js";
import { storageClient } from "../src/storage.js";
import { freshDatabase } from "./harness.js";
import { freshBucket } from "./storage-harness.js";

const fixtures = new URL(
  "../../contracts/conformance/fixtures/",
  import.meta.url,
);
async function valid<T>(contract: string): Promise<T> {
  return JSON.parse(
    await readFile(new URL(`contracts/${contract}.json`, fixtures), "utf8"),
  ).cases.find((entry: { expect: { valid: boolean } }) => entry.expect.valid)
    .input.document as T;
}

async function fixture(root: string) {
  const write = async (slot: string, data: unknown) => {
    const path = join(root, slot);
    const bytes = Buffer.from(
      typeof data === "string" ? data : JSON.stringify(data),
    );
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
    return sha256Hex(bytes);
  };
  const cpu = JSON.parse(
    await readFile(
      new URL("artifacts/processing-result.v1.json", fixtures),
      "utf8",
    ),
  ) as ProcessingResultV1;
  const hand = await valid<ImportedHandPresence>("artifacts.hand-presence.v2");
  hand.frame_count = cpu.clips[0]!.frame_count;
  for (const side of ["left", "right"] as const) {
    hand.lanes[side] = [
      {
        ...hand.lanes[side][0]!,
        end: { source_frame_id: null, timestamp_ns: null },
        frames: hand.frame_count,
      },
    ];
  }
  const simulation = { qualification: "simulation_only" };
  const originals: Record<string, string> = {
    "recording.mp4": await write("recording.mp4", "test video"),
    "source.mcap": await write("source.mcap", "test mcap"),
  };
  const recordingId = cpu.recording_id;
  const jobId = cpu.job_id;
  const attribution = {
    title: "Synthetic test bundle",
    dataset: "IndEgo",
    creators: "Integration test",
    sourceUrl: "https://huggingface.co/datasets/FraunhoferIPK/IndEgo",
    license: "CC BY 4.0",
    licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
    changes: "Test only",
  };
  const conversion = "diagnostics/hand_pose/source-conversion.json";
  originals[conversion] = await write(conversion, {
    source_sha256: originals["recording.mp4"],
    mcap_sha256: originals["source.mcap"],
  });
  const rawSegments = "diagnostics/segment/native-segments.json";
  originals[rawSegments] = await write(rawSegments, {
    source: { sha256: originals["recording.mp4"] },
  });
  cpu.source_manifest_sha256 = originals[conversion]!;
  cpu.verified_sources = [
    {
      ...cpu.verified_sources[0]!,
      size_bytes: "9",
      sha256: originals["source.mcap"]!,
    },
  ];
  const slotNames = new Map([
    ["hands.npz", "hand-arrays.npz"],
    ["hands.json", "hand-observations.json"],
    ["frame_map.json", "frame-map.json"],
    ["thumb.jpg", "thumbnail.jpg"],
  ]);
  for (const file of cpu.outputs) {
    const current = file.relative_path.split("/").at(-1)!;
    const slot = slotNames.get(current);
    if (slot) file.relative_path = join(dirname(file.relative_path), slot);
    const bytes = Buffer.from(file.relative_path);
    file.sha256 = await write(file.relative_path, file.relative_path);
    file.size_bytes = String(bytes.length);
    originals[file.relative_path] = file.sha256;
  }
  const originalManifest = "diagnostics/hand_pose/original-manifest.json";
  originals[originalManifest] = await write(originalManifest, cpu);
  const sourceHash = await write("source-manifest.json", {
    recordingId,
    videoSha256: originals["recording.mp4"],
    mcapSha256: originals["source.mcap"],
    simulation,
    attribution,
  });
  const seg = await valid<ImportedSegments>("artifacts.segments.v2");
  const cap = await valid<ImportedCaptions>("artifacts.captions.v2");
  for (const art of [seg, cap, hand]) {
    art.job_id = jobId;
    art.recording_id = recordingId;
    art.source_manifest_sha256 = sourceHash;
    art.producer.module_id = `imported_${art.producer.stage}`;
    art.producer.module_version = 1;
  }
  for (const row of seg.rows)
    row.segment_id = segmentId(
      sourceHash,
      "imported_segment@1",
      seg.producer.params_sha256,
      row.start.source_frame_id,
      row.end.source_frame_id,
    );
  cap.segments_sha256 = await write("segments.json", seg);
  const validCaption = cap.rows.find((row) => row.status === "complete")!;
  cap.rows = seg.rows
    .filter((row) => row.status === "ok")
    .map((row) => ({ ...validCaption, segment_id: row.segment_id }));
  const frames = hand.frame_count;
  const manifest: CachedImport = {
    schema: "stateaction.cached-processing-import.v1",
    source: "imported",
    jobId,
    recordingId,
    attribution,
    evidence: {},
    counts: {
      segments: cap.rows.length,
      failedWindows: seg.windows.failed.length,
      captions: cap.rows.length,
      failedCaptions: 0,
      handPoseFrames: frames,
    },
    originals,
    projection: {
      "source-manifest.json": sourceHash,
      "segments.json": cap.segments_sha256,
      "captions.json": await write("captions.json", cap),
      "hand-presence.json": await write("hand-presence.json", hand),
    },
  };
  await write("import.json", manifest);
  return { manifest, write, cpu };
}

test("cached bundles publish and replay without admitting a worker, and refuse altered evidence", async () => {
  const db = await freshDatabase();
  const bucket = await freshBucket();
  const client = storageClient(bucket.config, 60_000);
  const root = await mkdtemp(join(tmpdir(), "stateaction-import-test-"));
  try {
    await seedLocalCatalog(db.owner);
    const { manifest, write, cpu } = await fixture(root);
    const options = {
      pool: db.owner,
      config: bucket.config,
      client,
      root,
      staffEmail: SEED.users.staff.email,
      approve: false,
      hosted: false,
    };
    await assert.rejects(
      importCachedProcessing({ ...options, hosted: true }),
      /approved public IndEgo/,
    );
    const listed = await client.send(
      new ListObjectsV2Command({ Bucket: bucket.config.bucket }),
    );
    assert.equal(listed.Contents?.length ?? 0, 0);

    // Change the sealed count inside this isolated database after the CLI has
    // checked the inputs. The database itself must refuse the terminal job.
    await db.owner.query(`
      CREATE FUNCTION test_bad_import_count() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        NEW.evidence := jsonb_set(NEW.evidence, '{counts,segments}', '0');
        RETURN NEW;
      END $$;
      CREATE TRIGGER test_bad_import_count BEFORE INSERT ON cached_processing_imports
        FOR EACH ROW EXECUTE FUNCTION test_bad_import_count()
    `);
    await assert.rejects(importCachedProcessing(options), {
      sqlstate: "SAC04",
      message:
        "cached import needs its verified inventory, clips and staff seal",
    });
    await db.owner.query(
      "DROP TRIGGER test_bad_import_count ON cached_processing_imports",
    );
    const first = await importCachedProcessing(options);
    assert.equal(first.replayed, false);
    assert.equal((await importCachedProcessing(options)).replayed, true);
    assert.equal(
      (
        await db.app.query("SELECT segment_count FROM jobs WHERE id = $1", [
          manifest.jobId,
        ])
      ).rows[0].segment_count,
      manifest.counts.segments,
    );
    const lateFile = cpu.outputs[0]!;
    await assert.rejects(
      db.app.query(
        "INSERT INTO job_output_slots (job_id, slot, file_id, request_digest) VALUES ($1, 'late', $2, $3)",
        [manifest.jobId, lateFile.file_id, lateFile.sha256],
      ),
      { code: "SAC04", message: "cached import inventory is closed" },
    );
    await write("import.json", {
      ...manifest,
      attribution: { ...manifest.attribution, title: "Different" },
    });
    await assert.rejects(importCachedProcessing(options), /different import/);
    await write("import.json", {
      ...manifest,
      counts: { ...manifest.counts, segments: 0 },
    });
    await assert.rejects(importCachedProcessing(options), /counts differ/);
    await write("import.json", manifest);
    await bucket.put(
      outputObjectKey(
        manifest.jobId,
        lateFile.file_id,
        1,
        lateFile.relative_path,
      ),
      Buffer.alloc(Number(lateFile.size_bytes), 0x21),
    );
    await assert.rejects(
      importCachedProcessing(options),
      /Stored bytes differ/,
    );
  } finally {
    client.destroy();
    await Promise.all([
      db.close(),
      bucket.remove(),
      rm(root, { recursive: true, force: true }),
    ]);
  }
});

test("live and import acceptance reject producers from the other path", async () => {
  const live = await valid<SegmentsV1>("artifacts.segments.v1");
  const document = await valid<ImportedSegments>("artifacts.segments.v2");
  const ids = {
    jobId: document.job_id,
    recordingId: document.recording_id,
    sourceManifestSha256: document.source_manifest_sha256,
  };
  const verify = (source: "execution" | "imported", candidate: unknown) => {
    const bytes = Buffer.from(JSON.stringify(candidate));
    return checkAnnotations(
      { reader: { read: async () => bytes } },
      [
        {
          id: "file",
          role: "segments_json",
          slot: "segments.json",
          object_key: "key",
          sha256: sha256Hex(bytes),
          size_bytes: String(bytes.length),
          verified: true,
        },
      ],
      { segments: "file", captions: null, handPresence: null },
      ids,
      source,
    );
  };
  assert.deepEqual(await verify("imported", live), {
    kind: "rejected",
    code: "annotation_contract_invalid",
    detail: "segments.json: unsupported_version",
  });
  document.producer.module_id = "imported_segment";
  document.producer.module_version = 1;
  for (const row of document.rows)
    row.segment_id = segmentId(
      ids.sourceManifestSha256,
      "imported_segment@1",
      document.producer.params_sha256,
      row.start.source_frame_id,
      row.end.source_frame_id,
    );
  assert.deepEqual(await verify("execution", document), {
    kind: "rejected",
    code: "annotation_contract_invalid",
    detail: "segments.json: unsupported_version",
  });
});
