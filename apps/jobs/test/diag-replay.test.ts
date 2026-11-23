import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import type { RecipeV1 } from "@stateaction/contracts";
import { buildDiag, scrubText } from "../src/diag.js";
import { JournalStore } from "../src/journal.js";
import { replayStage } from "../src/replay-stage.js";

const TOKEN = "sa_svc_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEF0";
const JOB = randomUUID();
const resources = {
  gpu: "none",
  budgetSeconds: 300,
  maxContainers: 1,
  retries: 0,
};
const recipe = {
  schemaVersion: 1,
  recipeId: "caption_failed@1",
  maxJobCostUsd: "0.00",
  stages: [
    {
      stage: "segment",
      enabled: true,
      module: "stub_segmenter@1",
      params: {},
      resources,
    },
    {
      stage: "caption",
      enabled: true,
      module: "stub_captioner@1",
      params: { fail_captions: "0,1" },
      resources,
    },
    {
      stage: "hand_pose",
      enabled: true,
      module: "hand_pose_cpu_v1@1",
      params: {},
      resources,
    },
  ],
} as unknown as RecipeV1;
const api = {
  recipe: async () => recipe,
  status: async () =>
    ({ jobId: JOB, state: "failed", kind: "process_recording" }) as never,
  dagRun: async () => ({ schemaVersion: 1, jobId: JOB, stages: [] }) as never,
  priorStages: async () =>
    ({
      schemaVersion: 1,
      jobId: JOB,
      stages: [
        {
          stage: "segment",
          state: "succeeded",
          errorCode: null,
          counts: {},
          outputs: [
            {
              fileId: randomUUID(),
              role: "diagnostic_blob",
              slot: "diagnostics/segment/log.txt",
              sizeBytes: "10",
              sha256: "a".repeat(64),
            },
          ],
        },
      ],
    }) as never,
};

let root: string;
before(() => {
  root = mkdtempSync(join(tmpdir(), "sa96-"));
});
after(() => rmSync(root, { recursive: true, force: true }));

describe("diag bundle", () => {
  test("a seeded fake token in a journal, a child log and a blob never reaches the bundle", async () => {
    const state = join(root, "state");
    const cache = join(root, "cache");
    mkdirSync(join(state, JOB, "segment"), { recursive: true, mode: 0o700 });
    chmodSync(join(state, JOB), 0o700);
    // A journal that is not strictly valid is reported unreadable, never copied.
    writeFileSync(
      join(state, JOB, "segment", "journal.json"),
      JSON.stringify({ version: 1, bootstrapToken: TOKEN }),
      { mode: 0o600 },
    );
    writeFileSync(
      join(state, JOB, "segment", "child.log"),
      `Authorization: Bearer ${TOKEN}\nmore ${TOKEN}\n`,
      { mode: 0o600 },
    );
    mkdirSync(join(cache, JOB, "outputs/diagnostics/segment"), {
      recursive: true,
    });
    writeFileSync(
      join(cache, JOB, "outputs/diagnostics/segment/log.txt"),
      `ok line\nbootstrapToken=${TOKEN}\nurl https://s3.local/b/k?X-Amz-Signature=abc123\n`,
    );
    const out = join(root, "bundle.tgz");
    const result = await buildDiag(
      { api, store: new JournalStore(state), cacheDir: cache },
      JOB,
      out,
    );
    assert.ok(result.bytes > 0 && result.bytes < 8 * 1024 * 1024);
    const dir = join(root, "unpacked");
    mkdirSync(dir);
    assert.equal(spawnSync("tar", ["-xzf", out, "-C", dir]).status, 0);
    const all: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true }))
        e.isDirectory()
          ? walk(join(d, e.name))
          : all.push(
              `${join(d, e.name)}\n${readFileSync(join(d, e.name), "utf8")}`,
            );
    };
    walk(dir);
    const text = all.join("\n");
    assert.ok(!text.includes("FAKEFAKE"), "token must not appear");
    assert.ok(!text.includes("abc123"), "signed URL query must not appear");
    assert.match(text, /job-status\.json/);
    assert.match(text, /"unreadable": true/);
    assert.match(text, /ok line/);
    assert.match(text, /\[redacted\]/);
  });

  test("scrubText redacts camelCase, underscore and header secrets without any sa_svc prefix", () => {
    const secrets = [
      "bootstrapToken=Zx9Qw7Lm",
      'clientSecret":"Zx9Qw7Lm"',
      "S3_SECRET_ACCESS_KEY=Zx9Qw7Lm",
      "api_key: Zx9Qw7Lm",
      "AWS_ACCESS_KEY_ID=Zx9Qw7Lm",
      "Authorization: Basic Zx9Qw7Lm",
      "db_password='Zx9Qw7Lm'",
      "sessionCookie=Zx9Qw7Lm",
    ];
    for (const line of secrets) {
      const out = scrubText(`pre ${line} post`);
      assert.ok(!out.includes("Zx9Qw7Lm"), `${line} -> ${out}`);
      assert.ok(out.includes("[redacted]"), line);
    }
    assert.equal(scrubText("window 3 captions ok"), "window 3 captions ok");
  });

  test("scrubText removes capabilities, bearer values and signed URLs", () => {
    const s = scrubText(
      `a ${TOKEN} Bearer abc.def password: hunter2 https://h/x?token=zzz`,
    );
    for (const bad of ["FAKEFAKE", "abc.def", "hunter2", "zzz"])
      assert.ok(!s.includes(bad), bad);
  });
});

