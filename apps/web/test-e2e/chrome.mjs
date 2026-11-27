import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

/** Headless Chrome over DevTools, bound to the test process's resource scope. */
export async function findChrome() {
  for (const candidate of [
    process.env.CHROME_BIN,
    process.env.CHROME,
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter(Boolean)) {
    try {
      await access(candidate);
      return candidate;
    } catch {}
  }
  return null;
}

// Expand a Cpus_allowed_list such as "0-3,8,10-11".
function expandCpuList(list) {
  return list.split(",").flatMap((range) => {
    const [first, last = first] = range.split("-").map(Number);
    return Array.from({ length: last - first + 1 }, (_, n) => first + n);
  });
}

// The `count` least busy allowed CPUs over a short /proc/stat sample, as "a,b".
async function quietestCpus(count) {
  const [status, isolated] = await Promise.all([
    readFile("/proc/self/status", "utf8"),
    readFile("/sys/devices/system/cpu/isolated", "utf8").catch((error) => {
      if (error.code !== "ENOENT") throw error;
      return "";
    }),
  ]);
  const allowed = expandCpuList(
    status.match(/^Cpus_allowed_list:\s*(.+)$/m)[1],
  );
  const isolatedCpus = isolated.trim() ? expandCpuList(isolated.trim()) : [];
  const balanced = allowed.filter((cpu) => !isolatedCpus.includes(cpu));
  const sample = async () => {
    const times = new Map();
    for (const line of (await readFile("/proc/stat", "utf8")).split("\n")) {
      const match = line.match(/^cpu(\d+)\s+(.+)$/);
      if (!match) continue;
      const fields = match[2].split(/\s+/).map(Number);
      const idle = fields[3] + (fields[4] ?? 0);
      times.set(Number(match[1]), [idle, fields.reduce((a, b) => a + b, 0)]);
    }
    return times;
  };
  const before = await sample();
  await sleep(250);
  const after = await sample();
  const busy = (cpu) => {
    const [idle0, total0] = before.get(cpu) ?? [0, 0];
    const [idle1, total1] = after.get(cpu) ?? [0, 0];
    return total1 === total0 ? 1 : 1 - (idle1 - idle0) / (total1 - total0);
  };
  return (balanced.length ? balanced : allowed)
    .sort((a, b) => busy(a) - busy(b) || a - b)
    .slice(0, count)
    .sort((a, b) => a - b)
    .join(",");
}

export async function launchChrome(binary, { webgl = false } = {}) {
  // Chromium places Unix sockets under its temp root. A deeply nested CI
  // export path can exceed the Linux socket path limit.
  const tempRoot = process.platform === "linux" ? "/tmp" : tmpdir();
  // Chrome and SwiftShader size their pools from available CPUs. Limit their
  // fan-out within the guarded job's task cap while leaving WebCodecs enabled.
  // The four CPUs are the least busy of the allowed set right now: always taking the
  // first two put every concurrent agent's Chrome on CPUs 0-1, where the CPU-bound
  // SwiftShader viewer starved DevTools past its 10 s command timeout.
  const cpus = process.platform === "linux" ? await quietestCpus(4) : null;
  const profile = await mkdtemp(join(tempRoot, "stateaction-chrome-"));
  const child = spawn(
    cpus ? "taskset" : binary,
    [
      ...(cpus ? ["-c", cpus, binary] : []),
      "--headless=new",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-extensions",
      ...(webgl
        ? ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"]
        : ["--disable-gpu"]),
      ...(process.getuid?.() === 0 || process.env.CI === "true" || webgl
        ? ["--no-sandbox"]
        : []),
      `--user-data-dir=${profile}`,
      "--remote-debugging-port=0",
      "about:blank",
    ],
    {
      stdio: ["ignore", "ignore", "pipe"],
      detached: true,
      // Avoid Chrome asking the desktop session to move it to an app scope.
      env: {
        ...process.env,
        DBUS_SESSION_BUS_ADDRESS: "unix:path=/dev/null",
        TMPDIR: profile,
      },
    },
  );
  const exited = once(child, "exit").catch((error) => error);
  // Chrome's own stderr (GPU, renderer and DevTools errors) goes into timeout errors.
  let chromeLog = "";
  child.stderr.on("data", (chunk) => {
    chromeLog = (chromeLog + chunk).slice(-3000);
  });
  let ws;
  let id = 0;
  let targetCrashed = false;
  const pending = new Map();

  async function close() {
    ws?.close();
    try {
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        process.kill(-child.pid, "SIGTERM");
        const timeout = setTimeout(() => {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {}
        }, 3000);
        try {
          await exited;
        } finally {
          clearTimeout(timeout);
          // Renderer children inherit the stderr pipe; do not let one hold the event loop.
          child.stderr.destroy();
        }
      }
    } finally {
      await rm(profile, { recursive: true, force: true });
    }
  }

  try {
    let port;
    for (let i = 0; i < 100 && !port; i++) {
      try {
        port = (
          await readFile(join(profile, "DevToolsActivePort"), "utf8")
        ).split("\n")[0];
      } catch {
        if (!child.pid || child.exitCode !== null)
          throw new Error("Chrome exited before exposing DevTools");
        await sleep(100);
      }
    }
    if (!port) throw new Error("Chrome did not expose DevTools");
    const targets = await (
      await fetch(`http://127.0.0.1:${port}/json/list`, {
        signal: AbortSignal.timeout(5000),
      })
    ).json();
    ws = new WebSocket(
      targets.find((t) => t.type === "page").webSocketDebuggerUrl,
    );
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = () =>
        reject(new Error("Could not connect to Chrome DevTools"));
      const timeout = setTimeout(
        () => reject(new Error("Timed out connecting to Chrome DevTools")),
        5000,
      );
      ws.addEventListener("open", () => clearTimeout(timeout), { once: true });
      ws.addEventListener("error", () => clearTimeout(timeout), { once: true });
    });
    ws.onmessage = ({ data }) => {
      const message = JSON.parse(data);
      if (message.method === "Inspector.targetCrashed") targetCrashed = true;
      const waiter = pending.get(message.id);
      if (!waiter) return;
      if (message.error) waiter(new Error(message.error.message));
      else waiter(null, message.result);
    };
    const client = {
      pid: child.pid,
      close,
      send(method, params = {}) {
        return new Promise((resolve, reject) => {
          const requestId = ++id;
          const finish = (error, result) => {
            clearTimeout(timeout);
            pending.delete(requestId);
            if (error) reject(error);
            else resolve(result);
          };
          const timeout = setTimeout(
            () =>
              finish(
                new Error(
                  `Chrome DevTools timed out: ${method} (browser exit=${child.exitCode}, signal=${child.signalCode}, target crashed=${targetCrashed}); chrome stderr tail:\n${chromeLog}`,
                ),
              ),
            10_000,
          );
          pending.set(requestId, finish);
          try {
            ws.send(JSON.stringify({ id: requestId, method, params }));
          } catch (error) {
            finish(error);
          }
        });
      },
    };
    await client.send("Inspector.enable");
    return client;
  } catch (error) {
    await close();
    throw error;
  }
}
