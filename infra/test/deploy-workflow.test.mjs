import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
const text = readFileSync(
  new URL("../../.github/workflows/deploy.yml", import.meta.url),
  "utf8",
);
const deployJob = text.slice(text.indexOf("\n  deploy:"));
const validateJob = text.slice(0, text.indexOf("\n  deploy:"));

test("triggers are manual dispatch and deploy/* tags only; never pull_request_target or fork events", () => {
  assert.match(text, /workflow_dispatch:/);
  assert.match(text, /tags:\n\s+- "deploy\/\*"/);
  assert.doesNotMatch(text, /pull_request/);
  assert.doesNotMatch(text, /\n {2}schedule:/);
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
test("install and build run without secrets; the allow list is always closed afterwards", () => {
  const prep = deployJob.slice(
    deployJob.indexOf("Install and build"),
    deployJob.indexOf("Deploy, migrate, smoke"),
  );
  assert.match(prep, /render-deploy\.sh prepare/);
  assert.doesNotMatch(prep, /secrets\./);
  assert.match(deployJob, /if: always\(\)[\s\S]*restore-allowlist/);
  assert.match(deployJob, /github\.ref == 'refs\/heads\/main'/);
});
test("the job validates first, refuses refs off main and runs the shared script", () => {
  assert.match(validateJob, /merge-base --is-ancestor/);
  assert.match(validateJob, /render-deploy\.sh dry-run/);
  assert.match(deployJob, /needs: validate/);
  assert.match(deployJob, /render-deploy\.sh production/);
});
test("user-controlled inputs reach shell only through env, never interpolated", () => {
  for (const m of text.matchAll(
    /run: \|?([\s\S]*?)(?=\n\s+(?:- |env:|with:|name:)|\n\S|$)/g,
  ))
    assert.doesNotMatch(
      m[1],
      /\$\{\{\s*(inputs|github\.event|github\.head_ref)/,
    );
});
