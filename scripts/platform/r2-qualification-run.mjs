// SA-43 qualification run. All I/O is injected (`deps`) so the exact flow that
// runs against R2 is also exercised against an in-memory fake store in tests.
// Production wiring lives in qualify-r2-transfers.mjs.
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  BudgetLedger,
  CaseRecorder,
  DeadlineExceeded,
  PART_SIZE,
  PENDING_GATES,
  REPORT_SCHEMA,
  RunClock,
  assertNoSecrets,
  corsFacts,
  mainFixture,
  overallVerdict,
  ownedKeys,
  rangePlan,
  safeError,
  sha256Hex,
  staleBytes,
  syntheticBytes,
  uploadPlan,
  classifyUnsignedDenial,
} from "./r2-qualification-lib.mjs";

/** Error/preflight/unsigned bodies are read at most this far, then cancelled. */
export const ERROR_BODY_CAP = 16_384;
const normEtag = (e) => (e ?? "").replace(/^"(.*)"$/, "$1");
const sleepReal = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * deps: { provider, control, ProviderUploadGone, ListPartsCommand,
 *   DeleteObjectCommand, planFor, partRange, presignGet(key, ttlSeconds),
 *   fetch, partSize?, settleMs?, sleep?, now? }
 * Returns { verdict, exitCode, reportPath }.
 */
