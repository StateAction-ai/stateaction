// Race-free loopback port allocation for parallel test workers (SA-114).
//
// `listen(0)` then `close()` has two races: two workers can be handed the same
// port before either child process binds it, and the closed port returns to the
// kernel's ephemeral range, where any outbound connection (database, S3) can
// take it before the child starts. Here:
//   * ports are drawn at random from the range BELOW the kernel's ephemeral range
//     (`ip_local_port_range`), which the kernel never hands out on its own; where
//     no such range exists, `listen(0)` is the fallback;
//   * a port is also CLAIMED with an exclusive file named after it in a per-user
//     directory, owned by the PID of the allocating process, so no other worker
//     using this helper receives it while that process lives. Claims are removed
//     on exit; a claim whose owner is dead is taken over.
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const claimDir =
  process.env.STATEACTION_PORT_CLAIM_DIR ??
  join(tmpdir(), `stateaction-port-claims-${process.getuid?.() ?? "user"}`);
const held = new Set();
let hooked = false;
const LOW = 20000;

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

/** First port of the kernel's ephemeral range (Linux), or undefined. */
function ephemeralStart() {
  try {
    return Number(
      readFileSync("/proc/sys/net/ipv4/ip_local_port_range", "utf8")
        .trim()
        .split(/\s+/)[0],
    );
  } catch {
    return undefined;
  }
}

function claimFile(port) {
  return join(claimDir, String(port));
}

/** Claim one port for this process; false when another live process owns it. */
export function claimPort(port) {
  mkdirSync(claimDir, { recursive: true, mode: 0o700 });
  const file = claimFile(port);
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const fd = openSync(file, "wx", 0o600);
      writeSync(fd, String(process.pid));
      closeSync(fd);
      held.add(file);
      if (!hooked) {
        hooked = true;
        process.on("exit", () => {
          for (const f of held) rmSync(f, { force: true });
        });
      }
      return true;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    let owner;
    try {
      owner = Number(readFileSync(file, "utf8").trim());
    } catch (error) {
      if (error.code === "ENOENT") continue; // released meanwhile: try again
      throw error;
    }
    // An empty file is a claim still being written: treat it as owned.
    if (!owner || alive(owner)) return false;
    // Take over a dead owner's claim. Rename it away first so only one
    // contender removes it, then check that what was moved is the dead claim
    // and not a live one written in between (put that back and give up).
    const moved = `${file}.stale-${process.pid}`;
    try {
      renameSync(file, moved);
    } catch (error) {
      if (error.code === "ENOENT") continue; // another worker took it over
      throw error;
    }
    let content = "";
    try {
      content = readFileSync(moved, "utf8").trim();
    } catch {}
    if (Number(content) === owner) {
      rmSync(moved, { force: true });
    } else {
      try {
        renameSync(moved, file);
      } catch {}
      return false;
    }
  }
  return false;
}

/** Release this process's claim early (claims are also released on exit). */
export function releasePort(port) {
  const file = claimFile(port);
  if (held.delete(file)) rmSync(file, { force: true });
}

async function bound(port) {
  const server = createServer();
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", resolve);
    });
  } catch {
    return undefined;
  }
  return server;
}

/** A loopback port no other worker of this helper holds. */
export async function freePort() {
  const top = ephemeralStart();
  const high = top === undefined ? undefined : Math.min(top - 1, 32767);
  for (let attempt = 0; attempt < 200; attempt++) {
    const wanted =
      high !== undefined && high > LOW
        ? LOW + Math.floor(Math.random() * (high - LOW + 1))
        : 0;
    const server = await bound(wanted);
    if (!server) continue;
    const { port } = server.address();
    // Claim while the socket is still bound so nothing else can take it first.
    const claimed = claimPort(port);
    await new Promise((resolve) => server.close(resolve));
    if (claimed) return port;
  }
  throw new Error("no unclaimed loopback port after 200 attempts");
}
