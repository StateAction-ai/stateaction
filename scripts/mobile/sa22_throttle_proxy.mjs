// Loopback TCP proxy used ONLY by the SA-22 emulator driver to make the real
// presigned S3 PUTs slow enough to interrupt (background, process kill, network
// loss, owner switch, capture pause, logout) and to MEASURE what the device sent.
//
// It is protocol-agnostic (no HTTP parsing): bytes are forwarded unchanged, so
// the signed Host header, URLs and request bodies are untouched and the server
// still verifies the original signature. The driver adb-reverses the device's
// 127.0.0.1:19000 to this proxy, which forwards to the real local S3 port.
//
// Modes: flow (rate-limited), stall (hold bytes, keep sockets), reset (drop
// sockets). Counters (device -> storage bytes, connections) are the evidence
// for "no part lands after logout" and "paused during capture". It runs inside
// the guarded driver process, binds 127.0.0.1 only and never logs payloads.
import { createServer, connect } from "node:net";

export const DEFAULT_RATE = 256 * 1024; // bytes per second

export async function startProxy({
  targetPort,
  listenPort = 0,
  rate = DEFAULT_RATE,
}) {
  let mode = "flow";
  let bytesPerSecond = rate;
  // readBytes = bytes the proxy read from the DEVICE socket; forwardedBytes = bytes
  // actually written upstream to storage. Bytes the device wrote BEFORE a fence can
  // still sit in kernel socket buffers and be read/forwarded after it, so only a
  // new connection, or bytes after a settle window long enough for those buffers to
  // drain, indicate new device activity.
  const stats = {
    readBytes: 0,
    forwardedBytes: 0,
    downBytes: 0,
    connections: 0,
    active: 0,
  };
  const marks = new Map();
  const sockets = new Set();
  const waiters = new Set();

  const wakeAll = () => {
    for (const w of [...waiters]) w();
    waiters.clear();
  };

  /** Forward device->storage with rate limiting and stall/reset control. */
  function pipeUp(src, dst) {
    src.on("data", (chunk) => {
      stats.readBytes += chunk.length;
      src.pause();
      const sendSlice = (buf) => {
        if (src.destroyed || dst.destroyed) return;
        if (mode === "reset") {
          src.destroy();
          dst.destroy();
          return;
        }
        if (mode === "stall") {
          // Re-check when the mode changes.
          waiters.add(() => sendSlice(buf));
          return;
        }
        const slice = buf.subarray(
          0,
          Math.max(1, Math.floor(bytesPerSecond / 20)),
        );
        const rest = buf.subarray(slice.length);
        dst.write(slice, () => {
          stats.forwardedBytes += slice.length;
          if (rest.length === 0) {
            if (!src.destroyed) src.resume();
          } else {
            setTimeout(() => sendSlice(rest), 50);
          }
        });
        if (rest.length > 0) return;
      };
      sendSlice(chunk);
    });
  }

  const server = createServer((client) => {
    stats.connections++;
    stats.active++;
    sockets.add(client);
    const upstream = connect({ host: "127.0.0.1", port: targetPort });
    sockets.add(upstream);
    pipeUp(client, upstream);
    upstream.on("data", (chunk) => {
      stats.downBytes += chunk.length;
      if (mode === "reset") return;
      client.write(chunk);
    });
    const done = () => {
      stats.active = Math.max(0, stats.active - 1);
      sockets.delete(client);
      sockets.delete(upstream);
      client.destroy();
      upstream.destroy();
    };
    client.on("close", done);
    upstream.on("close", done);
    client.on("error", () => {});
    upstream.on("error", () => {});
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("proxy listen timed out")),
      5000,
    );
    server.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    server.listen(listenPort, "127.0.0.1", () => {
      clearTimeout(timer);
      resolve();
    });
  });

  return {
    port: server.address().port,
    stats: () => ({
      ...stats,
      upBytes: stats.forwardedBytes,
      mode,
      bytesPerSecond,
    }),
    /** Records a boundary (for example the logout ack) to measure against later. */
    mark(label) {
      marks.set(label, { at: Date.now(), ...stats });
    },
    /** Counters accumulated since [label] was marked. */
    since(label) {
      const m = marks.get(label);
      if (!m) throw new Error(`no mark ${label}`);
      return {
        ms: Date.now() - m.at,
        readBytes: stats.readBytes - m.readBytes,
        forwardedBytes: stats.forwardedBytes - m.forwardedBytes,
        newConnections: stats.connections - m.connections,
      };
    },
    setMode(next) {
      if (!["flow", "stall", "reset"].includes(next))
        throw new Error(`bad mode ${next}`);
      mode = next;
      if (next === "reset") for (const s of sockets) s.destroy();
      else wakeAll();
    },
    setRate(next) {
      bytesPerSecond = next;
    },
    async close() {
      for (const s of sockets) s.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
