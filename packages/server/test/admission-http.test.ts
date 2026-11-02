import assert from "node:assert/strict";
import test from "node:test";
import { MAX_BODY_BYTES, recordingRoutes } from "../src/admission/http.js";
import type { AdmissionDeps } from "../src/admission/recordings.js";

// The body is refused before any database or storage work: these stubs must
// never be reached.
const deps = {
  pool: new Proxy(
    {},
    {
      get() {
        throw new Error("database must not be used");
      },
    },
  ),
  reader: {
    read() {
      throw new Error("storage must not be used");
    },
  },
  config: {
    processingProfileRevision: "t1",
    supportedRgbProfiles: ["h264_mcap_v1"],
  },
} as unknown as AdmissionDeps;
const routes = recordingRoutes({
  ...deps,
  authenticateCollector: async () => ({
    ok: true,
    principal: { userId: "ba_collector" },
    requestId: "11111111-1111-4111-8111-111111111111",
    headers: new Headers({ "Set-Cookie": "better-auth.session_token=x" }),
  }),
});

/** An endless body that records how much was pulled and whether it was cancelled. */
function endlessBody(chunkBytes = 64 * 1024) {
  const state = { pulled: 0, cancelled: false, reason: undefined as unknown };
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        state.pulled += chunkBytes;
        controller.enqueue(new Uint8Array(chunkBytes).fill(0x20));
      },
      cancel(reason) {
        state.cancelled = true;
        state.reason = reason;
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, state };
}

const post = (body: BodyInit, headers: Record<string, string> = {}) =>
  new Request("http://127.0.0.1/api/v1/recordings", {
    method: "POST",
    body,
    headers: { "content-type": "application/json", ...headers },
    duplex: "half",
  } as RequestInit);

test("an unbounded streamed body is cancelled just past the limit (413, private)", async () => {
  const { stream, state } = endlessBody();
  const res = await routes.create(post(stream));
  assert.equal(res.status, 413);
  assert.equal(
    res.headers.get("cache-control"),
    "private, no-store, max-age=0",
  );
  assert.equal(res.headers.get("set-cookie"), "better-auth.session_token=x");
  const body = (await res.json()) as { error: { code: string } };
  assert.equal(body.error.code, "payload_too_large");
  assert.equal(state.cancelled, true, "source stream cancelled explicitly");
  // Pulled at most one chunk beyond the bound, never the remainder.
  assert.ok(state.pulled <= MAX_BODY_BYTES + 2 * 64 * 1024, `${state.pulled}`);
  const before = state.pulled;
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(state.pulled, before, "nothing is pulled after cancellation");
});

test("a declared oversized length is refused without reading the body", async () => {
  const { stream, state } = endlessBody();
  const res = await routes.create(
    post(stream, { "content-length": String(MAX_BODY_BYTES + 1) }),
  );
  assert.equal(res.status, 413);
  assert.ok(state.pulled <= 64 * 1024, `${state.pulled}`);
});

test("a body that fails mid-stream is cancelled and answers privately", async () => {
  let cancelled = false;
  let sent = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!sent) {
        sent = true;
        controller.enqueue(new TextEncoder().encode('{"clientRecordingId":'));
      } else controller.error(new Error("client reset"));
    },
    cancel() {
      cancelled = true;
    },
  });
  const res = await routes.create(post(stream));
  assert.ok(res.status >= 400);
  assert.equal(
    res.headers.get("cache-control"),
    "private, no-store, max-age=0",
  );
  assert.equal(cancelled, false, "an errored stream has nothing to cancel");
});

test("non-JSON and invalid bodies keep their 422 mapping", async () => {
  const wrongType = await routes.create(
    new Request("http://127.0.0.1/api/v1/recordings", {
      method: "POST",
      body: "{}",
      headers: { "content-type": "text/plain" },
    }),
  );
  assert.equal(wrongType.status, 422);
  const invalid = await routes.create(post("{}"));
  assert.equal(invalid.status, 422);
  assert.equal(
    ((await invalid.json()) as { error: { code: string } }).error.code,
    "invalid_request",
  );
});
