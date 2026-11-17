import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { after, before, describe, test } from "node:test";
import {
  acceptProcessingResult,
  appendReview,
} from "../src/catalog/catalog.js";
import { issueRead, S3ReadSigner } from "../src/datasets/broker.js";
import {
  addDatasetMembers,
  createDatasetRecord,
} from "../src/datasets/mutations.js";
import {
  clearClips,
  grantDatasetAccess,
  recordSharingPermission,
  revokeSharingPermission,
} from "../src/datasets/operator.js";
import { storageClient } from "../src/storage.js";
import {
  createActors,
  expectCode,
  freshDatabase,
  processedRecording,
  type Actors,
  type TestDb,
} from "./harness.js";
import { freshBucket, type TestBucket } from "./storage-harness.js";

/**
 * Real S3 (the bounded shared SeaweedFS in the validation environment): the
 * broker's presigned GET must return exactly the synthetic fixture bytes
 * before expiry, expire on schedule, and be unusable for any other key or
 * after tampering. Fixture bytes are synthetic placeholders, not media.
 */
let db: TestDb;
let actors: Actors;
let bucket: TestBucket;
before(async () => {
  db = await freshDatabase();
  actors = await createActors(db.owner);
  bucket = await freshBucket();
});
after(async () => {
  await bucket.remove();
  await db.close();
});

describe("real signed reads", () => {
  test("thumbnail and viewer fetch, expiry, tamper and revocation", async () => {
    const p = await processedRecording(db.app, actors, 1);
    await acceptProcessingResult(db.app, {
      jobId: p.jobId,
      manifestFileId: p.manifestFileId,
      manifestSha256: p.manifestSha256,
      clips: p.clips,
    });
    const clip = p.clips[0]!;
    await appendReview(db.app, {
      reviewId: randomUUID(),
      clipId: clip.clipId,
      jobId: p.jobId,
      resultManifestSha256: p.manifestSha256,
      reviewerUserId: actors.staff,
      expectedRevision: 0,
      decision: "approved",
      taskLabel: "synthetic",
    });
    const datasetId = randomUUID();
    await createDatasetRecord(db.app, {
      datasetId,
      name: "Signed",
      actorUserId: actors.staff,
    });
    await addDatasetMembers(db.app, {
      datasetId,
      clipIds: [clip.clipId],
      expectedRevision: 1,
      actorUserId: actors.staff,
    });
    const permissionRef = `signed-${randomUUID().slice(0, 8)}`;
    await recordSharingPermission(db.owner, {
      permissionRef,
      datasetId,
      recipientUserId: actors.customer,
      evidenceRef: "doc:signed",
      recordedBy: "operator",
    });
    await clearClips(db.owner, {
      permissionRef,
      allCurrentMembers: true,
      clearedBy: "operator",
    });
    await grantDatasetAccess(db.owner, {
      permissionRef,
      actorUserId: actors.staff,
    });

    const keyOf = async (id: string) =>
      (
        await db.owner.query<{ object_key: string }>(
          "SELECT object_key FROM files WHERE id = $1",
          [id],
        )
      ).rows[0]!.object_key;
    const thumbBytes = Buffer.alloc(100, 0xd8);
    const rrdBytes = Buffer.alloc(100, 0x52);
    await bucket.put(await keyOf(clip.files.thumbnailJpeg), thumbBytes);
    await bucket.put(await keyOf(clip.files.viewerRrd), rrdBytes);
    await bucket.put(
      await keyOf(clip.files.rgbMp4),
      Buffer.from("raw-not-readable"),
    );

    const signer = new S3ReadSigner(
      storageClient(bucket.config, 15_000, bucket.config.publicEndpoint),
      bucket.config.bucket,
    );
    const deps = { pool: db.app, signer, ttlSeconds: 2 };
    const thumb = await issueRead(deps, {
      viewerUserId: actors.customer,
      clipId: clip.clipId,
      role: "thumbnail_jpeg",
      datasetId,
    });
    const viewer = await issueRead(deps, {
      viewerUserId: actors.customer,
      clipId: clip.clipId,
      role: "viewer_rrd",
    });
    const fetched = await fetch(thumb.url);
    assert.equal(fetched.status, 200);
    assert.deepEqual(Buffer.from(await fetched.arrayBuffer()), thumbBytes);
    assert.match(fetched.headers.get("content-type") ?? "", /image\/jpeg/);
    const rrd = await fetch(viewer.url);
    assert.equal(rrd.status, 200);
    assert.deepEqual(Buffer.from(await rrd.arrayBuffer()), rrdBytes);
    // The URL names only its own object: changing the key breaks the signature.
    const other = new URL(thumb.url);
    other.pathname = other.pathname.replace(/[^/]+$/, "other");
    assert.equal((await fetch(other)).status, 403);
    const tampered = new URL(thumb.url);
    tampered.searchParams.set("X-Amz-Signature", "0".repeat(64));
    assert.equal((await fetch(tampered)).status, 403);
    // Short TTL: an issued URL stops working at expiry (it cannot be recalled earlier).
    await sleep(3200);
    assert.equal((await fetch(thumb.url)).status, 403);

    // Revoked evidence: no new URL, and the raw role has no path at all.
    await revokeSharingPermission(db.owner, {
      permissionRef,
      revokedBy: "operator",
      reason: "done",
    });
    await expectCode(
      issueRead(deps, {
        viewerUserId: actors.customer,
        clipId: clip.clipId,
        role: "thumbnail_jpeg",
      }),
      "not_found",
    );
    await expectCode(
      issueRead(deps, {
        viewerUserId: actors.staff,
        clipId: clip.clipId,
        role: "clip_mp4" as never,
      }),
      "invalid_request",
    );
  });
});
