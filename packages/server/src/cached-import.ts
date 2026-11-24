import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import {
  sha256Hex,
  validateBytes,
  type ProcessingResultV1,
} from "@stateaction/contracts";
import type pg from "pg";
import { checkAnnotations } from "./acceptance/service.js";
import { ObjectHashError, s3ObjectHasher } from "./acceptance/storage.js";
import {
  acceptCatalogResult,
  appendReview,
  createDataset,
  inTransaction,
  outputObjectKey,
  requireRole,
  sourceObjectKey,
  uuid,
  type ClipInput,
} from "./catalog/catalog.js";
import type { ServerConfig } from "./config.js";

export type CachedImport = {
  schema: "stateaction.cached-processing-import.v1";
  source: "imported";
  jobId: string;
  recordingId: string;
  durationSeconds?: number;
  attribution: {
    title: string;
    dataset: string;
    creators: string;
    sourceUrl: string;
    license: string;
    licenseUrl: string;
    changes: string;
  };
  evidence: Record<string, Record<string, unknown>>;
  counts: {
    segments: number;
    failedWindows: number;
    captions: number;
    failedCaptions: number;
    handPoseFrames: number;
  };
  originals: Record<string, string>;
  projection: Record<string, string>;
};

// Exact published MP4s cleared for the hosted research console.
const HOSTED_SOURCE_SHA256 = new Map([
  [
    "8bbe93c861461cea1d010d8e0901a62ebae5bd750cda042bec286c81af675cf8",
    "4e5e5a2abfe6d867a86ce8a254b1a85f225c0c1d57e05b2a74d8a538861f9e32",
  ],
]);
const HOSTED_DIAGNOSTICS = new Map([
  [
    "diagnostics/segment/native-segments.json",
    "bbfa52646400b42440b0170d542cffb2423ac8b62d106a5c9ea552dd50501a41",
  ],
  [
    "diagnostics/caption/native-captions.json",
    "8a39a75213d40ce9d7cf09e8026117ced9fa27d1bc549d4b1a52cf0c317ba386",
  ],
  [
    "diagnostics/hand_pose/original-manifest.json",
    "a8e5c81815cb2e7d50b968900e9cd57ede2b8a5679adc92fc79b301186f4103e",
  ],
  [
    "diagnostics/hand_pose/source-conversion.json",
    "0a3f889da9c95b2310884b8b200fcd4bcd0843c7e26c69c23c9776b067cf5e4c",
  ],
  [
    "diagnostics/hand_pose/source-simulation.json",
    "8d9b2dec2c67a8b24e548d2578b099bc5ffae72ec9e850ffdc506dbf421b5bce",
  ],
]);
const IMPORT_COLLECTOR = "stateaction-cached-import-source";
const CONTENT_TYPES: Record<string, string> = {
  mp4: "video/mp4",
  json: "application/json",
  jsonl: "text/plain",
  jpg: "image/jpeg",
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function stableId(name: string): string {
  const hex = sha256Hex(`stateaction-cached-import/v1:${name}`);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function extraRole(slot: string): string | undefined {
  if (
    /^diagnostics\/(segment|caption|hand_pose)\/[a-z0-9_.-]{1,64}$/.test(slot)
  )
    return "diagnostic_blob";
  return (
    {
      "segments.json": "segments_json",
      "captions.json": "captions_json",
      "hand-presence.json": "hand_presence_json",
      "recording.mp4": "recording_mp4",
      "result-manifest.json": "result_manifest",
    } as Record<string, string>
  )[slot];
}

type ImportFile = {
  id: string;
  role: string;
  slot: string;
  object_key: string;
  size_bytes: string;
  sha256: string;
  path: string;
  purpose: "source" | "output";
  verified: boolean;
};

async function inputFile(
  root: string,
  path: string,
  slot: string,
  role: string,
  sha256: string,
  jobId: string,
  recordId: string,
  id: string,
  purpose: ImportFile["purpose"],
): Promise<ImportFile> {
  assert(/^[0-9a-f]{64}$/.test(sha256), `Missing SHA-256 for ${slot}`);
  const file = join(root, path);
  const info = await stat(file);
  assert(
    info.isFile() && info.size > 0 && info.size <= 512 * 1024 ** 2,
    `Invalid file size for ${slot}`,
  );
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  assert(digest.digest("hex") === sha256, `Cached SHA-256 differs for ${slot}`);
  const object_key =
    purpose === "source"
      ? sourceObjectKey(recordId, id, 1, role)
      : outputObjectKey(jobId, id, 1, slot);
  return {
    id,
    role,
    slot,
    sha256,
    object_key,
    size_bytes: String(info.size),
    path: file,
    purpose,
    verified: true,
  };
}

async function prepareFiles(
  root: string,
  manifest: CachedImport,
  importHash: string,
) {
  const { originals, projection, jobId, recordingId } = manifest;
  const cpuBytes = await readFile(
    join(root, "diagnostics/hand_pose/original-manifest.json"),
  );
  const parsed = validateBytes("artifacts.processing-result.v1", cpuBytes);
  assert(parsed.valid, "Invalid original CPU manifest");
  const cpu = parsed.value as ProcessingResultV1;
  assert(
    cpu.job_id === jobId && cpu.recording_id === recordingId,
    "Original CPU manifest IDs differ",
  );
  const [mcap] = cpu.verified_sources;
  assert(
    cpu.verified_sources.length === 1 &&
      mcap &&
      mcap.sha256 === originals["source.mcap"],
    "Original MCAP differs",
  );
  assert(
    cpu.clips.length > 0 &&
      cpu.clips.reduce((total, clip) => total + clip.frame_count, 0) ===
        manifest.counts.handPoseFrames,
    "Original CPU frame count differs",
  );
  assert(
    cpu.source_manifest_sha256 ===
      originals["diagnostics/hand_pose/source-conversion.json"],
    "CPU manifest does not identify the original source conversion",
  );
  const native = JSON.parse(
    await readFile(
      join(root, "diagnostics/segment/native-segments.json"),
      "utf8",
    ),
  );
  const converted = JSON.parse(
    await readFile(
      join(root, "diagnostics/hand_pose/source-conversion.json"),
      "utf8",
    ),
  );
  assert(
    native.source?.sha256 === originals["recording.mp4"] &&
      converted.source_sha256 === originals["recording.mp4"] &&
      converted.mcap_sha256 === mcap.sha256,
    "Original segment and conversion source identities differ",
  );
  const bySlot = new Map(
    cpu.outputs.map((entry) => [entry.relative_path, entry]),
  );
  const files: ImportFile[] = [];
  const append = async (
    slot: string,
    sha256: string,
    role: string,
    path = slot,
    id = stableId(`${jobId}:${slot}`),
    purpose: ImportFile["purpose"] = "output",
  ) => {
    files.push(
      await inputFile(
        root,
        path,
        slot,
        role,
        sha256,
        jobId,
        recordingId,
        id,
        purpose,
      ),
    );
  };
  await append(
    "source.mcap",
    mcap.sha256,
    "source_mcap",
    "source.mcap",
    mcap.file_id,
    "source",
  );
  await append(
    "source-manifest.json",
    projection["source-manifest.json"]!,
    "source_manifest",
    "source-manifest.json",
    stableId(`${jobId}:source-manifest.json`),
    "source",
  );
  assert(
    files[0]!.size_bytes === mcap.size_bytes,
    "Original MCAP size differs",
  );
  for (const [slot, sha256] of Object.entries(originals)) {
    if (slot === "source.mcap") continue;
    if (slot === "diagnostics/hand_pose/source-conversion.json") {
      await append(
        slot,
        sha256,
        "recorder_metadata",
        slot,
        stableId(`${jobId}:recorder-metadata`),
        "source",
      );
      continue;
    }
    const original = bySlot.get(slot);
    const role = original?.role ?? extraRole(slot);
    assert(
      role &&
        (slot === "recording.mp4" || original || role === "diagnostic_blob"),
      "Unsupported original file slot",
    );
    assert(
      !original ||
        (original.sha256 === sha256 &&
          /^clips\/[0-9]{3}\/[a-z0-9.-]+$/.test(slot)),
      "Original CPU inventory differs",
    );
    await append(slot, sha256, role, slot, original?.file_id);
    assert(
      !original || original.size_bytes === files.at(-1)!.size_bytes,
      "Original CPU file size differs",
    );
  }
  assert(
    [...bySlot.keys()].every((slot) => Object.hasOwn(originals, slot)),
    "Missing original CPU file",
  );
  for (const slot of ["segments.json", "captions.json", "hand-presence.json"])
    await append(slot, projection[slot]!, extraRole(slot)!);
  await append(
    "result-manifest.json",
    importHash,
    "result_manifest",
    "import.json",
  );
  const clips: ClipInput[] = cpu.clips.map((clip) => ({
    clipId: clip.clip_id,
    ordinal: clip.clip_ordinal,
    title: clip.title,
    sourceStartNs: clip.source_start_ns,
    sourceEndNs: clip.source_end_ns,
    durationNs: clip.duration_ns,
    clockDomain: clip.clock_domain,
    raster: clip.raster,
    frameCount: clip.frame_count,
    files: {
      rgbMp4: clip.files.rgb_mp4,
      handArraysNpz: clip.files.hand_arrays_npz,
      handObservationsJson: clip.files.hand_observations_json,
      frameMapJson: clip.files.frame_map_json,
      thumbnailJpeg: clip.files.thumbnail_jpeg,
      viewerRrd: clip.files.viewer_rrd,
    },
  }));
  return { files, clips };
}

async function uploadVerified(
  config: ServerConfig,
  client: S3Client,
  files: ImportFile[],
) {
  const hasher = s3ObjectHasher(config, { client });
  for (const file of files) {
    const size = Number(file.size_bytes);
    const verify = async () => {
      const got = await hasher.hash(file.object_key, size, 60_000);
      assert(
        got.sha256 === file.sha256,
        `Stored bytes differ for ${file.slot}`,
      );
    };
    try {
      await verify();
      continue;
    } catch (error) {
      if (
        !(error instanceof ObjectHashError) ||
        error.code !== "object_missing"
      )
        throw error;
    }
    const body = createReadStream(file.path);
    try {
      await client.send(
        new PutObjectCommand({
          Bucket: config.bucket,
          Key: file.object_key,
          Body: body,
          ContentLength: size,
          ContentType:
            CONTENT_TYPES[file.slot.split(".").at(-1) ?? ""] ??
            "application/octet-stream",
          IfNoneMatch: "*",
        }),
      );
    } catch (error) {
      if (
        (error as { $metadata?: { httpStatusCode?: number } }).$metadata
          ?.httpStatusCode !== 412
      )
        throw error;
    } finally {
      body.destroy();
    }
    await verify();
  }
}

export async function importCachedProcessing(options: {
  pool: pg.Pool;
  config: ServerConfig;
  client: S3Client;
  root: string;
  staffEmail: string;
  hosted: boolean;
  approve: boolean;
}) {
  const { pool, config, client, root, staffEmail } = options;
  const importBytes = await readFile(join(root, "import.json"));
  assert(importBytes.length <= 56 * 1024, "Import manifest is too large");
  const manifest = JSON.parse(importBytes.toString("utf8")) as CachedImport;
  assert(
    manifest.schema === "stateaction.cached-processing-import.v1" &&
      manifest.source === "imported",
    "Invalid cached import manifest",
  );
  const { jobId, recordingId } = manifest;
  uuid(jobId, "jobId");
  uuid(recordingId, "recordingId");
  assert(
    manifest.attribution?.title &&
      manifest.attribution.creators &&
      manifest.attribution.license,
    "Source attribution is required",
  );
  if (options.hosted)
    assert(
      HOSTED_SOURCE_SHA256.get(manifest.originals["recording.mp4"] ?? "") ===
        manifest.originals["source.mcap"] &&
        Boolean(manifest.originals["source.mcap"]) &&
        manifest.attribution.dataset === "IndEgo" &&
        manifest.attribution.sourceUrl ===
          "https://huggingface.co/datasets/FraunhoferIPK/IndEgo" &&
        manifest.attribution.license === "CC BY 4.0",
      "The hosted import supports the approved public IndEgo media only",
    );

  if (options.hosted) {
    const diagnostics = Object.entries(manifest.originals).filter(([slot]) =>
      slot.startsWith("diagnostics/"),
    );
    assert(
      diagnostics.length === HOSTED_DIAGNOSTICS.size &&
        diagnostics.every(
          ([slot, sha]) => HOSTED_DIAGNOSTICS.get(slot) === sha,
        ),
      "Hosted diagnostics must match the approved IndEgo inventory",
    );
  }
  const manifestHash = sha256Hex(importBytes);
  const { files, clips } = await prepareFiles(root, manifest, manifestHash);
  const bySlot = new Map(files.map((file) => [file.slot, file]));
  const source = bySlot.get("source-manifest.json")!;
  const result = bySlot.get("result-manifest.json")!;
  const sourceDoc = JSON.parse(await readFile(source.path, "utf8"));
  assert(
    sourceDoc.recordingId === recordingId &&
      sourceDoc.videoSha256 === bySlot.get("recording.mp4")?.sha256 &&
      sourceDoc.mcapSha256 === bySlot.get("source.mcap")?.sha256 &&
      sourceDoc.simulation?.qualification === "simulation_only",
    "Source manifest identity mismatch",
  );
  const staff = (
    await pool.query<{ id: string }>(
      `SELECT id FROM "user" WHERE lower(email) = lower($1) AND catalog_has_role(id, 'staff')`,
      [staffEmail],
    )
  ).rows;
  assert(
    staff.length === 1,
    "The operator email must resolve to one enabled staff user",
  );
  const staffId = staff[0]!.id;
  const existingImport = async (db: Pick<pg.Pool, "query">) => {
    const existing = (
      await db.query<{ hash: string; state: string }>(
        `SELECT i.manifest_sha256 AS hash, j.state FROM cached_processing_imports i
       JOIN jobs j ON j.id = i.job_id WHERE i.job_id = $1`,
        [jobId],
      )
    ).rows[0];
    assert(
      !existing ||
        (existing.hash === manifestHash && existing.state === "succeeded"),
      "Job ID already identifies a different import",
    );
    const collisions = await db.query(
      "SELECT 1 FROM jobs WHERE id = $1 UNION ALL SELECT 1 FROM recordings WHERE id = $2",
      [jobId, recordingId],
    );
    assert(
      existing || collisions.rowCount === 0,
      "An existing job or recording uses this import ID",
    );
    return existing;
  };
  const checked = await checkAnnotations(
    {
      reader: {
        read: async (key, maxBytes) => {
          const file = files.find((entry) => entry.object_key === key);
          assert(
            file && Number(file.size_bytes) <= maxBytes,
            "Invalid annotation file bound",
          );
          return readFile(file.path);
        },
      },
    },
    files.map((file) => ({ ...file, original_job_id: null })),
    {
      segments: bySlot.get("segments.json")!.id,
      captions: bySlot.get("captions.json")!.id,
      handPresence: bySlot.get("hand-presence.json")!.id,
    },
    { jobId, recordingId, sourceManifestSha256: source.sha256 },
    "imported",
  );
  assert(
    checked.kind === "ok",
    `Imported annotations failed acceptance: ${checked.kind === "rejected" ? [checked.code, checked.detail].filter(Boolean).join(" ") : checked.kind}`,
  );
  assert(
    checked.counts.segmentCount === manifest.counts.segments &&
      checked.counts.failedWindowCount === manifest.counts.failedWindows &&
      checked.counts.captionCount === manifest.counts.captions &&
      checked.counts.captionFailedCount === manifest.counts.failedCaptions,
    "Accepted annotation counts differ from the import manifest",
  );
  const presence = JSON.parse(
    await readFile(bySlot.get("hand-presence.json")!.path, "utf8"),
  );
  assert(
    presence.frame_count === manifest.counts.handPoseFrames,
    "Hand presence frame count differs from the import manifest",
  );
  await existingImport(pool);
  await uploadVerified(config, client, files);
  const replayed = await inTransaction(pool, async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(746014, hashtext($1))", [
      jobId,
    ]);
    await requireRole(tx, staffId, "staff");
    const existing = await existingImport(tx);
    if (existing) {
      const stored = await tx.query<{
        slot: string;
        sha256: string;
        object_key: string;
      }>(
        `SELECT coalesce(s.slot, CASE f.role WHEN 'source_mcap' THEN 'source.mcap'
                  WHEN 'source_manifest' THEN 'source-manifest.json'
                  WHEN 'recorder_metadata' THEN 'diagnostics/hand_pose/source-conversion.json' END) AS slot, f.sha256, f.object_key
         FROM files f LEFT JOIN job_output_slots s ON s.file_id = f.id
         WHERE f.recording_id = $1 AND f.state = 'verified'`,
        [recordingId],
      );
      assert(
        stored.rowCount === files.length &&
          stored.rows.every(
            (f) =>
              bySlot.get(f.slot)?.sha256 === f.sha256 &&
              bySlot.get(f.slot)?.object_key === f.object_key,
          ),
        "Published import inventory differs from the verified bundle",
      );
      return true;
    }

    await tx.query(
      `INSERT INTO "user" (id, name, email, "emailVerified")
       VALUES ($1, 'Imported from cached results', 'cached-import@stateaction.invalid', false)
       ON CONFLICT (id) DO NOTHING`,
      [IMPORT_COLLECTOR],
    );
    await tx.query(
      `INSERT INTO access (user_id, role, granted_by) VALUES ($1, 'collector', $2)
       ON CONFLICT (user_id, role) DO NOTHING`,
      [IMPORT_COLLECTOR, staffId],
    );
    await tx.query(
      `INSERT INTO recordings
         (id, owner_user_id, client_recording_id, capture_format, rgb_profile, started_at, device, simulation, imported_from_cache)
       VALUES ($1, $2, $1, 'stateaction.capture.v1', 'h264_mcap_simulation_v1', now(), $3, $4, true)`,
      [
        recordingId,
        IMPORT_COLLECTOR,
        { model: manifest.attribution.title, source: "imported" },
        sourceDoc.simulation,
      ],
    );
    const storeRow = async (file: ImportFile) => {
      await tx.query(
        `INSERT INTO files
           (id, recording_id, job_id, purpose, role, size_bytes, sha256, object_key, part_size_bytes,
            part_count, client_upload_id, request_digest)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$6,1,$9,$10)`,
        [
          file.id,
          recordingId,
          file.purpose === "output" ? jobId : null,
          file.purpose,
          file.role,
          file.size_bytes,
          file.sha256,
          file.object_key,
          file.purpose === "source" ? file.id : null,
          file.purpose === "source" ? file.sha256 : null,
        ],
      );
      await tx.query(
        `UPDATE files SET state = 'verified', observed_size_bytes = size_bytes, completed_at = now()
         WHERE id = $1`,
        [file.id],
      );
      if (file.purpose === "output")
        await tx.query(
          "INSERT INTO job_output_slots (job_id, slot, file_id, request_digest) VALUES ($1,$2,$3,$4)",
          [
            jobId,
            file.slot,
            file.id,
            sha256Hex(
              JSON.stringify([
                file.slot,
                file.role,
                file.size_bytes,
                file.sha256,
              ]),
            ),
          ],
        );
    };
    for (const file of files.filter((f) => f.purpose === "source"))
      await storeRow(file);
    await tx.query(
      `UPDATE recordings SET status = 'sealed', source_manifest_file_id = $2, source_manifest_sha256 = $3
       WHERE id = $1`,
      [recordingId, source.id, source.sha256],
    );
    await tx.query(
      `INSERT INTO jobs (id, kind, recording_id, profile_revision, source_manifest_sha256)
       VALUES ($1, 'cached_import', $2, 'cached-import-v1', $3)`,
      [jobId, recordingId, source.sha256],
    );
    await tx.query(
      "UPDATE recordings SET current_job_id = $2, status = 'processing' WHERE id = $1",
      [recordingId, jobId],
    );
    await tx.query("UPDATE jobs SET state = 'result_pending' WHERE id = $1", [
      jobId,
    ]);
    for (const file of files.filter((f) => f.purpose === "output"))
      await storeRow(file);
    await tx.query(
      `INSERT INTO cached_processing_imports
         (job_id, manifest_file_id, manifest_sha256, inventory_sha256, clip_count, evidence, imported_by)
       VALUES ($1,$2,$3,job_output_inventory_digest($1),$4,$5,$6)`,
      [jobId, result.id, manifestHash, clips.length, manifest, staffId],
    );
    await acceptCatalogResult(tx, {
      jobId,
      manifestFileId: result.id,
      manifestSha256: manifestHash,
      clips,
      annotations: manifest.counts,
    });
    await tx.query(
      `INSERT INTO recording_result_selections (recording_id, seq, job_id, reason, kind)
       VALUES ($1, 1, $2, 'First accepted cached result', 'auto')`,
      [recordingId, jobId],
    );
    return false;
  });
  if (options.approve) {
    const datasetId = stableId(`${jobId}:dataset`);
    const existingDataset = await pool.query(
      "SELECT 1 FROM datasets WHERE id = $1",
      [datasetId],
    );
    if (!existingDataset.rowCount)
      await createDataset(pool, {
        datasetId,
        actorUserId: staffId,
        name: manifest.attribution.title,
      });
    for (const clip of clips) {
      const reviewId = stableId(`${clip.clipId}:review`);
      const status = (
        await pool.query<{ revision: number; id: string }>(
          "SELECT revision, id FROM reviews WHERE clip_id = $1 ORDER BY revision DESC LIMIT 1",
          [clip.clipId],
        )
      ).rows[0];
      if (status) continue;
      const dataset = (
        await pool.query<{ revision: number }>(
          "SELECT revision FROM datasets WHERE id = $1",
          [datasetId],
        )
      ).rows[0]!;
      await appendReview(pool, {
        clipId: clip.clipId,
        jobId,
        resultManifestSha256: manifestHash,
        reviewerUserId: staffId,
        reviewId,
        expectedRevision: 0,
        decision: "approved",
        taskLabel: "Imported egocentric research clip",
        notes:
          "Bulk approval during the cached import for the staff research dataset.",
        datasetSelection: {
          datasetIds: [datasetId],
          expectedRevisions: { [datasetId]: dataset.revision },
        },
      });
    }
  }
  return {
    ...manifest,
    manifestSha256: manifestHash,
    verifiedFiles: files.length,
    replayed,
  };
}
