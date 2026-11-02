import assert from "node:assert/strict";
import test from "node:test";
import { acceptProcessingResult } from "../src/catalog/catalog.js";
import { fixtureAcceptResult } from "../src/jobs/fixtures.js";
import {
  advanceResult,
  closeOutputs,
  repairResults,
  submitCandidate,
} from "../src/acceptance/service.js";
import {
  recordExecutionEvidence,
  requestJobCancel,
} from "../src/jobs/service.js";
import { TransportError, allocateJobOutput } from "../src/transport/index.js";
import {
  acceptanceDatabase,
  acceptanceDeps,
  candidateBody,
  manifestFor,
  runningJob,
  sha,
  uploadClip,
  uploadOutput,
  type AcceptanceDb,
  type RunningJob,
  type Uploaded,
} from "./acceptance-harness.js";

const code = async (p: Promise<unknown>) =>
  p.then(
    () => "ok",
    (e: unknown) =>
      e instanceof TransportError ? e.code : `unexpected:${String(e)}`,
  );

async function scenario(options: { deadlineSeconds?: number } = {}) {
  const db = await acceptanceDatabase();
  const deps = await acceptanceDeps(db);
  const job = await runningJob(db, options);
  return { db, ...deps, job };
}

/** Uploads one clip + manifest. Returns what a worker would hold before close. */
async function uploadResult(
  s: Awaited<ReturnType<typeof scenario>>,
  mutate: (doc: Record<string, any>) => void = () => {},
  clips: Uploaded[][] | undefined = undefined,
) {
  const set = clips ?? [await uploadClip(s.transport, s.job, 0)];
  const bytes = await manifestFor(s.db, s.job, set, mutate);
  const manifest = await uploadOutput(
    s.transport,
    s.job,
    "result-manifest.json",
    "result_manifest",
    bytes,
  );
  return {
    set,
    manifest,
    doc: JSON.parse(bytes.toString()) as Record<string, any>,
  };
}

async function evidence(db: AcceptanceDb, jobId: string) {
  const ref = (
    await db.owner.query("SELECT execution_call_id FROM jobs WHERE id = $1", [
      jobId,
    ])
  ).rows[0].execution_call_id as string;
  return recordExecutionEvidence(
    { pool: db.app },
    {
      jobId,
      recordedBy: "controller-test",
      evidence: { kind: "local_child_reaped", executionRef: ref },
    },
  );
}

const state = async (db: AcceptanceDb, jobId: string) =>
  (
    await db.owner.query(
      `SELECT j.state, j.error_code, r.status AS recording,
              (SELECT count(*)::int FROM clips c WHERE c.job_id = j.id) AS clips,
              (SELECT job_id FROM dispatch_admission WHERE slot = 1) AS holder
       FROM jobs j JOIN recordings r ON r.id = j.recording_id WHERE j.id = $1`,
      [jobId],
    )
  ).rows[0] as {
    state: string;
    error_code: string | null;
    recording: string;
    clips: number;
    holder: string | null;
  };

test("result first, evidence later: one atomic acceptance and only then is the slot freed", async () => {
  const s = await scenario();
  try {
    const { manifest, doc } = await uploadResult(s);
    const closure = await closeOutputs(s.accept, {
      jobId: s.job.jobId,
      invocationNonce: s.job.nonce,
      outcome: "succeeded",
    });
    assert.equal(closure.fileCount, 7);
    assert.equal(closure.clipCount, 1);
    await submitCandidate(s.accept, candidateBody(s.job, manifest, doc));
    const ack = await advanceResult(s.accept, s.job.jobId);
    assert.equal(ack?.candidateStatus, "verified");
    // Callback + verified bytes alone select nothing and free nothing.
    let st = await state(s.db, s.job.jobId);
    assert.equal(st.state, "result_pending");
    assert.equal(st.clips, 0);
    assert.equal(st.holder, s.job.jobId);
    // Physical terminal evidence arrives last: the same step now accepts.
    await evidence(s.db, s.job.jobId);
    await advanceResult(s.accept, s.job.jobId);
    st = await state(s.db, s.job.jobId);
    assert.deepEqual(
      {
        state: st.state,
        clips: st.clips,
        recording: st.recording,
        holder: st.holder,
      },
      { state: "succeeded", clips: 1, recording: "reviewable", holder: null },
    );
    const files = await s.db.owner.query(
      "SELECT count(*)::int AS n FROM files WHERE job_id = $1 AND state = 'verified'",
      [s.job.jobId],
    );
    assert.equal(files.rows[0].n, 7);
    // A replay changes nothing.
    await advanceResult(s.accept, s.job.jobId);
    assert.equal((await state(s.db, s.job.jobId)).clips, 1);
  } finally {
    await s.db.close();
  }
});

