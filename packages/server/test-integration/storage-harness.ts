import { randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import type { ServerConfig } from "../src/config.js";
import { presignObject, storageClient } from "../src/storage.js";

const env = (key: string) => {
  const value = process.env[key];
  if (!value)
    throw new Error(`${key} is set by scripts/catalog-integration.sh`);
  return value;
};

/** Storage config for the throwaway SeaweedFS started by the integration script. */
export function storageConfig(
  bucket: string,
  endpoint = env("STORAGE_TEST_ENDPOINT"),
): ServerConfig {
  return {
    appEnv: "local",
    databaseUrl: "postgresql://unused.invalid/unused",
    endpoint,
    publicEndpoint: endpoint,
    region: "us-east-1",
    bucket,
    accessKeyId: env("STORAGE_TEST_ACCESS_KEY_ID"),
    secretAccessKey: env("STORAGE_TEST_SECRET_ACCESS_KEY"),
  };
}

export type TestBucket = {
  config: ServerConfig;
  put(key: string, body: Uint8Array): Promise<void>;
  remove(): Promise<void>;
};

export async function freshBucket(): Promise<TestBucket> {
  const config = storageConfig(`it-${randomBytes(6).toString("hex")}`);
  const client = storageClient(config, 15000);
  await client.send(new CreateBucketCommand({ Bucket: config.bucket }));
  return {
    config,
    async put(key, body) {
      await client.send(
        new PutObjectCommand({ Bucket: config.bucket, Key: key, Body: body }),
      );
    },
    async remove() {
      const listed = await client.send(
        new ListObjectsV2Command({ Bucket: config.bucket }),
      );
      for (const o of listed.Contents ?? [])
        await client.send(
          new DeleteObjectCommand({ Bucket: config.bucket, Key: o.Key! }),
        );
      await client.send(new DeleteBucketCommand({ Bucket: config.bucket }));
      client.destroy();
    },
  };
}

export type FaultMode =
  | "pass"
  /** Drop Range, Content-Length and Content-Range: full chunked body of unknown length. */
  | "unknown-length"
  | "status-503"
  /** Send response headers, then never send the body. */
  | "stall-body"
  /** Send half of the body, then reset the connection. */
  | "reset-mid-body";

/**
 * Real S3 behind a fault-injecting HTTP proxy. Requests are forwarded with
 * their original Host header so the SigV4 signature still verifies upstream.
 * Records bytes actually forwarded to the client and whether the client
 * cancelled before the upstream body ended.
 */
export async function faultProxy(upstream: string) {
  const target = new URL(upstream);
  const state = {
    mode: "pass" as FaultMode,
    /** Remaining requests to fault before passing through again. */
    times: Infinity,
    requests: 0,
    forwardedBytes: 0,
    clientCancelled: false,
    upstreamEnded: false,
  };
  const server = http.createServer((req, res) => {
    state.requests++;
    const mode = state.times > 0 ? state.mode : "pass";
    if (state.times > 0) state.times--;
    state.forwardedBytes = 0;
    state.clientCancelled = false;
    state.upstreamEnded = false;
    if (mode === "status-503") {
      req.resume();
      res.writeHead(503, { "content-type": "application/xml" });
      res.end(
        "<Error><Code>SlowDown</Code><Message>injected</Message></Error>",
      );
      return;
    }
    const onUpstream = (up: http.IncomingMessage) => {
      const outHeaders = { ...up.headers };
      let status = up.statusCode ?? 502;
      if (mode === "unknown-length") {
        delete outHeaders["content-length"];
        delete outHeaders["content-range"];
        if (status === 206) status = 200;
      }
      res.writeHead(status, outHeaders);
      if (mode === "stall-body") {
        up.pause();
        return;
      }
      let half = Number(up.headers["content-length"] ?? 0) / 2;
      up.on("data", (chunk: Buffer) => {
        if (mode === "reset-mid-body") {
          if (half <= 0) return;
          const part = chunk.subarray(0, Math.max(1, Math.floor(half)));
          half -= part.byteLength;
          state.forwardedBytes += part.byteLength;
          res.write(part);
          if (half <= 0) {
            up.destroy();
            res.socket?.destroy();
          }
          return;
        }
        state.forwardedBytes += chunk.byteLength;
        // Honour client backpressure so a cancelled read stops the transfer.
        if (!res.write(chunk)) {
          up.pause();
          res.once("drain", () => up.resume());
        }
      });
      up.on("end", () => {
        state.upstreamEnded = true;
        res.end();
      });
      res.on("close", () => {
        if (!res.writableFinished) {
          state.clientCancelled = true;
          up.destroy();
        }
      });
    };
    if (mode === "unknown-length") {
      // A non-compliant store: ignore the (signed) Range and stream the whole
      // object. The proxy fetches it upstream with its own presigned GET.
      req.resume();
      const [, bucket, ...rest] = new URL(req.url!, "http://x").pathname.split(
        "/",
      );
      const key = rest.map(decodeURIComponent).join("/");
      presignObject(storageConfig(decodeURIComponent(bucket!), upstream), {
        method: "GET",
        key,
      }).then(
        (url) => http.get(url, onUpstream).on("error", () => res.destroy()),
        () => res.destroy(),
      );
      return;
    }
    const upstreamReq = http.request(
      {
        hostname: target.hostname,
        port: target.port,
        method: req.method,
        path: req.url,
        headers: req.headers,
      },
      onUpstream,
    );
    upstreamReq.on("error", () => res.destroy());
    req.pipe(upstreamReq);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    endpoint: `http://127.0.0.1:${port}`,
    state,
    set(mode: FaultMode, times = Infinity) {
      state.mode = mode;
      state.times = times;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