describe("replay-stage", () => {
  const stageRun = (dir: string, module?: string, stage = "caption") => {
    const cache = join(root, "rcache");
    mkdirSync(join(cache, JOB, "outputs"), { recursive: true });
    writeFileSync(join(cache, JOB, "source.mcap"), "mcap-bytes");
    writeFileSync(
      join(cache, JOB, "task-input.json"),
      JSON.stringify({ schemaVersion: 3, jobId: JOB }),
    );
    writeFileSync(join(cache, JOB, "outputs/segments.json"), "{}");
    let seen: string[] = [];
    const run = (args: string[]) => {
      seen = args;
      writeFileSync(
        join(dir, "receipt.json"),
        JSON.stringify({ status: "failed", errorCode: "x" }),
      );
      return 3;
    };
    return {
      go: () =>
        replayStage(
          { api, cacheDir: cache, python: "python", workerDir: root, run },
          { jobId: JOB, stage, ...(module ? { module } : {}), ioDir: dir },
        ),
      args: () => seen,
    };
  };

  test("replays a stub caption of the caption_failed job from cached inputs into the io dir", async () => {
    const dir = join(root, "io1");
    const r = stageRun(dir, "stub_captioner");
    const result = await r.go();
    assert.equal(result.module, "stub_captioner@1");
    assert.deepEqual(r.args().slice(-3), ["run-stage", "--io-dir", dir]);
    const boot = JSON.parse(readFileSync(join(dir, "bootstrap.json"), "utf8"));
    assert.equal(boot.stage, "caption");
    assert.equal(boot.taskInput.recipe.stages[1].params.fail_captions, "0,1");
    assert.match(boot.segmentsSha256, /^[0-9a-f]{64}$/);
    assert.equal(readFileSync(join(dir, "segments.json"), "utf8"), "{}");
    assert.equal(result.receipt?.status, "failed");
  });

  test("a flora module needs --allow-spend and never runs locally; segment needs no segments file", async () => {
    const r = stageRun(join(root, "io2"), "flora_captioner_vllm_fp8");
    await assert.rejects(r.go(), /--allow-spend/);
    await assert.rejects(
      replayStage(
        { api, cacheDir: root, python: "p", workerDir: root },
        {
          jobId: JOB,
          stage: "caption",
          module: "flora_captioner_vllm_fp8",
          ioDir: join(root, "io3"),
          allowSpend: true,
        },
      ),
      /Modal harness/,
    );
    await assert.rejects(
      replayStage(
        { api, cacheDir: root, python: "p", workerDir: root },
        { jobId: JOB, stage: "hand_pose", ioDir: join(root, "io4") },
      ),
      /segment or caption/,
    );
  });
});