test("evidence first, result later reaches the same selected result", async () => {
  const s = await scenario();
  try {
    const { manifest, doc } = await uploadResult(s);
    await closeOutputs(s.accept, {
      jobId: s.job.jobId,
      invocationNonce: s.job.nonce,
      outcome: "succeeded",
    });
    await evidence(s.db, s.job.jobId);
    // Evidence alone neither fails (finite grace) nor frees the slot.
    assert.equal(await advanceResult(s.accept, s.job.jobId), null);
    let st = await state(s.db, s.job.jobId);
    assert.deepEqual([st.state, st.holder], ["running", s.job.jobId]);
    // The exact current claim may still report its already closed inventory.
    await submitCandidate(s.accept, candidateBody(s.job, manifest, doc));
    await advanceResult(s.accept, s.job.jobId);
    st = await state(s.db, s.job.jobId);
    assert.deepEqual(
      { state: st.state, clips: st.clips, holder: st.holder },
      { state: "succeeded", clips: 1, holder: null },
    );
  } finally {
    await s.db.close();
  }
});

test("no output write after close or after terminal evidence; duplicate and different candidates", async () => {
  const s = await scenario();
  try {
    const { manifest, doc } = await uploadResult(s);
    const close = () =>
      closeOutputs(s.accept, {
        jobId: s.job.jobId,
        invocationNonce: s.job.nonce,
        outcome: "succeeded",
      });
    const first = await close();
    assert.deepEqual(await close(), first); // idempotent
    assert.equal(
      await code(
        allocateJobOutput(s.transport, s.job.authority, {
          slot: "clips/001/rgb.mp4",
          role: "clip_mp4",
          sizeBytes: "5",
          sha256: sha("late"),
        }),
      ),
      "forbidden",
    );
    // Direct database writes are refused too (defence in depth).
    await assert.rejects(
      s.db.owner.query(`UPDATE files SET state = 'failed' WHERE id = $1`, [
        manifest.fileId,
      ]),
    );
    const body = candidateBody(s.job, manifest, doc);
    await submitCandidate(s.accept, body);
    await submitCandidate(s.accept, body); // identical replay is idempotent
    assert.equal(
      await code(
        submitCandidate(s.accept, {
          ...body,
          summary: { ...body.summary, clipCount: 0 },
        }),
      ),
      "conflict",
    );
  } finally {
    await s.db.close();
  }
});

test("wrong nonce, malformed inventory and unexpected files cannot close or report", async () => {
  const s = await scenario();
  try {
    const { manifest, doc } = await uploadResult(s);
    assert.equal(
      await code(
        closeOutputs(s.accept, {
          jobId: s.job.jobId,
          invocationNonce: "A".repeat(43),
          outcome: "succeeded",
        }),
      ),
      "forbidden",
    );
    await closeOutputs(s.accept, {
      jobId: s.job.jobId,
      invocationNonce: s.job.nonce,
      outcome: "succeeded",
    });
    assert.equal(
      await code(
        submitCandidate(s.accept, {
          ...candidateBody(s.job, manifest, doc),
          invocationNonce: "B".repeat(43),
        }),
      ),
      "forbidden",
    );
  } finally {
    await s.db.close();
  }
  const t = await scenario();
  try {
    await uploadResult(t, () => {}, [
      await uploadClip(t.transport, t.job, 0, ["viewer_rrd"]),
    ]);
    assert.equal(
      await code(
        closeOutputs(t.accept, {
          jobId: t.job.jobId,
          invocationNonce: t.job.nonce,
          outcome: "succeeded",
        }),
      ),
      "conflict",
      "a clip without all six roles cannot be closed as a success",
    );
  } finally {
    await t.db.close();
  }
  const u = await scenario();
  try {
    await uploadResult(u);
    await uploadOutput(
      u.transport,
      u.job,
      "extra/unexpected.bin",
      "viewer_rrd",
      Buffer.from("x"),
    );
    assert.equal(
      await code(
        closeOutputs(u.accept, {
          jobId: u.job.jobId,
          invocationNonce: u.job.nonce,
          outcome: "succeeded",
        }),
      ),
      "conflict",
    );
  } finally {
    await u.db.close();
  }
});

