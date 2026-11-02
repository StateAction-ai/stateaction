import assert from "node:assert/strict";
import test from "node:test";
import { ClipSourceError, fetchBoundedRrd } from "../lib/rerun/bounded-rrd.ts";

const ORIGIN = "https://storage.example.test";
const URL_OK = `${ORIGIN}/clips/a.rrd?sig=1`;
const magic = new TextEncoder().encode("RRF2");
const reply =
  (body, init = {}) =>
  async () =>
    new Response(body, {
      headers: { "content-type": "application/octet-stream", ...init.headers },
      status: init.status ?? 200,
    });
const opts = (fetchImpl, extra = {}) => ({
  allowedOrigins: [ORIGIN],
  fetchImpl,
  ...extra,
});
const code = (promise) =>
  promise.then(
    () => "ok",
    (e) => (e instanceof ClipSourceError ? e.code : `other:${e}`),
  );

test("returns the bytes of a valid RRD and fetches without credentials or redirects", async () => {
  let seen;
  const blob = await fetchBoundedRrd(
    URL_OK,
    opts(async (url, init) => {
      seen = init;
      return new Response(new Uint8Array([...magic, 1, 2, 3]), {
        headers: { "content-type": "application/octet-stream" },
      });
    }),
  );
  assert.equal(blob.size, 7);
  assert.equal(seen.credentials, "omit");
  assert.equal(seen.redirect, "error");
  assert.equal(seen.cache, "no-store");
});

test("refuses origins outside the allowlist and non-secure remote URLs", async () => {
  const never = async () => assert.fail("must not fetch");
  for (const url of [
    "https://app.rerun.io/x.rrd",
    "http://storage.example.test/x.rrd",
    "not a url",
  ])
    assert.equal(
      await code(fetchBoundedRrd(url, opts(never))),
      "origin_not_allowed",
    );
  assert.equal(
    await code(
      fetchBoundedRrd("http://127.0.0.1:9/x.rrd", {
        allowedOrigins: ["http://127.0.0.1:9"],
        fetchImpl: reply(magic),
      }),
    ),
    "ok",
  );
});

test("maps expiry statuses to expired and other failures to unavailable", async () => {
  for (const status of [401, 403, 410])
    assert.equal(
      await code(fetchBoundedRrd(URL_OK, opts(reply("x", { status })))),
      "expired",
    );
  assert.equal(
    await code(fetchBoundedRrd(URL_OK, opts(reply("x", { status: 500 })))),
    "unavailable",
  );
  assert.equal(
    await code(
      fetchBoundedRrd(
        URL_OK,
        opts(async () => Promise.reject(new TypeError("down"))),
      ),
    ),
    "unavailable",
  );
});

test("rejects wrong MIME, non-RRD bytes and oversized bodies", async () => {
  assert.equal(
    await code(
      fetchBoundedRrd(
        URL_OK,
        opts(reply(magic, { headers: { "content-type": "text/html" } })),
      ),
    ),
    "bad_content_type",
  );
  assert.equal(
    await code(fetchBoundedRrd(URL_OK, opts(reply("<html>")))),
    "not_rrd",
  );
  assert.equal(
    await code(
      fetchBoundedRrd(
        URL_OK,
        opts(reply(magic, { headers: { "content-length": "999" } }), {
          maxBytes: 100,
        }),
      ),
    ),
    "too_large",
  );
  // No content-length: the stream is cut off at the cap, never buffered whole.
  let pulled = 0;
  const endless = async () =>
    new Response(
      new ReadableStream({
        pull(c) {
          pulled += 1;
          c.enqueue(new Uint8Array(1024));
        },
      }),
      { headers: { "content-type": "application/octet-stream" } },
    );
  assert.equal(
    await code(fetchBoundedRrd(URL_OK, opts(endless, { maxBytes: 4096 }))),
    "too_large",
  );
  assert.ok(pulled < 16, `pulled ${pulled} chunks`);
});

test("abort is reported as aborted", async () => {
  const ac = new AbortController();
  ac.abort();
  assert.equal(
    await code(
      fetchBoundedRrd(
        URL_OK,
        opts(async () => Promise.reject(new DOMException("x", "AbortError")), {
          signal: ac.signal,
        }),
      ),
    ),
    "aborted",
  );
});

test("accepts a magic split across network chunks", async () => {
  const chunked = async () =>
    new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(new Uint8Array([0x52]));
          c.enqueue(new Uint8Array([0x52, 0x46, 0x32, 1]));
          c.close();
        },
      }),
      { headers: { "content-type": "application/octet-stream" } },
    );
  assert.equal((await fetchBoundedRrd(URL_OK, opts(chunked))).size, 5);
});
