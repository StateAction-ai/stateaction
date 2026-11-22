import assert from "node:assert/strict";
import { test } from "node:test";
import {
  fetchVideoUrl,
  resumeAt,
  VideoUrlError,
} from "../lib/review/video-url.ts";

const json = (status, body) => new Response(JSON.stringify(body), { status });

test("asks the broker for the recording_mp4 role and returns the URL", async () => {
  let seen;
  const url = await fetchVideoUrl("/api/v1/recordings/r1/reads", {
    fetchImpl: async (path, init) => {
      seen = { path, init };
      return json(200, {
        data: { url: "https://storage.test/recording.mp4?sig=1" },
      });
    },
  });
  assert.equal(url, "https://storage.test/recording.mp4?sig=1");
  assert.equal(seen.init.method, "POST");
  assert.deepEqual(JSON.parse(seen.init.body), { role: "recording_mp4" });
  assert.equal(seen.init.redirect, "error");
});

test("a refused, malformed or unreachable broker is a VideoUrlError", async () => {
  for (const fetchImpl of [
    async () => json(403, {}),
    async () => json(200, { data: {} }),
    async () => new Response("not json", { status: 200 }),
    async () => {
      throw new TypeError("network");
    },
  ])
    await assert.rejects(fetchVideoUrl("/x", { fetchImpl }), VideoUrlError);
});

test("resume time prefers the element, else the last playhead, clamped", () => {
  assert.equal(resumeAt(12.5, 3, 96), 12.5);
  assert.equal(resumeAt(0, 30, 96), 30);
  assert.equal(resumeAt(Number.NaN, 30, 96), 30);
  assert.equal(resumeAt(500, 30, 96), 96);
});