test("corrupt bytes, manifest/inventory and source mismatches are rejected; nothing partial is accepted", async () => {
  const cases: Array<{
    name: string;
    reason: string;
    prepare: (
      s: Awaited<ReturnType<typeof scenario>>,
    ) => ReturnType<typeof uploadResult>;
  }> = [
    {
      name: "bytes differ from the declared SHA-256",
      reason: "output_hash_mismatch",
      prepare: async (s) => {
        const bad = await uploadOutput(
          s.transport,
          s.job,
          "clips/000/rgb.mp4",
          "clip_mp4",
          Buffer.from("stored bytes"),
          { declaredSha: sha("declared other bytes") },
        );
        const rest = await uploadClip(s.transport, s.job, 0, ["clip_mp4"]);
        return uploadResult(s, () => {}, [[bad, ...rest]]);
      },
    },
    {
      name: "source hash attested at EOF differs from the catalog",
      reason: "source_identity_mismatch",
      prepare: (s) =>
        uploadResult(s, (d) => {
          d.verified_sources[0].sha256 = "9".repeat(64);
        }),
    },
    {
      name: "source not read to EOF",
      reason: "source_not_eof_verified",
      prepare: (s) =>
        uploadResult(s, (d) => {
          d.attestation.source_eof_verified = false;
          d.verified_sources = [];
        }),
    },
    {
      name: "manifest names a different claim",
      reason: "manifest_nonce_mismatch",
      prepare: (s) =>
        uploadResult(s, (d) => {
          d.attestation.invocation_nonce = "Z".repeat(43);
        }),
    },
    {
      name: "manifest hash of an output differs from the closed inventory",
      reason: "inventory_mismatch",
      prepare: (s) =>
        uploadResult(s, (d) => {
          d.outputs[0].sha256 = "9".repeat(64);
        }),
    },
    {
      name: "simulation marker appears on a hardware job",
      reason: "manifest_simulation_mismatch",
      prepare: (s) =>
        uploadResult(s, (d) => {
          d.attestation.rgb_profile = "h264_mcap_v1";
          d.simulation = {
            schema: "stateaction.simulation_provenance.v1",
            qualification: "simulation_only",
            mapped_timeline_semantics: "simulation_transport_only",
            production_qualified: false,
            provenance: {
              camera: { status: "unknown" },
              encoder: { status: "unknown" },
              clock: { status: "unknown" },
            },
          };
        }),
    },
  ];
  for (const c of cases) {
    const s = await scenario();
    try {
      const { manifest, doc } = await c.prepare(s);
      await closeOutputs(s.accept, {
        jobId: s.job.jobId,
        invocationNonce: s.job.nonce,
        outcome: "succeeded",
      });
      await submitCandidate(s.accept, candidateBody(s.job, manifest, doc));
      const ack = await advanceResult(s.accept, s.job.jobId);
      assert.equal(ack?.candidateStatus, "rejected", c.name);
      assert.equal(ack?.reasonCode, c.reason, c.name);
      const st = await state(s.db, s.job.jobId);
      assert.deepEqual(
        { state: st.state, clips: st.clips, recording: st.recording },
        { state: "failed", clips: 0, recording: "processing" },
        c.name,
      );
    } finally {
      await s.db.close();
    }
  }
});

