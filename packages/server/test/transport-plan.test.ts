import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_CONTROL_BODY_BYTES,
  MAX_FILE_BYTES,
  MAX_PARTS,
  normalizeEtag,
  partRange,
  planFor,
  PART_SIZE_BYTES,
  readBoundedJson,
  TransportError,
} from "../src/transport/index.js";

test("part plan is fixed 64 MiB, uniform except the final part", () => {
  assert.equal(PART_SIZE_BYTES, 67_108_864n);
  for (const [size, count] of [
    [1n, 1],
    [PART_SIZE_BYTES, 1],
    [PART_SIZE_BYTES + 1n, 2],
    [PART_SIZE_BYTES * 3n, 3],
    [MAX_FILE_BYTES, 1600],
  ] as const)
    assert.equal(planFor(size).partCount, count, String(size));
  const plan = planFor(PART_SIZE_BYTES * 2n + 5n);
  assert.deepEqual(
    [1, 2, 3].map((n) => partRange(plan, n)),
    [
      { partNumber: 1, offsetBytes: 0n, lengthBytes: PART_SIZE_BYTES },
      {
        partNumber: 2,
        offsetBytes: PART_SIZE_BYTES,
        lengthBytes: PART_SIZE_BYTES,
      },
      { partNumber: 3, offsetBytes: PART_SIZE_BYTES * 2n, lengthBytes: 5n },
    ],
  );
  const total = [1, 2, 3].reduce(
    (n, p) => n + partRange(plan, p).lengthBytes,
    0n,
  );
  assert.equal(total, plan.sizeBytes);
  assert.ok(planFor(MAX_FILE_BYTES).partCount <= MAX_PARTS);
});

test("plan rejects sizes and part numbers outside the cap", () => {
  assert.throws(() => planFor(0n), RangeError);
  assert.throws(() => planFor(-1n), RangeError);
  assert.throws(() => planFor(MAX_FILE_BYTES + 1n), RangeError);
  const plan = planFor(10n);
  for (const n of [0, 2, -1, 1.5, Number.NaN])
    assert.throws(() => partRange(plan, n), RangeError, String(n));
});

test("ETags are normalized receipts, not interpreted", () => {
  assert.equal(normalizeEtag('"abc-1"'), "abc-1");
  assert.equal(normalizeEtag("abc-1"), "abc-1");
});

const post = (body: BodyInit, headers: Record<string, string> = {}) =>
  new Request("http://localhost/x", {
    method: "POST",
    body,
    headers: { "content-type": "application/json", ...headers },
  });
const code = async (promise: Promise<unknown>) =>
  promise.then(
    () => "ok",
    (error: unknown) => (error as TransportError).code,
  );

test("control bodies are bounded JSON only; media never buffers", async () => {
  const good = JSON.stringify({
    expectedTransportEpoch: 1,
    partNumbers: [1, 2],
  });
  assert.deepEqual(await readBoundedJson(post(good), "http.parts-sign.v1"), {
    expectedTransportEpoch: 1,
    partNumbers: [1, 2],
  });
  assert.equal(
    await code(
      readBoundedJson(
        post(good, { "content-type": "video/mp4" }),
        "http.parts-sign.v1",
      ),
    ),
    "unsupported_media_type",
  );
  assert.equal(
    await code(
      readBoundedJson(
        post(good, { "content-type": "text/plain" }),
        "http.parts-sign.v1",
      ),
    ),
    "unsupported_media_type",
  );
  // Declared length over the bound is rejected before reading anything.
  assert.equal(
    await code(
      readBoundedJson(
        post(good, { "content-length": "99999999" }),
        "http.parts-sign.v1",
      ),
    ),
    "payload_too_large",
  );
  // An undeclared (chunked) stream is cut off at the bound, not buffered whole.
  let pulled = 0;
  const chunk = new Uint8Array(4096).fill(0x20);
  const endless = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled += chunk.byteLength;
      controller.enqueue(chunk);
      if (pulled > 256 * 1024 * 1024) controller.close();
    },
  });
  const streamed = new Request("http://localhost/x", {
    method: "POST",
    body: endless,
    headers: { "content-type": "application/json" },
    duplex: "half",
  } as RequestInit);
  assert.equal(
    await code(readBoundedJson(streamed, "http.parts-sign.v1")),
    "payload_too_large",
  );
  assert.ok(pulled < MAX_CONTROL_BODY_BYTES + 1024 * 1024, `pulled ${pulled}`);
  // Contract violations (extra field, wrong types, duplicates) are rejected.
  for (const bad of [
    { expectedTransportEpoch: 1, partNumbers: [1], url: "x" },
    { expectedTransportEpoch: 1, partNumbers: [1, 1] },
    { expectedTransportEpoch: 0, partNumbers: [1] },
    {
      expectedTransportEpoch: 1,
      partNumbers: Array.from({ length: 33 }, (_, i) => i + 1),
    },
    { expectedTransportEpoch: 1, partNumbers: [] },
    { expectedTransportEpoch: 1, partNumbers: [10001] },
  ])
    assert.equal(
      await code(
        readBoundedJson(post(JSON.stringify(bad)), "http.parts-sign.v1"),
      ),
      "invalid_request",
      JSON.stringify(bad).slice(0, 60),
    );
});
