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

export async function launchChrome(binary, { webgl = false } = {}) {
  // Chromium places Unix sockets under its temp root. A deeply nested CI
  // export path can exceed the Linux socket path limit.
  const tempRoot = process.platform === "linux" ? "/tmp" : tmpdir();
  // Chrome and SwiftShader size their pools from available CPUs. Limit their
  // fan-out within the guarded job's task cap while leaving WebCodecs enabled.
  const cpus =
    process.platform === "linux"
      ? (await readFile("/proc/self/status", "utf8"))
          .match(/^Cpus_allowed_list:\s*(.+)$/m)[1]
          .split(",")
          .flatMap((range) => {
            const [first, last = first] = range.split("-").map(Number);
            return last === undefined || first === last
              ? [first]
              : [first, first + 1];
          })
          .slice(0, 2)
          .join(",")
      : null;
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
      stdio: "ignore",
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
                  `Chrome DevTools timed out: ${method} (browser exit=${child.exitCode}, signal=${child.signalCode}, target crashed=${targetCrashed})`,
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
