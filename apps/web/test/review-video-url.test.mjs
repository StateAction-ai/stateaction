import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchVideoUrl, VideoUrlError } from "../lib/review/video-url.ts";

const json = (status, body) => new Response(JSON.stringify(body), { status });

test("asks the broker for the recording_mp4 role and returns the URL", async () => {
  let seen;
  const grant = await fetchVideoUrl("/api/v1/recordings/r1/reads", {
    fetchImpl: async (path, init) => {
      seen = { path, init };
      return json(200, {
        data: {
          url: "https://storage.test/recording.mp4?sig=1",
          expiresAt: "2026-11-24T00:01:00.000Z",
        },
      });
    },
  });
  assert.deepEqual(grant, {
    url: "https://storage.test/recording.mp4?sig=1",
    expiresAt: Date.UTC(2026, 10, 24, 0, 1),
  });
  assert.equal(seen.init.method, "POST");
  assert.deepEqual(JSON.parse(seen.init.body), { role: "recording_mp4" });
  assert.equal(seen.init.redirect, "error");
});

test("a refused, malformed or unreachable broker is a VideoUrlError", async () => {
  for (const fetchImpl of [
    async () => json(403, {}),
    async () => json(200, { data: {} }),
    async () =>
      json(200, {
        data: { url: "https://storage.test/a", expiresAt: "expired" },
      }),
    async () => new Response("not json", { status: 200 }),
    async () => {
      throw new TypeError("network");
    },
  ])
    await assert.rejects(fetchVideoUrl("/x", { fetchImpl }), VideoUrlError);
});
