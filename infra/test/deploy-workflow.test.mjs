import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const text = readFileSync(
  new URL("../../.github/workflows/deploy.yml", import.meta.url),
  "utf8",
);
const deployJob = text.slice(text.indexOf("\n  deploy:"));
const validateJob = text.slice(0, text.indexOf("\n  deploy:"));

function extractRunBlocks(yaml) {
  const lines = yaml.split("\n");
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)run:\s*(.*)$/);
    if (!m) continue;
    const indent = m[1].length;
    const rest = m[2].trim();
    if (rest === "|" || rest === "|-" || rest === ">" || rest === ">-") {
      const body = [];
      for (i++; i < lines.length; i++) {
        if (lines[i].trim() === "") {
          body.push("");
          continue;
        }
        const lineIndent = lines[i].match(/^(\s*)/)[1].length;
        if (lineIndent <= indent) {
          i--;
          break;
        }
        body.push(lines[i]);
      }
      blocks.push(body.join("\n"));
    } else {
      blocks.push(rest);
    }
  }
  return blocks;
}

function evalDeployIf({ target, shouldDeploy, ref, eventName, autoDeploy }) {
  const m = deployJob.match(/\n {4}if:\s*>-\n([\s\S]*?)\n {4}runs-on:/);
  assert.ok(m, "deploy job must have a multiline if: condition");
  const expr = m[1]
    .split("\n")
    .map((l) => l.trim())
    .join(" ");
  const js = expr
    .replaceAll("needs.validate.outputs.target", "target")
    .replaceAll("needs.validate.outputs.should_deploy", "shouldDeploy")
    .replaceAll("github.ref", "ref")
    .replaceAll("github.event_name", "eventName")
    .replaceAll("vars.AUTO_DEPLOY_ENABLED", "autoDeploy")
    .replaceAll(/startsWith\(([^,]+),\s*([^)]+)\)/g, "($1).startsWith($2)");
  // Pure boolean check on the extracted expression.
  return new Function(
    "target",
    "shouldDeploy",
    "ref",
    "eventName",
    "autoDeploy",
    `return Boolean(${js});`,
  )(target, shouldDeploy, ref, eventName, autoDeploy);
}

test("triggers are main push, deploy/* tags, and manual dispatch only; never pull_request or schedule", () => {
  assert.match(text, /workflow_dispatch:/);
  assert.match(text, /branches:\n\s+- main/);
  assert.match(text, /tags:\n\s+- "deploy\/\*"/);
  assert.doesNotMatch(text, /pull_request/);
  assert.doesNotMatch(text, /\n {2}schedule:/);
});

test("deploy job boolean condition gates main push on AUTO_DEPLOY_ENABLED and should_deploy", () => {
  const mainPush = {
    target: "production",
    shouldDeploy: "true",
    ref: "refs/heads/main",
    eventName: "push",
  };
  assert.equal(evalDeployIf({ ...mainPush, autoDeploy: "" }), false);
  assert.equal(evalDeployIf({ ...mainPush, autoDeploy: "false" }), false);
  assert.equal(evalDeployIf({ ...mainPush, autoDeploy: "true" }), true);
  assert.equal(
    evalDeployIf({ ...mainPush, shouldDeploy: "false", autoDeploy: "true" }),
    false,
  );
  assert.equal(
    evalDeployIf({
      target: "production",
      shouldDeploy: "true",
      ref: "refs/tags/deploy/2026-11-27",
      eventName: "push",
      autoDeploy: "",
    }),
    true,
  );
  assert.equal(
    evalDeployIf({
      target: "production",
      shouldDeploy: "true",
      ref: "refs/heads/main",
      eventName: "workflow_dispatch",
      autoDeploy: "",
    }),
    true,
  );
  assert.equal(
    evalDeployIf({
      target: "dev",
      shouldDeploy: "true",
      ref: "refs/heads/main",
      eventName: "workflow_dispatch",
      autoDeploy: "true",
    }),
    false,
  );
  assert.equal(
    evalDeployIf({
      target: "production",
      shouldDeploy: "true",
      ref: "refs/heads/feature",
      eventName: "workflow_dispatch",
      autoDeploy: "true",
    }),
    false,
  );
});

test("every action is pinned to a full commit SHA", () => {
  const uses = [...text.matchAll(/uses: (\S+)/g)].map((m) => m[1]);
  assert.ok(uses.length >= 2);
  for (const u of uses) assert.match(u, /@[0-9a-f]{40}$/, u);
});

test("least privilege: read-only token, secrets only in the protected production job", () => {
  assert.match(text, /permissions:\n {2}contents: read/);
  assert.doesNotMatch(validateJob, /secrets\./);
  assert.match(deployJob, /environment: production/);
  for (const name of [
    "RENDER_API_KEY",
    "S3_SECRET_ACCESS_KEY",
    "APP_DB_PASSWORD",
  ])
    assert.match(deployJob, new RegExp(`secrets\\.${name}`));
  assert.doesNotMatch(text, /secrets\.(GITHUB_TOKEN|ACTIONS)/);
  assert.match(text, /persist-credentials: false/);
});

test("install and build run without secrets; restore-allowlist only receives RENDER_API_KEY and runs always", () => {
  const prep = deployJob.slice(
    deployJob.indexOf("Install and build"),
    deployJob.indexOf("Deploy, migrate, smoke"),
  );
  assert.match(prep, /render-deploy\.sh prepare/);
  assert.doesNotMatch(prep, /secrets\./);
  const restore = deployJob.slice(
    deployJob.indexOf("Close the database allow list"),
  );
  assert.match(restore, /if: always\(\)/);
  assert.match(restore, /restore-allowlist/);
  const restoreSecrets = [...restore.matchAll(/secrets\.([A-Z0-9_]+)/g)].map(
    (m) => m[1],
  );
  assert.deepEqual(restoreSecrets, ["RENDER_API_KEY"]);
  assert.match(deployJob, /github\.ref == 'refs\/heads\/main'/);
});

test("the job validates inputs, computes change-only scope first, refuses refs off main, and runs the shared script", () => {
  assert.match(validateJob, /invalid mode:/);
  assert.match(validateJob, /invalid components:/);
  assert.match(validateJob, /merge-base --is-ancestor/);
  assert.match(validateJob, /scripts\/platform\/deploy-scope\.mjs/);
  assert.match(validateJob, /render-deploy\.sh dry-run/);
  assert.match(deployJob, /needs: validate/);
  assert.match(deployJob, /render-deploy\.sh production/);
  assert.match(deployJob, /render-deploy\.sh components/);
  assert.match(deployJob, /fetch-depth: 0/);
});

test("user-controlled inputs reach shell only through env, never interpolated", () => {
  const blocks = extractRunBlocks(text);
  assert.ok(blocks.length >= 6);
  for (const body of blocks) {
    assert.doesNotMatch(
      body,
      /\$\{\{\s*(inputs|github\.event|github\.head_ref)/,
    );
  }
});

test("render-deploy.sh prepare refuses to run when any sensitive secret is present", () => {
  const script = fileURLToPath(
    new URL("../../scripts/deploy/render-deploy.sh", import.meta.url),
  );
  const r = spawnSync("bash", [script, "prepare", "a".repeat(40)], {
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      GOOGLE_CLIENT_SECRET: "should-be-refused",
    },
    encoding: "utf8",
  });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /refusing to prepare with GOOGLE_CLIENT_SECRET/);
});
