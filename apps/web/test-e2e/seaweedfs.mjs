// Throwaway SeaweedFS S3 for E2E tests: a uniquely named, labelled container
// (pinned infra/compose.yaml image) on an ephemeral loopback port with tmpfs
// data and a random per-run identity. Shares no Compose project, port, volume
// or data with other work and is always removed.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const root = new URL("../../../", import.meta.url);
const docker = (args) =>
  execFileSync("docker", args, { encoding: "utf8" }).trim();

export async function startSeaweedfs() {
  const image = /^\s*image:\s*(chrislusf\/seaweedfs:\S+)\s*$/m.exec(
    readFileSync(new URL("infra/compose.yaml", root), "utf8"),
  )?.[1];
  if (!image) throw new Error("Could not read the pinned SeaweedFS image");
  const name = `stateaction-sa19-s3-${randomBytes(6).toString("hex")}`;
  const accessKeyId = `e2e${randomBytes(8).toString("hex")}`;
  const secretAccessKey = randomBytes(24).toString("hex");
  const dir = mkdtempSync(join(tmpdir(), "sa19-s3-"));
  writeFileSync(
    join(dir, "s3.json"),
    JSON.stringify({
      identities: [
        {
          name: "e2e",
          credentials: [{ accessKey: accessKeyId, secretKey: secretAccessKey }],
          actions: ["Admin", "Read", "List", "Write"],
        },
      ],
    }),
    { mode: 0o644 },
  );
  const stop = () => {
    try {
      docker(["rm", "-f", "-v", name]);
    } catch {
      // Already gone.
    }
    rmSync(dir, { recursive: true, force: true });
  };
  try {
    docker([
      "run",
      "-d",
      "--rm",
      "--name",
      name,
      "--label",
      "stateaction.owner=sa-19-e2e",
      "-p",
      "127.0.0.1::9000",
      "-v",
      `${join(dir, "s3.json")}:/etc/seaweedfs/s3.json:ro`,
      "-v",
      `${new URL("infra/seaweedfs-master.toml", root).pathname}:/etc/seaweedfs/master.toml:ro`,
      "--tmpfs",
      "/data:rw,size=512m",
      image,
      "server",
      "-ip=127.0.0.1",
      "-ip.bind=0.0.0.0",
      "-dir=/data",
      "-volume.max=8",
      "-master.volumeSizeLimitMB=64",
      "-filer",
      "-s3",
      "-s3.port=9000",
      "-s3.config=/etc/seaweedfs/s3.json",
    ]);
    const port = docker(["port", name, "9000/tcp"])
      .split("\n")[0]
      .split(":")
      .pop();
    for (let i = 0; i < 120; i++) {
      try {
        if (
          docker([
            "exec",
            name,
            "wget",
            "-qO-",
            "http://127.0.0.1:9333/dir/status",
          ]).includes('"Url":"127.0.0.1:8080"')
        )
          return {
            name,
            endpoint: `http://127.0.0.1:${port}`,
            accessKeyId,
            secretAccessKey,
            stop,
          };
      } catch {}
      await sleep(500);
    }
    throw new Error("SeaweedFS did not become ready");
  } catch (error) {
    stop();
    throw error;
  }
}
