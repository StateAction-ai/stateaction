import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  parseWorkerHealth,
  type PlatformVerifyRequest,
  type WorkerHealth,
} from "@stateaction/contracts";
export class LocalExecutor {
  async verify(input: PlatformVerifyRequest): Promise<WorkerHealth> {
    if (
      process.env.APP_ENV !== "local" ||
      process.env.EXECUTION_BACKEND !== "local"
    )
      throw new Error("LocalExecutor requires explicit local configuration");
    const python =
      process.env.PYTHON_EXECUTABLE ??
      fileURLToPath(
        new URL(
          "../../../workers/processing/.venv/bin/python",
          import.meta.url,
        ),
      );
    return new Promise((resolve, reject) => {
      // No shell, inherited provider credentials, or caller-controlled arguments.
      const child = spawn(python, ["-m", "stateaction_processing", "health"], {
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          PATH: process.env.PATH ?? "",
          PYTHONNOUSERSITE: "1",
          PYTHONUNBUFFERED: "1",
        },
      });
      let stdout = "";
      let stderrBytes = 0;
      let bytes = 0;
      let failure: Error | undefined;
      const fail = (error: Error) => {
        failure ??= error;
        child.kill("SIGKILL");
      };
      const timer = setTimeout(
        () => fail(new Error("Local worker deadline exceeded")),
        10000,
      );
      child.stdout.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 65536)
          fail(new Error("Local worker output exceeded limit"));
        else stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderrBytes += chunk.length;
        if (stderrBytes > 65536)
          fail(new Error("Local worker error output exceeded limit"));
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (failure || code !== 0) {
          reject(failure ?? new Error(`Local worker exited ${code}`));
          return;
        }
        try {
          const result = parseWorkerHealth(JSON.parse(stdout));
          if (result.requestId !== input.requestId)
            throw new Error("Worker request mismatch");
          resolve(result);
        } catch (error) {
          reject(error);
        }
      });
      child.stdin.on("error", (error) => fail(error));
      child.stdin.end(JSON.stringify(input));
    });
  }
}