test("cancellation, revoked collection permission and expired deadline stop acceptance", async () => {
  // Cancel before the candidate: the claim is no longer current.
  const a = await scenario();
  try {
    const { manifest, doc } = await uploadResult(a);
    await closeOutputs(a.accept, {
      jobId: a.job.jobId,
      invocationNonce: a.job.nonce,
      outcome: "succeeded",
    });
    await requestJobCancel({ pool: a.db.app }, a.job.jobId);
    assert.equal(
      await code(
        submitCandidate(a.accept, candidateBody(a.job, manifest, doc)),
      ),
      "forbidden",
    );
  } finally {
    await a.db.close();
  }
  // Permission revoked between a verified candidate and acceptance.
  const b = await scenario();
  try {
    const { manifest, doc } = await uploadResult(b);
    await closeOutputs(b.accept, {
      jobId: b.job.jobId,
      invocationNonce: b.job.nonce,
      outcome: "succeeded",
    });
    await submitCandidate(b.accept, candidateBody(b.job, manifest, doc));
    await advanceResult(b.accept, b.job.jobId);
    await b.db.owner.query(
      "UPDATE ingest_permissions SET status = 'revoked', revoked_by = 'operator', revoked_at = now() WHERE owner_user_id = $1",
      [b.db.actors.collector],
    );
    await evidence(b.db, b.job.jobId);
    await advanceResult(b.accept, b.job.jobId);
    const st = await state(b.db, b.job.jobId);
    assert.deepEqual(
      {
        state: st.state,
        code: st.error_code,
        clips: st.clips,
        holder: st.holder,
      },
      { state: "failed", code: "permission_revoked", clips: 0, holder: null },
    );
  } finally {
    await b.db.close();
  }
  // Fixed deadline: nothing is accepted after it, whatever the callback says.
  const c = await scenario({ deadlineSeconds: 2 });
  try {
    const { manifest, doc } = await uploadResult(c);
    await closeOutputs(c.accept, {
      jobId: c.job.jobId,
      invocationNonce: c.job.nonce,
      outcome: "succeeded",
    });
    await new Promise((r) => setTimeout(r, 2500));
    assert.equal(
      await code(
        submitCandidate(c.accept, candidateBody(c.job, manifest, doc)),
      ),
      "forbidden",
    );
  } finally {
    await c.db.close();
  }
});

test("concurrent advances select exactly once; the database refuses a shortcut to succeeded", async () => {
  const s = await scenario();
  try {
    const { manifest, doc } = await uploadResult(s);
    await closeOutputs(s.accept, {
      jobId: s.job.jobId,
      invocationNonce: s.job.nonce,
      outcome: "succeeded",
    });
    await submitCandidate(s.accept, candidateBody(s.job, manifest, doc));
    await advanceResult(s.accept, s.job.jobId);
    // No manual shortcut: succeeded without evidence is refused by the database itself.
    await assert.rejects(
      s.db.app.query(
        "UPDATE jobs SET state = 'succeeded', finished_at = now() WHERE id = $1",
        [s.job.jobId],
      ),
    );
    await evidence(s.db, s.job.jobId);
    await Promise.all(
      Array.from({ length: 6 }, () => advanceResult(s.accept, s.job.jobId)),
    );
    await repairResults(s.accept);
    const st = await state(s.db, s.job.jobId);
    assert.deepEqual([st.state, st.clips], ["succeeded", 1]);
  } finally {
    await s.db.close();
  }
});

