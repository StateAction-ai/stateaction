import assert from "node:assert/strict";
import test from "node:test";
import { startRecordingServer } from "../test-integration/http-adapter.js";
import type { RecordingRoutesDeps } from "../src/admission/http.js";

// Oversized bodies are refused before any database or storage work, over a
// real loopback socket: the 413 must reach a client that is still uploading.
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
  config: { processingProfileRevision: "t1", supportedRgbProfiles: [] },
  authenticateCollector: async () => ({
    ok: true,
    principal: { userId: "ba_collector" },
    requestId: "11111111-1111-4111-8111-111111111111",
    headers: new Headers(),
  }),
} as unknown as RecordingRoutesDeps;

const headers = {
  authorization: "Bearer collector-token",
  "content-type": "application/json",
};

test("413 survives handler cancellation of declared and chunked oversize uploads", async () => {
  const server = await startRecordingServer(deps);
  try {
    for (let round = 0; round < 40; round++) {
      const declared = await fetch(`${server.url}/api/v1/recordings`, {
        method: "POST",
        headers,
        body: JSON.stringify({ pad: "x".repeat(1048576) }),
      });
      assert.equal(declared.status, 413, `declared round ${round}`);
      const chunks = new ReadableStream<Uint8Array>({
        start(controller) {
          for (let i = 0; i < 40; i++)
            controller.enqueue(new Uint8Array(64 * 1024).fill(32));
          controller.close();
        },
      });
      const streamed = await fetch(`${server.url}/api/v1/recordings`, {
        method: "POST",
        headers,
        body: chunks,
        duplex: "half",
      } as RequestInit);
      assert.equal(streamed.status, 413, `chunked round ${round}`);
      const body = (await streamed.json()) as { error?: { code?: string } };
      assert.equal(body.error?.code, "payload_too_large");
    }
  } finally {
    await server.close();
  }
});