export async function runQualification(cfg, deps) {
  const partSize = deps.partSize ?? PART_SIZE;
  const fetchImpl = deps.fetch;
  const sleep = deps.sleep ?? sleepReal;
  const now = deps.now ?? (() => Date.now());
  const settleMs = deps.settleMs ?? 5000;
  const { provider, control, ProviderUploadGone } = deps;
  const plan = uploadPlan(cfg, partSize);

  // One run only: the evidence directory is created exclusively (run lock).
  mkdirSync(cfg.evidenceDir, { mode: 0o700 });
  const ledgerPath = join(cfg.evidenceDir, "ledger.json");
  const reportPath = join(cfg.evidenceDir, "report.json");
  const secrets = [
    cfg.credentials.accessKeyId,
    cfg.credentials.secretAccessKey,
  ];
  const keys = {
    ...ownedKeys(cfg.runPrefix),
    rrd: cfg.rrd ? `${cfg.runPrefix}rrd/${cfg.rrd.sha256}.rrd` : null,
  };

  const budget = new BudgetLedger(cfg.budgets);
  const clock = new RunClock(cfg.budgets.runDeadlineMs);
  const startedAt = new Date().toISOString();
  const owned = new Map(); // key -> {key, uploadId, state}
  const uncertain = []; // operations whose outcome we could not settle
  const persistLedger = () => {
    const tmp = `${ledgerPath}.tmp`;
    writeFileSync(
      tmp,
      JSON.stringify({
        runPrefix: cfg.runPrefix,
        owned: [...owned.values()],
        uncertain,
      }),
      { mode: 0o600 },
    );
    renameSync(tmp, ledgerPath);
  };
  const own = (key, patch) => {
    owned.set(key, {
      ...(owned.get(key) ?? { key, uploadId: null }),
      ...patch,
    });
    persistLedger();
  };
  persistLedger();

  // -- abortable, settled operations ---------------------------------------
  // SDK calls made through `control` inherit the active operation's signal.
  // Execution is strictly sequential, so one active slot is enough.
  const active = { signal: undefined };
  const rawSend = control.send.bind(control);
  control.send = (command, options = {}) =>
    rawSend(command, { ...options, abortSignal: active.signal });

  const TIMED_OUT = Symbol("timed-out");
  async function bounded(label, ms, fn, clockForOp = clock) {
    const timeoutMs = clockForOp.boundedTimeout(ms); // throws if the deadline passed
    budget.op();
    const ac = new AbortController();
    const previous = active.signal;
    active.signal = ac.signal;
    const task = Promise.resolve().then(() => fn(ac.signal));
    const settled = task.then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
    });
    try {
      const first = await Promise.race([settled, timeout]);
      if (first === TIMED_OUT) {
        ac.abort();
        // Do not move on while the call may still be running.
        const done = await Promise.race([
          settled.then(() => true),
          sleepReal(settleMs).then(() => false),
        ]);
        if (!done) {
          uncertain.push(label);
          persistLedger();
        }
        throw new DeadlineExceeded(
          `${label} timed out${done ? "" : " (unsettled)"}`,
        );
      }
      if ("error" in first) throw first.error;
      return first.value;
    } finally {
      clearTimeout(timer);
      active.signal = previous;
    }
  }
  const op = (label, fn) => bounded(label, cfg.budgets.operationTimeoutMs, fn);
  const transfer = (label, fn) => bounded(label, cfg.budgets.putTimeoutMs, fn);

  // -- metered, bounded response bodies -------------------------------------
  /** Reads at most `cap` bytes, meters ACTUAL bytes, then cancels the body. */
  async function drain(res, cap = ERROR_BODY_CAP) {
    const chunks = [];
    let n = 0;
    let truncated = false;
    if (res.body) {
      const reader = res.body.getReader();
      try {
        while (n < cap) {
          const { done, value } = await reader.read();
          if (done) break;
          budget.reserveDownload(value.length);
          chunks.push(value);
          n += value.length;
          if (n >= cap) truncated = true;
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
    }
    return {
      bytes: n,
      truncated,
      text: Buffer.concat(chunks).toString("utf8", 0, Math.min(n, cap)),
    };
  }

  async function put(url, bytes, { origin } = {}) {
    budget.reserveUpload(bytes.length); // every attempted body counts
    const t0 = Date.now();
    return transfer("put-part", async (signal) => {
      const res = await fetchImpl(url, {
        method: "PUT",
        body: bytes,
        headers: origin ? { origin } : {},
        redirect: "manual",
        signal,
      });
      await drain(res);
      return {
        status: res.status,
        etag: normEtag(res.headers.get("etag")),
        headers: res.headers,
        ms: Date.now() - t0,
      };
    });
  }

  /** Ranged probe: 206 + exact Content-Range + exactly one body byte. */
  async function probe(url, expectedSize, headers = {}) {
    return op("probe", async (signal) => {
      const res = await fetchImpl(url, {
        headers: { range: "bytes=0-0", ...headers },
        redirect: "manual",
        signal,
      });
      const body = await drain(res, 2);
      const contentRange = res.headers.get("content-range");
      const exact =
        res.status === 206 &&
        contentRange === `bytes 0-0/${expectedSize}` &&
        body.bytes === 1;
      return {
        status: res.status,
        contentRange,
        bodyBytes: body.bytes,
        exact,
        headers: res.headers,
      };
    });
  }

  async function unsigned(url) {
    return op("unsigned", async (signal) => {
      const res = await fetchImpl(url, { redirect: "manual", signal });
      const body = await drain(res);
      const verdict = classifyUnsignedDenial({
        status: res.status,
        contentType: res.headers.get("content-type"),
        text: body.text,
        truncated: body.truncated,
      });
      return {
        status: res.status,
        leaksKeys: verdict.leaksKeys,
        truncated: body.truncated,
        denied: verdict.denied,
        // curated facts only; never the raw body
        facts: {
          status: res.status,
          reason: verdict.reason,
          ...(verdict.code ? { code: verdict.code } : {}),
        },
      };
    });
  }

  /** Full-EOF hash with an exact expected length; cancels on overflow. */
  async function hashStream(iterable, expectBytes) {
    const h = createHash("sha256");
    let n = 0;
    let overflow = false;
    for await (const chunk of iterable) {
      budget.reserveDownload(chunk.length);
      n += chunk.length;
      if (n > expectBytes) {
        overflow = true;
        break; // leaving the loop destroys the stream
      }
      h.update(chunk);
    }
    return { bytes: n, sha256: h.digest("hex"), overflow };
  }
  const readAll = (key, expectBytes) =>
    transfer("read-eof", async () =>
      hashStream(await provider.readObject(key), expectBytes),
    );
  const readRange = (key, start, endInclusive) =>
    transfer("read-range", async () =>
      hashStream(
        await provider.readObject(key, { start, endInclusive }),
        Number(endInclusive - start + 1n),
      ),
    );

  // -- state and helpers -------------------------------------------------------
  const cases = [];
  let cleanup = { status: "not-run", items: [] };
  const lazy = {};
  const fixture = () =>
    (lazy.fx ??= mainFixture(cfg.runPrefix, cfg.fixture.tailBytes, partSize));
  const small = () =>
    (lazy.small ??= syntheticBytes(
      `${cfg.runPrefix}lost`,
      cfg.fixture.smallBytes,
    ));
  const abortPayload = () =>
    (lazy.abort ??= syntheticBytes(
      `${cfg.runPrefix}abort`,
      cfg.fixture.abortBytes,
    ));
  const st = {};

  const finish = (verdictOverride) => {
    const verdict = verdictOverride ?? overallVerdict(cases, cleanup);
    const report = {
      schema: REPORT_SCHEMA,
      verdict,
      startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - clock.startedAt,
      endpointOrigin: cfg.provider.endpoint,
      runPrefix: cfg.runPrefix,
      usage: budget.snapshot(),
      uploadPlan: plan,
      cases: cases.map((c) => c.toJSON()),
      cleanup,
      uncertainOperations: [...uncertain],
      pendingGates: PENDING_GATES.map(([id, reason]) => ({
        id,
        status: "not-run",
        reason,
      })),
      scope: {
        evidence: "scoped R2 dev bucket HTTP/SDK behaviour only",
        notQualified: "physical phone, real-browser Rerun, Modal, hosted CI",
      },
    };
    assertNoSecrets(report, secrets);
    writeFileSync(reportPath, JSON.stringify(report, null, 2), {
      mode: 0o600,
      flag: "wx",
    });
    return verdict;
  };

  const watchdog = setTimeout(
    () => {
      try {
        cleanup = { status: "uncertain", items: [{ note: "watchdog fired" }] };
        finish("fail");
      } catch {
        /* best effort */
      }
      process.exit(4);
    },
    cfg.budgets.runDeadlineMs + cfg.budgets.cleanupDeadlineMs + 30_000,
  );
  watchdog.unref();

  async function runCase(
    id,
    { requires = [], required = true, enabled = true, reason },
    fn,
  ) {
    const rec = new CaseRecorder(id, { required });
    cases.push(rec);
    if (!enabled) return (rec.skip(reason), rec);
    const blocked = requires.find(
      (r) => cases.find((c) => c.id === r)?.status !== "pass",
    );
    if (blocked) return (rec.skip(`dependency-not-passed:${blocked}`), rec);
    if (uncertain.length > 0)
      return (rec.skip("uncertain-operation-pending"), rec);
    if (clock.expired()) return (rec.skip("run-deadline"), rec);
    rec.begin();
    try {
      await fn(rec);
    } catch (error) {
      rec.fail(error);
    }
    rec.end();
    return rec;
  }

  /** Authority to mutate a key: absent object AND no in-flight upload. */
  async function requireUnused(rec, key) {
    rec.require(
      `key unused: HEAD 404 (${key.split("/").slice(-2).join("/")})`,
      (await op("head", () => provider.headObject(key))) === null,
    );
    rec.require(
      "key unused: no in-flight upload at the exact key",
      (await op("list", () => provider.listUploadsForKey(key))).length === 0,
    );
  }

  /** Create exactly once. A failed/timed-out create is ambiguous: never retried or aborted. */
  async function createOwned(rec, key) {
    await requireUnused(rec, key);
    let created;
    try {
      created = await op("create", () => provider.createUpload(key));
    } catch (error) {
      own(key, { state: "ambiguous-create" });
      throw error;
    }
    own(key, { uploadId: created.uploadId, state: "open" });
    return created.uploadId;
  }

  const sliceOf = (parts, start, endInclusive) => {
    const out = [];
    let offset = 0n;
    for (const p of parts) {
      const pStart = offset;
      const pEnd = offset + BigInt(p.length);
      offset = pEnd;
      const from = start > pStart ? start : pStart;
      const to = endInclusive + 1n < pEnd ? endInclusive + 1n : pEnd;
      if (from < to)
        out.push(p.subarray(Number(from - pStart), Number(to - pStart)));
    }
    return Buffer.concat(out);
  };

  const presignPart = (key, uploadId, partNumber, length) =>
    op("presign-part", () =>
      provider.presignUploadPart({
        key,
        uploadId,
        partNumber,
        lengthBytes: BigInt(length),
        expiresInSeconds: cfg.presign.partUrlTtlSeconds,
      }),
    );
  const signGet = (key) =>
    op("presign-get", () => deps.presignGet(key, cfg.presign.getTtlSeconds));
  const isHttpClientError = (s) => s >= 400 && s < 500;

  async function completeOwned(key, uploadId, listed) {
    own(key, { state: "completing" });
    await op("complete", () =>
      provider.completeUpload(
        key,
        uploadId,
        listed.map((p) => ({ partNumber: p.partNumber, etag: p.etag })),
      ),
    );
    own(key, { state: "completed" });
  }

  // -- 0. every owned key is unused BEFORE any mutating effect ----------------
  await runCase("preflight.keys-unused", {}, async (rec) => {
    for (const key of [keys.main, keys.lost, keys.abort, keys.rrd].filter(
      Boolean,
    ))
      await requireUnused(rec, key);
    rec.require(
      "planned uploads fit the byte budget",
      plan.totalBytes <= cfg.budgets.maxUploadBytes,
    );
  });
  const PRE = ["preflight.keys-unused"];

  // -- 1. create + out-of-order upload ------------------------------------
  await runCase(
    "mpu.create-out-of-order-upload",
    { requires: PRE },
    async (rec) => {
      const fx = fixture();
      rec.require(
        "production planFor yields exactly two parts of the expected part size",
        deps.planFor(BigInt(fx.sizeBytes)).partCount === 2 &&
          deps.planFor(BigInt(fx.sizeBytes)).partSizeBytes === BigInt(partSize),
      );
      const uploadId = await createOwned(rec, keys.main);
      st.mainUploadId = uploadId;
      st.urls = [
        await presignPart(keys.main, uploadId, 1, fx.parts[0].length),
        await presignPart(keys.main, uploadId, 2, fx.parts[1].length),
      ];
      const order = [];
      st.putEtags = {};
      for (const n of [2, 1]) {
        const r = await put(st.urls[n - 1], fx.parts[n - 1], {
          origin: cfg.cors.allowedOrigin,
        });
        order.push(n);
        rec.require(
          `part ${n} PUT accepted (2xx)`,
          r.status >= 200 && r.status < 300,
          r.status,
        );
        rec.require(`part ${n} returned an ETag receipt`, r.etag.length > 0);
        st.putEtags[n] = r.etag;
        if (n === 2) st.putCors = corsFacts(r.headers);
        rec.observe(`part${n}PutMs`, r.ms);
      }
      rec.observe("uploadOrder", order);
      rec.observe(
        "partSizes",
        fx.parts.map((p) => p.length),
      );
      rec.check(
        "parts were uploaded out of order (2 then 1)",
        order.join() === "2,1",
      );
      rec.check(
        "part 1 is exactly the planned part size",
        fx.parts[0].length === partSize,
      );
    },
  );

  // -- 2. ListParts pagination (MaxParts=1) --------------------------------
  await runCase(
    "mpu.list-parts-maxparts-1",
    { requires: ["mpu.create-out-of-order-upload"] },
    async (rec) => {
      const fx = fixture();
      const pages = [];
      const parts = [];
      let marker = "0";
      for (let i = 0; i < 20; i++) {
        const out = await op("list-parts-page", () =>
          control.send(
            new deps.ListPartsCommand({
              Bucket: cfg.provider.bucket,
              Key: keys.main,
              UploadId: st.mainUploadId,
              PartNumberMarker: marker,
              MaxParts: 1,
            }),
          ),
        );
        pages.push({
          returned: (out.Parts ?? []).length,
          isTruncated: out.IsTruncated === true,
          nextMarker: out.NextPartNumberMarker ?? null,
        });
        for (const p of out.Parts ?? [])
          parts.push({ partNumber: p.PartNumber, etag: p.ETag, size: p.Size });
        if (!out.IsTruncated || out.NextPartNumberMarker === undefined) break;
        marker = String(out.NextPartNumberMarker);
      }
      rec.observe("pages", pages);
      rec.check(
        "two pages were needed (real pagination, MaxParts=1)",
        pages.length === 2,
      );
      rec.check(
        "first page was truncated with one part",
        pages[0]?.isTruncated === true && pages[0]?.returned === 1,
      );
      rec.check(
        "parts arrive ordered 1,2 though uploaded 2,1",
        parts.map((p) => p.partNumber).join() === "1,2",
      );
      rec.check(
        "ListParts sizes equal the plan",
        parts[0]?.size === fx.parts[0].length &&
          parts[1]?.size === fx.parts[1].length,
      );
      rec.check(
        "ListParts ETags equal the PUT receipts",
        [1, 2].every((n) => normEtag(parts[n - 1]?.etag) === st.putEtags[n]),
      );
      const viaProvider = await op("provider-list-parts", () =>
        provider.listParts(keys.main, st.mainUploadId, 1, 2),
      );
      rec.require(
        "production provider.listParts agrees with the MaxParts=1 walk",
        viaProvider.length === 2 &&
          viaProvider.every(
            (p, i) =>
              p.partNumber === i + 1 &&
              p.etag === st.putEtags[i + 1] &&
              p.sizeBytes === BigInt(fx.parts[i].length),
          ),
      );
      st.listed = viaProvider;
    },
  );

  // -- 3. complete + HEAD + full EOF SHA + ranges --------------------------
  await runCase(
    "mpu.complete-head-eof-ranges",
    { requires: ["mpu.list-parts-maxparts-1"] },
    async (rec) => {
      const fx = fixture();
      await completeOwned(keys.main, st.mainUploadId, st.listed);
      const head = await op("head", () => provider.headObject(keys.main));
      rec.require(
        "HEAD size equals declared size",
        head?.sizeBytes === BigInt(fx.sizeBytes),
        head && String(head.sizeBytes),
      );
      rec.observe("headEtag", head?.etag ?? null);
      rec.observe("headPartsCount", head?.partsCount ?? null);
      rec.check(
        "provider reports 2 parts when it reports a count",
        head?.partsCount === null || head?.partsCount === 2,
      );
      st.mainHead = head;
      rec.check(
        "completed upload is no longer listed in flight",
        (await op("list", () => provider.listUploadsForKey(keys.main)))
          .length === 0,
      );
      rec.observe(
        "listPartsAfterComplete",
        await op("list-parts-after", () =>
          provider.listParts(keys.main, st.mainUploadId, 1, 2),
        ).then(
          (p) => `listed:${p.length}`,
          (e) =>
            e instanceof ProviderUploadGone
              ? "gone"
              : `error:${safeError(e).name}`,
        ),
      );
      const eof = await readAll(keys.main, fx.sizeBytes);
      rec.check(
        "full-EOF byte count equals size, no overflow",
        eof.bytes === fx.sizeBytes && !eof.overflow,
        eof.bytes,
      );
      rec.check(
        "full-EOF SHA-256 equals the uploaded fixture (HEAD/ETag alone prove nothing)",
        eof.sha256 === fx.sha256,
      );
      for (const r of rangePlan(fx.sizeBytes, partSize)) {
        const got = await readRange(keys.main, r.start, r.endInclusive);
        const want = sliceOf(fx.parts, r.start, r.endInclusive);
        rec.check(
          `range ${r.name} bytes and SHA match`,
          !got.overflow &&
            got.bytes === want.length &&
            got.sha256 === sha256Hex(want),
        );
      }
      const past = await op("range-past-eof", () =>
        provider.readObject(keys.main, {
          start: BigInt(fx.sizeBytes),
          endInclusive: BigInt(fx.sizeBytes) + 7n,
        }),
      ).then(
        () => "served",
        (e) => safeError(e),
      );
      rec.observe("rangePastEof", past);
      rec.check(
        "range past EOF is refused (416)",
        past !== "served" && past.httpStatus === 416,
      );
    },
  );

  // -- 4. stale part URL after complete ------------------------------------
  await runCase(
    "stale.part-url-after-complete",
    { requires: ["mpu.complete-head-eof-ranges"] },
    async (rec) => {
      const fx = fixture();
      const r = await put(
        st.urls[1],
        staleBytes(`${cfg.runPrefix}main/2`, fx.parts[1].length),
      );
      rec.observe("stalePutStatus", r.status);
      rec.check(
        "stale part URL PUT is refused with an HTTP 4xx error",
        isHttpClientError(r.status),
        r.status,
      );
      const head = await op("head", () => provider.headObject(keys.main));
      rec.check(
        "HEAD identity unchanged (size and ETag)",
        head?.sizeBytes === st.mainHead.sizeBytes &&
          head?.etag === st.mainHead.etag,
      );
      const eof = await readAll(keys.main, fx.sizeBytes);
      rec.check(
        "full-EOF SHA-256 unchanged after stale PUT",
        eof.sha256 === fx.sha256 && eof.bytes === fx.sizeBytes && !eof.overflow,
      );
    },
  );

  // -- 5. controlled local ack suppression after an observed completion -------
  await runCase(
    "mpu.lost-client-reply-reconcile",
    { requires: PRE },
    async (rec) => {
      const payload = small();
      const uploadId = await createOwned(rec, keys.lost);
      st.lostUploadId = uploadId;
      st.lostUrl = await presignPart(keys.lost, uploadId, 1, payload.length);
      const r = await put(st.lostUrl, payload);
      rec.require(
        "part PUT accepted",
        r.status >= 200 && r.status < 300,
        r.status,
      );
      const listed = await op("list-parts", () =>
        provider.listParts(keys.lost, uploadId, 1, 1),
      );
      rec.require(
        "ListParts shows the part with exact length",
        listed.length === 1 && listed[0].sizeBytes === BigInt(payload.length),
      );
      let completeCalls = 0;
      let observed = false;
      own(keys.lost, { state: "completing" });
      try {
        await op("complete-with-local-ack-suppression", async () => {
          completeCalls += 1;
          await provider.completeUpload(
            keys.lost,
            uploadId,
            listed.map((p) => ({ partNumber: p.partNumber, etag: p.etag })),
          );
          observed = true; // the provider response was positively observed
          throw new LostLocalAck();
        });
      } catch (error) {
        if (!(error instanceof LostLocalAck)) throw error;
      }
      rec.require(
        "provider completion response observed, then local acknowledgement suppressed (controlled injection, not real ack loss)",
        observed,
      );
      own(keys.lost, { state: "completed" });
      const head = await op("head", () => provider.headObject(keys.lost));
      rec.require(
        "HEAD proves the object exists with the declared size",
        head?.sizeBytes === BigInt(payload.length),
      );
      rec.observe("headEtag", head?.etag ?? null);
      rec.observe("headPartsCount", head?.partsCount ?? null);
      rec.check(
        "no upload remains in flight at the exact key",
        (await op("list", () => provider.listUploadsForKey(keys.lost)))
          .length === 0,
      );
      const eof = await readAll(keys.lost, payload.length);
      rec.check(
        "full-EOF SHA-256 equals the uploaded bytes",
        eof.sha256 === sha256Hex(payload) &&
          eof.bytes === payload.length &&
          !eof.overflow,
      );
      const head2 = await op("head", () => provider.headObject(keys.lost));
      rec.check(
        "second HEAD returns the identical identity",
        head2?.etag === head?.etag && head2?.sizeBytes === head?.sizeBytes,
      );
      rec.check(
        "complete was sent exactly once (no second complete)",
        completeCalls === 1,
      );
      st.lostHead = head;
    },
  );

  await runCase(
    "stale.part-url-after-complete-small",
    { requires: ["mpu.lost-client-reply-reconcile"] },
    async (rec) => {
      const payload = small();
      const r = await put(
        st.lostUrl,
        staleBytes(`${cfg.runPrefix}lost`, payload.length),
      );
      rec.observe("stalePutStatus", r.status);
      rec.check(
        "stale part URL PUT is refused with an HTTP 4xx error",
        isHttpClientError(r.status),
        r.status,
      );
      const head = await op("head", () => provider.headObject(keys.lost));
      rec.check(
        "HEAD identity unchanged (size and ETag)",
        head?.sizeBytes === st.lostHead.sizeBytes &&
          head?.etag === st.lostHead.etag,
      );
      const eof = await readAll(keys.lost, payload.length);
      rec.check(
        "full-EOF SHA-256 unchanged after stale PUT",
        eof.sha256 === sha256Hex(payload) && !eof.overflow,
      );
    },
  );

  // -- 6. abort + old part URL ---------------------------------------------
  await runCase("mpu.abort-stale-url", { requires: PRE }, async (rec) => {
    const payload = abortPayload();
    const uploadId = await createOwned(rec, keys.abort);
    const url = await presignPart(keys.abort, uploadId, 1, payload.length);
    const r = await put(url, payload);
    rec.require(
      "part PUT accepted before abort",
      r.status >= 200 && r.status < 300,
      r.status,
    );
    await op("abort", () => provider.abortUpload(keys.abort, uploadId));
    own(keys.abort, { state: "aborted" });
    await op("abort-again", () => provider.abortUpload(keys.abort, uploadId));
    rec.check("second abort is idempotent", true);
    rec.check(
      "aborted upload is no longer listed",
      (await op("list", () => provider.listUploadsForKey(keys.abort)))
        .length === 0,
    );
    const gone = await op("list-parts", () =>
      provider.listParts(keys.abort, uploadId, 1, 1),
    ).then(
      () => "still-listed",
      (e) =>
        e instanceof ProviderUploadGone ? "gone" : `error:${safeError(e).name}`,
    );
    rec.observe("listPartsAfterAbort", gone);
    rec.check("ListParts reports the upload gone", gone === "gone");
    const stale = await put(
      url,
      staleBytes(`${cfg.runPrefix}abort`, payload.length),
    );
    rec.observe("stalePutStatus", stale.status);
    rec.check(
      "old part URL PUT is refused after abort with an HTTP 4xx error",
      isHttpClientError(stale.status),
      stale.status,
    );
    rec.check(
      "no object materialized at the key (HEAD 404)",
      (await op("head", () => provider.headObject(keys.abort))) === null,
    );
    rec.check(
      "no upload re-created at the key",
      (await op("list", () => provider.listUploadsForKey(keys.abort)))
        .length === 0,
    );
  });

  // -- 7. unsigned access denied -------------------------------------------
  const base = `${cfg.provider.endpoint}/${cfg.provider.bucket}`;
  await runCase(
    "access.unsigned-denied",
    { requires: ["mpu.complete-head-eof-ranges"] },
    async (rec) => {
      const get = await unsigned(`${base}/${keys.main}`);
      rec.observe("unsignedGetStatus", get.status);
      rec.observe("unsignedGetDenial", get.facts);
      rec.check(
        "unsigned exact-key GET denied (401/403/404 or R2 missing-auth 400)",
        get.denied,
        get.status,
      );
      const list = await unsigned(
        `${base}?list-type=2&prefix=${encodeURIComponent(cfg.runPrefix)}&max-keys=1`,
      );
      rec.observe("unsignedListStatus", list.status);
      rec.observe("unsignedListDenial", list.facts);
      rec.check(
        "unsigned object listing denied and enumerates no keys",
        list.denied && !list.leaksKeys,
        list.status,
      );
      const uploads = await unsigned(
        `${base}?uploads&prefix=${encodeURIComponent(cfg.runPrefix)}`,
      );
      rec.observe("unsignedUploadsStatus", uploads.status);
      rec.observe("unsignedUploadsDenial", uploads.facts);
      rec.check(
        "unsigned multipart-upload listing denied",
        uploads.denied && !uploads.leaksKeys,
        uploads.status,
      );
    },
  );

  // -- 8. short presigned GET expiry + renewal -----------------------------
  await runCase(
    "presign.short-get-expiry-renewal",
    { requires: ["mpu.lost-client-reply-reconcile"] },
    async (rec) => {
      const ttl = cfg.presign.getTtlSeconds;
      const size = small().length;
      const signedAt = now();
      const url = await signGet(keys.lost);
      rec.check(
        "signed URL carries the requested expiry",
        new URL(url).searchParams.get("X-Amz-Expires") === String(ttl),
      );
      const first = await probe(url, size);
      rec.observe("freshProbe", {
        status: first.status,
        contentRange: first.contentRange,
        bodyBytes: first.bodyBytes,
      });
      rec.require(
        "fresh URL serves exactly bytes 0-0 as 206 with the exact Content-Range",
        first.exact,
        first.status,
      );
      const maxPolls =
        Math.ceil(
          ((ttl + cfg.presign.expiryGraceSeconds) * 1000) /
            cfg.presign.pollIntervalMs,
        ) + 1;
      let polls = 1;
      let deniedAtMs = null;
      for (let i = 0; i < maxPolls && !clock.expired(); i++) {
        await sleep(cfg.presign.pollIntervalMs);
        const res = await probe(url, size);
        polls += 1;
        if (res.status === 401 || res.status === 403) {
          deniedAtMs = now() - signedAt;
          break;
        }
        rec.require(
          "only a served range or an auth denial is expected while polling",
          res.exact,
          res.status,
        );
      }
      rec.observe("probeCount", polls);
      rec.observe("firstDeniedAtMs", deniedAtMs);
      rec.observe("ttlSeconds", ttl);
      rec.check(
        "expiry was observed within ttl + grace (bounded polling)",
        deniedAtMs !== null &&
          deniedAtMs <= (ttl + cfg.presign.expiryGraceSeconds) * 1000,
        deniedAtMs,
      );
      rec.check(
        "URL was not denied before ttl (2s skew allowance)",
        deniedAtMs !== null && deniedAtMs >= (ttl - 2) * 1000,
        deniedAtMs,
      );
      const renewed = await probe(await signGet(keys.lost), size);
      rec.check(
        "renewed URL serves the exact range again",
        renewed.exact,
        renewed.status,
      );
    },
  );

  // -- 9. exact-origin CORS (HTTP evidence only) ----------------------------
  await runCase(
    "cors.exact-origin-etag-preflight",
    {
      requires: [
        "mpu.create-out-of-order-upload",
        "mpu.lost-client-reply-reconcile",
      ],
    },
    async (rec) => {
      const preflight = (url, origin, method, reqHeaders) =>
        op("preflight", async (signal) => {
          const headers = { origin, "access-control-request-method": method };
          if (reqHeaders)
            headers["access-control-request-headers"] = reqHeaders;
          const res = await fetchImpl(url, {
            method: "OPTIONS",
            headers,
            redirect: "manual",
            signal,
          });
          await drain(res);
          return { status: res.status, ...corsFacts(res.headers) };
        });
      const has = (list, v) => list.includes("*") || list.includes(v);
      const getUrl = await signGet(keys.lost);
      const putUrl = await presignPart(keys.lost, st.lostUploadId, 1, 1);
      const g = await preflight(getUrl, cfg.cors.allowedOrigin, "GET", "range");
      rec.observe("getPreflight", g);
      rec.check(
        "GET preflight echoes the exact allowed origin",
        g.allowOrigin === cfg.cors.allowedOrigin,
      );
      rec.check(
        "GET preflight allows GET and the Range header",
        has(g.allowMethods, "get") && has(g.allowHeaders, "range"),
      );
      const p = await preflight(putUrl, cfg.cors.allowedOrigin, "PUT");
      rec.observe("putPreflight", p);
      rec.check(
        "PUT preflight echoes the exact allowed origin",
        p.allowOrigin === cfg.cors.allowedOrigin,
      );
      rec.check("PUT preflight allows PUT", has(p.allowMethods, "put"));
      const d = await preflight(getUrl, cfg.cors.deniedOrigin, "GET", "range");
      rec.observe("deniedOriginPreflight", d);
      rec.check(
        "a different origin is not allowed (no echo, no wildcard)",
        d.allowOrigin !== cfg.cors.deniedOrigin && d.allowOrigin !== "*",
      );
      rec.check(
        "allowed origin is never a wildcard",
        g.allowOrigin !== "*" && p.allowOrigin !== "*",
      );
      rec.observe("partPutResponseCors", st.putCors);
      rec.check(
        "part PUT response (sent with Origin) exposes ETag to that origin",
        st.putCors?.allowOrigin === cfg.cors.allowedOrigin &&
          has(st.putCors?.exposeHeaders ?? [], "etag"),
      );
      const get = await probe(await signGet(keys.lost), small().length, {
        origin: cfg.cors.allowedOrigin,
      });
      const gf = corsFacts(get.headers);
      rec.observe("getResponseCors", gf);
      rec.check(
        "ranged GET response allows the exact origin",
        get.exact && gf.allowOrigin === cfg.cors.allowedOrigin,
      );
      rec.observe(
        "note",
        "HTTP-only header evidence; not a real-browser qualification",
      );
    },
  );

  // -- 10. optional genuine RRD source ---------------------------------------
  await runCase(
    "rrd.immutable-key-private-get",
    {
      required: false,
      requires: PRE,
      enabled: cfg.rrd !== null,
      reason: "no genuine RRD source supplied by root",
    },
    async (rec) => {
      // One descriptor for hash AND upload; identity checked before and after.
      const fd = openSync(
        cfg.rrd.path,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        const before = fstatSync(fd);
        rec.require(
          "rrd source is a regular file of the supplied size",
          before.isFile() && before.size === cfg.rrd.sizeBytes,
          before.size,
        );
        const hash = createHash("sha256");
        const buf = Buffer.alloc(8 * 1024 * 1024);
        for (let off = 0; off < before.size; ) {
          const n = readSync(
            fd,
            buf,
            0,
            Math.min(buf.length, before.size - off),
            off,
          );
          if (n === 0) break;
          hash.update(buf.subarray(0, n));
          off += n;
        }
        rec.require(
          "supplied SHA-256 matches the file (checked before any upload)",
          hash.digest("hex") === cfg.rrd.sha256,
        );
        rec.require(
          "immutable key embeds the content hash",
          keys.rrd.endsWith(`${cfg.rrd.sha256}.rrd`),
        );
        const filePlan = deps.planFor(BigInt(before.size));
        const uploadId = await createOwned(rec, keys.rrd);
        for (let n = 1; n <= filePlan.partCount; n++) {
          const r = deps.partRange(filePlan, n);
          const bytes = Buffer.alloc(Number(r.lengthBytes));
          readSync(fd, bytes, 0, bytes.length, Number(r.offsetBytes));
          const res = await put(
            await presignPart(keys.rrd, uploadId, n, bytes.length),
            bytes,
          );
          rec.require(
            `rrd part ${n} PUT accepted`,
            res.status >= 200 && res.status < 300,
            res.status,
          );
        }
        const after = fstatSync(fd);
        rec.require(
          "rrd source unchanged during the run (same inode, size, mtime)",
          after.ino === before.ino &&
            after.dev === before.dev &&
            after.size === before.size &&
            after.mtimeMs === before.mtimeMs,
        );
        const listed = await op("list-parts", () =>
          provider.listParts(keys.rrd, uploadId, 1, filePlan.partCount),
        );
        rec.require(
          "ListParts has every planned part",
          listed.length === filePlan.partCount,
        );
        await completeOwned(keys.rrd, uploadId, listed);
        const head = await op("head", () => provider.headObject(keys.rrd));
        rec.check(
          "HEAD size equals the file",
          head?.sizeBytes === BigInt(before.size),
        );
        const eof = await readAll(keys.rrd, before.size);
        rec.check(
          "full-EOF SHA-256 equals the supplied hash",
          eof.sha256 === cfg.rrd.sha256 && !eof.overflow,
        );
        const un = await unsigned(`${base}/${keys.rrd}`);
        rec.observe("unsignedRrdDenial", un.facts);
        rec.check(
          "unsigned GET of the RRD key denied (401/403/404 or R2 missing-auth 400)",
          un.denied,
          un.status,
        );
        const get = await probe(await signGet(keys.rrd), before.size, {
          origin: cfg.cors.allowedOrigin,
        });
        rec.check(
          "presigned ranged GET works with the exact origin",
          get.exact &&
            corsFacts(get.headers).allowOrigin === cfg.cors.allowedOrigin,
        );
        rec.observe("note", "HTTP-only; no real-browser Rerun load");
      } finally {
        closeSync(fd);
      }
    },
  );

  // -- cleanup: only keys + upload IDs this run positively owns -------------
  const cleanupClock = new RunClock(cfg.budgets.cleanupDeadlineMs);
  const cop = (label, fn) =>
    bounded(label, cfg.budgets.operationTimeoutMs, fn, cleanupClock);
  const items = [];
  const mustRetain = uncertain.length > 0;
  for (const entry of owned.values()) {
    const item = {
      key: entry.key,
      uploadId: entry.uploadId,
      was: entry.state,
      action: "none",
      ok: true,
    };
    try {
      if (mustRetain || entry.state === "completing") {
        // Outcome of a mutating call is unknown: never race or guess. Retained
        // for the seven-day lifecycle; cleanup cannot be claimed.
        item.action = "retained (uncertain outcome)";
        item.ok = false;
        item.uncertain = true;
      } else if (entry.state === "ambiguous-create") {
        item.action =
          "left-for-lifecycle (ambiguous create is not deletion authority)";
        item.ok = false;
        item.uncertain = true;
      } else if (entry.state === "open" && entry.uploadId) {
        await cop("abort", () =>
          provider.abortUpload(entry.key, entry.uploadId),
        );
        item.action = "aborted-known-upload";
        item.ok =
          (await cop("list", () => provider.listUploadsForKey(entry.key)))
            .length === 0;
      } else if (
        entry.state === "completed" &&
        cfg.cleanup === "delete-owned"
      ) {
        await cop("delete", () =>
          control.send(
            new deps.DeleteObjectCommand({
              Bucket: cfg.provider.bucket,
              Key: entry.key,
            }),
          ),
        );
        item.action = "deleted-exact-key";
        item.ok =
          (await cop("head", () => provider.headObject(entry.key))) === null;
      } else if (entry.state === "completed") {
        item.action = "kept-by-config";
      } else if (entry.state === "aborted") {
        item.action = "verified-aborted";
        item.ok =
          (await cop("list", () => provider.listUploadsForKey(entry.key)))
            .length === 0;
      }
    } catch (error) {
      item.ok = false;
      item.error = safeError(error);
    }
    items.push(item);
  }
  const anyUncertain = items.some((i) => i.uncertain) || uncertain.length > 0;
  cleanup = {
    status: anyUncertain
      ? "uncertain"
      : items.every((i) => i.ok)
        ? "pass"
        : "fail",
    items,
  };
  persistLedger();
  clearTimeout(watchdog);

  const verdict = finish();
  return {
    verdict,
    exitCode: verdict === "pass" ? 0 : verdict === "incomplete" ? 2 : 1,
    reportPath,
    summary: {
      verdict,
      cases: cases.map((c) => ({ id: c.id, status: c.status })),
      cleanup: cleanup.status,
      usage: budget.snapshot(),
      report: reportPath,
    },
  };
}

class LostLocalAck extends Error {
  constructor() {
    super("injected: local acknowledgement suppressed");
    this.name = "LostLocalAck";
  }
}