test("a failed worker report keeps its diagnostics and accepts no clip", async () => {
  const s = await scenario();
  try {
    const bytes = await manifestFor(s.db, s.job, [], (d) => {
      d.verified_sources = [];
      d.attestation.source_eof_verified = false;
      d.outputs = [];
      d.clips = [];
      d.checks = [
        {
          code: "worker_failed",
          status: "fail",
          message: "boom",
          rule_revision: "sa31-export-2",
          measurements: {},
        },
      ];
    });
    const manifest = await uploadOutput(
      s.transport,
      s.job,
      "result-manifest.json",
      "result_manifest",
      bytes,
    );
    await closeOutputs(s.accept, {
      jobId: s.job.jobId,
      invocationNonce: s.job.nonce,
      outcome: "failed",
    });
    await submitCandidate(s.accept, {
      schemaVersion: 1,
      jobId: s.job.jobId,
      invocationNonce: s.job.nonce,
      manifestFileId: manifest.fileId,
      manifestSha256: manifest.sha,
      summary: {
        outcome: "failed",
        clipCount: 0,
        checks: { pass: 0, warn: 0, fail: 1, measured: 0, notEvaluated: 0 },
        errorCode: "worker_failed",
      },
    } as never);
    await advanceResult(s.accept, s.job.jobId);
    await evidence(s.db, s.job.jobId);
    await advanceResult(s.accept, s.job.jobId);
    const st = await state(s.db, s.job.jobId);
    assert.deepEqual(
      {
        state: st.state,
        code: st.error_code,
        clips: st.clips,
        holder: st.holder,
      },
      { state: "failed", code: "worker_failed", clips: 0, holder: null },
    );
    const kept = await s.db.owner.query(
      "SELECT result_manifest_sha256 FROM jobs WHERE id = $1",
      [s.job.jobId],
    );
    assert.equal(kept.rows[0].result_manifest_sha256, manifest.sha);
  } finally {
    await s.db.close();
  }
});

test("a storage outage before the manifest EOF is transient until the finite wall, then a deterministic failure", async () => {
  const s = await scenario();
  try {
    const { manifest, doc } = await uploadResult(s);
    await closeOutputs(s.accept, {
      jobId: s.job.jobId,
      invocationNonce: s.job.nonce,
      outcome: "succeeded",
    });
    await submitCandidate(s.accept, candidateBody(s.job, manifest, doc));
    const down = {
      ...s.accept,
      reader: {
        read: async () => {
          throw new Error("storage down");
        },
      },
      config: { ...s.accept.config, verifyWallSeconds: 2 },
    };
    const early = await advanceResult(down, s.job.jobId);
    assert.equal(early?.candidateStatus, "provisional");
    assert.equal((await state(s.db, s.job.jobId)).state, "result_pending");
    await new Promise((r) => setTimeout(r, 2300));
    const late = await advanceResult(down, s.job.jobId);
    assert.equal(late?.candidateStatus, "rejected");
    assert.equal(late?.reasonCode, "verification_timeout");
    const st = await state(s.db, s.job.jobId);
    assert.deepEqual([st.state, st.clips], ["failed", 0]);
  } finally {
    await s.db.close();
  }
});

test("a manifest outage that outlasts the wall is rejected in the SAME invocation (wall re-checked after the failure)", async () => {
  const s = await scenario();
  try {
    const { manifest, doc } = await uploadResult(s);
    await closeOutputs(s.accept, {
      jobId: s.job.jobId,
      invocationNonce: s.job.nonce,
      outcome: "succeeded",
    });
    await submitCandidate(s.accept, candidateBody(s.job, manifest, doc));
    const slow = {
      ...s.accept,
      reader: {
        read: async () => {
          await new Promise((r) => setTimeout(r, 2300));
          throw new Error("storage down");
        },
      },
      config: { ...s.accept.config, verifyWallSeconds: 2 },
    };
    const out = await advanceResult(slow, s.job.jobId);
    assert.equal(out?.candidateStatus, "rejected");
    assert.equal(out?.reasonCode, "verification_timeout");
    assert.equal((await state(s.db, s.job.jobId)).state, "failed");
  } finally {
    await s.db.close();
  }
});

test("per-object hashing is capped by the remaining verification wall and progress is durable and exact", async () => {
  const s = await scenario();
  try {
    const { manifest, doc } = await uploadResult(s);
    await closeOutputs(s.accept, {
      jobId: s.job.jobId,
      invocationNonce: s.job.nonce,
      outcome: "succeeded",
    });
    await submitCandidate(s.accept, candidateBody(s.job, manifest, doc));
    const timeouts: number[] = [];
    const watched = {
      ...s.accept,
      hasher: {
        hash: (key: string, bytes: number, timeoutMs: number) => {
          timeouts.push(timeoutMs);
          return s.accept.hasher.hash(key, bytes, timeoutMs);
        },
      },
      config: { ...s.accept.config, verifyWallSeconds: 30 },
    };
    const ack = await advanceResult(watched, s.job.jobId);
    assert.equal(ack?.candidateStatus, "verified");
    assert.equal(timeouts.length, 6); // the manifest is hashed from its bounded read
    assert.ok(timeouts.every((t) => t <= 30_000));
    const rows = await s.db.owner.query(
      `SELECT count(*)::int AS n FROM job_output_verifications v JOIN files f ON f.id = v.file_id
       WHERE v.job_id = $1 AND v.sha256 = f.sha256 AND v.size_bytes = f.size_bytes`,
      [s.job.jobId],
    );
    assert.equal(rows.rows[0].n, 7);
  } finally {
    await s.db.close();
  }
});

