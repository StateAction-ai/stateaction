/** LOCAL SIMULATION. No Google, Better Auth, S3, R2, database or production credentials. */
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { mkdir, readFile, writeFile, rename, rm } from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

export const PART_BYTES = 64 * 1024 * 1024;
type Part = { partNumber: number; etag: string; sizeBytes: string };
type Upload = {
  id: string;
  owner: string;
  clientUploadId: string;
  sizeBytes: string;
  sha256: string;
  transportEpoch: number;
  state: string;
  parts: Record<string, Part>;
  receipts: Record<string, Part>;
};
type State = {
  uploads: Record<string, Upload>;
  counters: Record<string, number>;
};
class Fault extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}
const fail = (status: number, code: string): never => {
  throw new Fault(status, code);
};

export async function startFixture(options: {
  directory: string;
  host?: string;
  port?: number;
  urlTtlMs?: number;
  chunkDelayMs?: number;
  failPartOnce?: number;
  loseReceiptResponseOnce?: boolean;
  loseCompleteResponseOnce?: boolean;
}) {
  await mkdir(options.directory, { recursive: true });
  const stateFile = join(options.directory, "state.json");
  let state: State = { uploads: {}, counters: {} };
  try {
    state = JSON.parse(await readFile(stateFile, "utf8"));
  } catch (error: any) {
    if (error.code !== "ENOENT") throw error;
  }
  let saveChain = Promise.resolve();
  const persist = () => {
    const snapshot = JSON.stringify(state, null, 2);
    saveChain = saveChain.then(async () => {
      await writeFile(stateFile + ".tmp", snapshot);
      await rename(stateFile + ".tmp", stateFile);
    });
    return saveChain;
  };
  const count = (key: string) => {
    state.counters[key] = (state.counters[key] || 0) + 1;
  };
  const sessions = new Map<string, string>();
  const key = randomUUID();
  const signature = (value: string) =>
    createHmac("sha256", key).update(value).digest("hex");
  const reply = (res: ServerResponse, status: number, value: unknown) => {
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify(value));
  };
  const json = async (req: IncomingMessage) => {
    let bytes = 0;
    const chunks = [];
    for await (const chunk of req) {
      bytes += chunk.length;
      if (bytes > 65536) fail(413, "json_too_large");
      chunks.push(chunk);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString() || "{}");
    } catch {
      fail(400, "invalid_json");
    }
  };
  const identity = (req: IncomingMessage, res: ServerResponse) => {
    if (req.headers["x-stera-client"] !== "android-upload-spike")
      fail(403, "client_header_required");
    const token = /(?:^|;\s*)spike_session=([^;]+)/.exec(
      req.headers.cookie || "",
    )?.[1];
    const owner = token && sessions.get(token);
    if (!owner) fail(401, "login_required");
    // Deliberately rotate on EVERY control request, with two separate Set-Cookie headers.
    sessions.delete(token!);
    const rotated = randomUUID();
    sessions.set(rotated, owner);
    res.setHeader("Set-Cookie", [
      `spike_session=${rotated}; HttpOnly; SameSite=Lax; Path=/`,
      "spike_aux=kept; Path=/",
    ]);
    count("session_rotations");
    return owner;
  };
  const shape = (u: Upload) => ({
    fileId: u.id,
    ownerId: u.owner,
    sizeBytes: u.sizeBytes,
    sha256: u.sha256,
    transportEpoch: u.transportEpoch,
    state: u.state,
    partSizeBytes: String(PART_BYTES),
    partCount: Math.ceil(Number(u.sizeBytes) / PART_BYTES),
  });
  const partLength = (u: Upload, number: number) => {
    if (
      !Number.isInteger(number) ||
      number < 1 ||
      number > Math.ceil(Number(u.sizeBytes) / PART_BYTES)
    )
      fail(400, "bad_part");
    return Math.min(
      PART_BYTES,
      Number(u.sizeBytes) - (number - 1) * PART_BYTES,
    );
  };
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url!, `http://${req.headers.host}`);
      if (url.pathname === "/health")
        return reply(res, 200, {
          simulated: true,
          auth: "synthetic_only",
          provider: "local_files_not_s3",
          counters: state.counters,
        });
      if (url.pathname === "/spike/login" && req.method === "POST") {
        const body = await json(req);
        if (!["synthetic-a", "synthetic-b"].includes(body.ownerId))
          fail(400, "synthetic_account_required");
        const token = randomUUID();
        sessions.set(token, body.ownerId);
        res.setHeader("Set-Cookie", [
          `spike_session=${token}; HttpOnly; SameSite=Lax; Path=/`,
          "spike_aux=kept; Path=/",
        ]);
        return reply(res, 200, { ownerId: body.ownerId, simulated: true });
      }
      const provider = /^\/provider\/([^/]+)\/(\d+)$/.exec(url.pathname);
      if (provider && req.method === "PUT") {
        if (req.headers.cookie) fail(400, "control_cookie_leaked_to_provider");
        const u = state.uploads[provider[1]] || fail(404, "missing_upload");
        const number = Number(provider[2]);
        const epoch = Number(url.searchParams.get("epoch"));
        if (
          number === options.failPartOnce &&
          !state.counters.injected_part_failure
        ) {
          count("injected_part_failure");
          await persist();
          fail(503, "injected_retryable_failure");
        }
        const expires = Number(url.searchParams.get("expires"));
        const supplied = url.searchParams.get("signature") || "";
        const expected = signature(`${u.id}:${number}:${epoch}:${expires}`);
        if (
          supplied.length !== expected.length ||
          !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))
        )
          fail(403, "bad_signature");
        if (Date.now() >= expires) {
          count("expired_urls");
          await persist();
          fail(403, "expired_url");
        }
        if (epoch !== u.transportEpoch) fail(409, "stale_epoch");
        if (u.state !== "uploading") fail(409, "transport_closed");
        const expectedBytes = partLength(u, number);
        if (Number(req.headers["content-length"]) !== expectedBytes)
          fail(400, "wrong_length");
        const directory = join(options.directory, u.id, String(epoch));
        await mkdir(directory, { recursive: true });
        const filename = join(directory, `${number}.part`);
        const temporary = `${filename}.${randomUUID()}.tmp`;
        let actual = 0;
        const hash = createHash("md5");
        const meter = new Transform({
          transform(chunk, _encoding, callback) {
            actual += chunk.length;
            if (actual > expectedBytes) return callback(new Error("too_large"));
            hash.update(chunk);
            if (options.chunkDelayMs)
              setTimeout(() => callback(null, chunk), options.chunkDelayMs);
            else callback(null, chunk);
          },
        });
        try {
          await pipeline(req, meter, createWriteStream(temporary));
        } catch (error) {
          await rm(temporary, { force: true });
          throw error;
        }
        if (actual !== expectedBytes) {
          await rm(temporary, { force: true });
          fail(400, "wrong_actual_length");
        }
        if (epoch !== u.transportEpoch || u.state !== "uploading") {
          await rm(temporary, { force: true });
          fail(409, "transport_changed");
        }
        await rename(temporary, filename);
        const etag = `"${hash.digest("hex")}"`;
        u.parts[String(number)] = {
          partNumber: number,
          etag,
          sizeBytes: String(actual),
        };
        count("provider_puts");
        await persist();
        res.setHeader("ETag", etag);
        return reply(res, 200, { simulated: true });
      }
      const owner = identity(req, res);
      if (url.pathname === "/api/v1/me")
        return reply(res, 200, {
          userId: owner,
          roles: ["collector"],
          simulated: true,
        });
      if (url.pathname === "/spike/logout") {
        for (const [token, candidate] of sessions)
          if (candidate === owner) sessions.delete(token);
        res.setHeader("Set-Cookie", [
          "spike_session=; Max-Age=0; Path=/",
          "spike_aux=; Max-Age=0; Path=/",
        ]);
        return reply(res, 200, {});
      }
      if (url.pathname === "/api/v1/uploads" && req.method === "POST") {
        const body = await json(req);
        if (
          !/^[0-9a-f]{64}$/.test(body.sha256) ||
          !/^\d+$/.test(body.sizeBytes) ||
          !body.clientUploadId
        )
          fail(400, "bad_identity");
        const size = Number(body.sizeBytes);
        if (!Number.isSafeInteger(size) || size < 1 || size > 100 * 1024 ** 3)
          fail(400, "bad_size");
        let u = Object.values(state.uploads).find(
          (x) => x.owner === owner && x.clientUploadId === body.clientUploadId,
        );
        if (u && (u.sha256 !== body.sha256 || u.sizeBytes !== body.sizeBytes))
          fail(409, "content_conflict");
        if (!u) {
          const id = randomUUID();
          u = {
            id,
            owner,
            clientUploadId: body.clientUploadId,
            sha256: body.sha256,
            sizeBytes: body.sizeBytes,
            transportEpoch: 1,
            state: "uploading",
            parts: {},
            receipts: {},
          };
          state.uploads[id] = u;
          await persist();
        }
        return reply(res, 200, shape(u));
      }
      const route = /^\/api\/v1\/uploads\/([^/]+)(?:\/(.*))?$/.exec(
        url.pathname,
      );
      if (!route) fail(404, "not_found");
      const u = state.uploads[route![1]];
      if (!u || u.owner !== owner) fail(404, "not_found");
      const action = route![2];
      if (!action && req.method === "GET") return reply(res, 200, shape(u));
      const body = await json(req);
      if (body.expectedTransportEpoch !== u.transportEpoch)
        fail(409, "stale_epoch");
      if (action === "reconcile") {
        count("reconciliations");
        const parts = Object.values(u.parts).sort(
          (a, b) => a.partNumber - b.partNumber,
        );
        // Simulated listing uses one item/page to force the control fixture to gather all pages.
        const recovered: Part[] = [];
        let pages = 0;
        for (let offset = 0; offset < parts.length; offset++) {
          pages++;
          recovered.push(parts[offset]);
        }
        for (const part of recovered)
          u.receipts[String(part.partNumber)] = part;
        await persist();
        return reply(res, 200, {
          ...shape(u),
          parts: recovered,
          simulatedProviderListPages: pages,
        });
      }
      if (action === "complete") {
        if (u.state === "uploaded") {
          count("completion_replays");
          await persist();
          return reply(res, 200, {
            ...shape(u),
            contentVerifiedByFixture: true,
          });
        }
        if (u.state !== "uploading") fail(409, "transport_closed");
        if (
          Object.keys(u.parts).length !==
          Math.ceil(Number(u.sizeBytes) / PART_BYTES)
        )
          fail(409, "missing_parts");
        const directory = join(
          options.directory,
          u.id,
          String(u.transportEpoch),
        );
        const hash = createHash("sha256");
        let bytes = 0;
        for (let number = 1; number <= Object.keys(u.parts).length; number++) {
          const part = u.parts[String(number)];
          if (Number(part.sizeBytes) !== partLength(u, number))
            fail(409, "bad_part_length");
          for await (const chunk of createReadStream(
            join(directory, `${number}.part`),
          )) {
            hash.update(chunk);
            bytes += chunk.length;
          }
        }
        if (String(bytes) !== u.sizeBytes || hash.digest("hex") !== u.sha256)
          fail(409, "content_mismatch");
        u.state = "uploaded";
        count("api_completions");
        await persist();
        // Optional response loss AFTER durable completion, to exercise reconciliation, not blind restart.
        if (
          body.simulateLostResponse ||
          (options.loseCompleteResponseOnce &&
            !state.counters.injected_completion_response_loss)
        ) {
          count("injected_completion_response_loss");
          await persist();
          req.socket.destroy();
          return;
        }
        return reply(res, 200, { ...shape(u), contentVerifiedByFixture: true });
      }
      if (action === "restart") {
        if (u.state !== "retired") fail(409, "retirement_not_confirmed");
        u.transportEpoch++;
        u.state = "uploading";
        u.parts = {};
        u.receipts = {};
        await persist();
        return reply(res, 200, shape(u));
      }
      if (action === "cancel") {
        if (u.state === "uploaded") fail(409, "already_uploaded");
        u.state = "retired";
        await persist();
        return reply(res, 200, shape(u));
      }
      if (u.state !== "uploading") fail(409, "transport_closed");
      if (action === "parts/sign") {
        if (
          !Array.isArray(body.partNumbers) ||
          body.partNumbers.length > 32 ||
          !body.partNumbers.length
        )
          fail(400, "bad_sign_batch");
        const parts = body.partNumbers.map((number: number) => {
          const length = partLength(u, number);
          const expires = Date.now() + (options.urlTtlMs ?? 2000);
          const suffix = `${u.id}:${number}:${u.transportEpoch}:${expires}`;
          return {
            partNumber: number,
            offsetBytes: String((number - 1) * PART_BYTES),
            lengthBytes: String(length),
            url: `${url.origin}/provider/${u.id}/${number}?epoch=${u.transportEpoch}&expires=${expires}&signature=${signature(suffix)}`,
            expiresAtMs: String(expires),
            headers: {},
          };
        });
        count("sign_requests");
        await persist();
        return reply(res, 200, { transportEpoch: u.transportEpoch, parts });
      }
      if (action === "parts/receipts") {
        if (!Array.isArray(body.parts) || body.parts.length > 32)
          fail(400, "bad_receipt_batch");
        for (const part of body.parts) {
          const actual = u.parts[String(part.partNumber)];
          if (
            !actual ||
            actual.etag !== part.etag ||
            actual.sizeBytes !== part.sizeBytes
          )
            fail(409, "receipt_mismatch");
          u.receipts[String(part.partNumber)] = actual;
        }
        count("receipt_batches");
        await persist();
        if (
          options.loseReceiptResponseOnce &&
          !state.counters.injected_receipt_response_loss
        ) {
          count("injected_receipt_response_loss");
          await persist();
          req.socket.destroy();
          return;
        }
        return reply(res, 200, { accepted: body.parts.length });
      }
      fail(404, "not_found");
    } catch (error: any) {
      if (!res.headersSent && !res.destroyed)
        reply(res, error instanceof Fault ? error.status : 500, {
          error: {
            code: error instanceof Fault ? error.code : "fixture_error",
          },
          simulated: true,
        });
      else res.destroy();
    }
  });
  await new Promise<void>((done) =>
    server.listen(options.port ?? 0, options.host ?? "127.0.0.1", done),
  );
  const address = server.address() as { port: number };
  return {
    server,
    state,
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((done, reject) =>
        server.close((error) => (error ? reject(error) : done())),
      );
      await saveChain;
    },
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const fixture = await startFixture({
    directory: resolve(process.env.SPIKE_DATA_DIR ?? "./fixture-data"),
    port: Number(process.env.PORT ?? 8787),
    host: process.env.SPIKE_HOST ?? "127.0.0.1",
    urlTtlMs: Number(process.env.SPIKE_URL_TTL_MS ?? 2000),
    chunkDelayMs: Number(process.env.SPIKE_CHUNK_DELAY_MS ?? 0),
    failPartOnce: Number(process.env.SPIKE_FAIL_PART_ONCE ?? 0),
    loseReceiptResponseOnce:
      process.env.SPIKE_LOSE_RECEIPT_RESPONSE_ONCE === "1",
    loseCompleteResponseOnce:
      process.env.SPIKE_LOSE_COMPLETE_RESPONSE_ONCE === "1",
  });
  console.log(
    JSON.stringify({
      url: fixture.url,
      simulated: true,
      auth: "synthetic_only",
      provider: "local_files_not_s3",
    }),
  );
  process.on("SIGINT", async () => {
    await fixture.close();
    process.exit(0);
  });
}