test("the legacy helper and the application role cannot fabricate acceptance facts", async () => {
  const s = await scenario();
  try {
    const { manifest, doc, set } = await uploadResult(s);
    const clips = set.flat().length; // 6 role files for the one clip
    assert.equal(clips, 6);
    const input = {
      jobId: s.job.jobId,
      manifestFileId: manifest.fileId,
      manifestSha256: manifest.sha,
      clips: [],
    };
    // The owner-only fixture refuses the restricted application credential.
    await assert.rejects(
      fixtureAcceptResult(s.db.app, s.db.app, input),
      /owner credential/,
    );
    await closeOutputs(s.accept, {
      jobId: s.job.jobId,
      invocationNonce: s.job.nonce,
      outcome: "succeeded",
    });
    await submitCandidate(s.accept, candidateBody(s.job, manifest, doc));
    // The catalog helper alone has no path around the unconditional guard: no
    // verified candidate and no terminal evidence yet means no success.
    await assert.rejects(
      acceptProcessingResult(s.db.app, { ...input, clips: [] }),
    );
    assert.equal((await state(s.db, s.job.jobId)).state, "result_pending");
  } finally {
    await s.db.close();
  }
});

test("a verified candidate's clip plan and checks are immutable on EVERY transition out of verified", async () => {
  const s = await scenario();
  try {
    const { manifest, doc } = await uploadResult(s);
    await closeOutputs(s.accept, {
      jobId: s.job.jobId,
      invocationNonce: s.job.nonce,
      outcome: "succeeded",
    });
    await submitCandidate(s.accept, candidateBody(s.job, manifest, doc));
    await advanceResult(s.accept, s.job.jobId); // verified; evidence still missing
    const snapshot = async () =>
      (
        await s.db.owner.query(
          `SELECT c.status, c.clip_plan, c.verified_checks, c.verified_at, c.reason_code, c.decided_at,
                  j.state, (SELECT count(*)::int FROM clips k WHERE k.job_id = j.id) AS clips
           FROM job_result_candidates c JOIN jobs j ON j.id = c.job_id WHERE c.job_id = $1`,
          [s.job.jobId],
        )
      ).rows[0];
    const before = await snapshot();
    assert.equal(before.status, "verified");
    assert.ok(Array.isArray(before.clip_plan) && before.clip_plan.length > 0);
    for (const [status, extra] of [
      ["accepted", ", decided_at = now()"],
      [
        "rejected",
        ", reason_code = 'output_hash_mismatch', decided_at = now()",
      ],
      ["verified", ""],
    ] as const)
      await assert.rejects(
        s.db.app.query(
          `UPDATE job_result_candidates SET status = '${status}', clip_plan = '[]'::jsonb${extra} WHERE job_id = $1`,
          [s.job.jobId],
        ),
        /clip plan is write-once|SAC01/,
        `verified -> ${status} must not alter the plan`,
      );
    assert.deepEqual(await snapshot(), before);
    await assert.rejects(
      s.db.app.query(
        "UPDATE job_result_candidates SET status = 'accepted', verified_checks = '[]'::jsonb, decided_at = now() WHERE job_id = $1",
        [s.job.jobId],
      ),
      /write-once|SAC01/,
    );
    assert.deepEqual(await snapshot(), before);
    // The legitimate path is unaffected: evidence then acceptance with the unchanged plan.
    await evidence(s.db, s.job.jobId);
    await advanceResult(s.accept, s.job.jobId);
    const st = await state(s.db, s.job.jobId);
    assert.deepEqual([st.state, st.clips], ["succeeded", 1]);
  } finally {
    await s.db.close();
  }
});
