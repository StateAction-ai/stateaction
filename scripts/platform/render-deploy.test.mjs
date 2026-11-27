import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  STAFF_GRANT_SQL,
  extractLiveRefs,
  googleOauthEnv,
  parseEnvFile,
  planDeployActions,
  validEmail,
  estimate,
  loadConfig,
  parseBlueprint,
  redact,
  serviceEnv,
} from "./render-deploy.mjs";

const blueprint = () =>
  parseBlueprint(
    readFileSync(new URL("../../render.yaml", import.meta.url), "utf8"),
  );
const pins = loadConfig().pins;
const ctx = (extra = {}) => ({
  env: {},
  pins,
  ref: "a".repeat(40),
  webUrl: "https://stateaction-web.onrender.com",
  imageSpec: "b".repeat(64),
  workflowSlug: "stateaction-workflow",
  ...extra,
});
const keysOf = (name) =>
  new Set(
    blueprint()
      .services.find((s) => s.type === name)
      .envVars.map((e) => e.key),
  );

test("worst-case monthly estimate stays under the recorded cap and matches the Blueprint plans", () => {
  const e = estimate(loadConfig(), blueprint());
  assert.ok(e.total <= 30);
  assert.equal(e.total, 25.21);
});

test("a plan change in render.yaml is refused until it is repriced", () => {
  const b = blueprint();
  b.services.find((s) => s.type === "web").plan = "standard";
  assert.throws(() => estimate(loadConfig(), b), /plan drift/);
});

test("exceeding the cap throws before any create", () => {
  const c = loadConfig();
  c.monthlySpendCapUsd = 20;
  assert.throws(() => estimate(c, blueprint()), /exceeds/);
});

test("each service only ever receives keys that render.yaml declares for it", () => {
  const all = {
    APP_DB_PASSWORD: "p".repeat(20),
    S3_ENDPOINT: "https://x",
    S3_BUCKET: "stateaction-prod",
    S3_ACCESS_KEY_ID: "k",
    S3_SECRET_ACCESS_KEY: "s",
    RENDER_DISPATCH_API_KEY: "d",
    MODAL_TOKEN_ID: "m",
    MODAL_TOKEN_SECRET: "n",
    RENDER_API_KEY: "deploy-key",
    GOOGLE_CLIENT_ID: "g",
    GOOGLE_CLIENT_SECRET: "h",
  };
  const tokens = { controller: "c", repair: "r" };
  for (const kind of ["web", "cron", "workflow"]) {
    const { set } = serviceEnv(kind, ctx({ env: all, tokens }));
    for (const key of Object.keys(set))
      assert.ok(keysOf(kind).has(key), `${key} is not declared for ${kind}`);
  }
});

test("the deploy key never reaches the web service; a dedicated dispatch key does", () => {
  const web = serviceEnv(
    "web",
    ctx({ env: { RENDER_API_KEY: "deploy-key-secret" } }),
  ).set;
  assert.equal(web.RENDER_API_KEY, undefined);
  assert.equal(web.PROCESS_RECORDING_TASK_SLUG, undefined);
  const withKey = serviceEnv(
    "web",
    ctx({ env: { RENDER_DISPATCH_API_KEY: "dispatch-key" } }),
  ).set;
  assert.equal(withKey.RENDER_API_KEY, "dispatch-key");
  assert.equal(
    withKey.PROCESS_RECORDING_TASK_SLUG,
    "stateaction-workflow/process-recording",
  );
});

test("storage and database secrets exist only on web; modal only on the workflow", () => {
  const env = {
    APP_DB_PASSWORD: "x",
    S3_BUCKET: "b",
    MODAL_TOKEN_ID: "i",
    MODAL_TOKEN_SECRET: "s",
  };
  for (const kind of ["cron", "workflow"]) {
    const { set } = serviceEnv(kind, ctx({ env }));
    assert.ok(!Object.keys(set).some((k) => /^(S3_|APP_DB|DATABASE)/.test(k)));
  }
  assert.ok(
    !Object.keys(serviceEnv("web", ctx({ env })).set).some((k) =>
      k.startsWith("MODAL_"),
    ),
  );
  assert.equal(serviceEnv("workflow", ctx({ env })).set.MODAL_TOKEN_ID, "i");
  assert.equal(serviceEnv("workflow", ctx()).set.EXECUTION_BACKEND, "modal");
});

test("missing required web secrets are reported by name, never silently defaulted", () => {
  assert.deepEqual(serviceEnv("web", ctx()).missingRequired.sort(), [
    "APP_DB_PASSWORD",
    "S3_ACCESS_KEY_ID",
    "S3_BUCKET",
    "S3_ENDPOINT",
    "S3_SECRET_ACCESS_KEY",
  ]);
  assert.throws(
    () => serviceEnv("web", ctx({ env: { GOOGLE_CLIENT_ID: "only-id" } })),
    /GOOGLE_CLIENT_SECRET/,
  );
});

test("the dispatch key may not equal the deploy key", () => {
  assert.throws(
    () =>
      serviceEnv(
        "web",
        ctx({
          env: {
            RENDER_API_KEY: "same-key-value",
            RENDER_DISPATCH_API_KEY: "same-key-value",
          },
        }),
      ),
    /must differ/,
  );
});

test("unpriced resources, disks and replicas in render.yaml are refused", () => {
  const b = blueprint();
  b.services.push({ type: "web", name: "extra-api", plan: "starter" });
  assert.throws(() => estimate(loadConfig(), b), /unpriced/);
  const c = blueprint();
  c.services.find((x) => x.type === "web").numInstances = "2";
  assert.throws(() => estimate(loadConfig(), c), /not priced/);
});

test("redaction removes every secret value from text", () => {
  assert.equal(
    redact("a SECRETVALUE b SECRETVALUE", ["SECRETVALUE"]),
    "a [redacted] b [redacted]",
  );
});

test("the pinned config digest is set", () => {
  assert.match(pins.configSha256, /^[0-9a-f]{64}$/);
});

test("google env file parsing needs both values and never defaults", () => {
  const f = parseEnvFile(
    "# c\nexport GOOGLE_CLIENT_ID='abc.apps'\nGOOGLE_CLIENT_SECRET=s3cr3t\n",
  );
  assert.deepEqual(googleOauthEnv(f), {
    GOOGLE_CLIENT_ID: "abc.apps",
    GOOGLE_CLIENT_SECRET: "s3cr3t",
  });
  assert.throws(
    () => googleOauthEnv({ GOOGLE_CLIENT_ID: "x" }),
    /both required/,
  );
  assert.throws(() => googleOauthEnv({}), /both required/);
});

test("the staff grant is parameterized, idempotent and only touches the staff role", () => {
  assert.match(STAFF_GRANT_SQL.find, /\$1/);
  assert.match(STAFF_GRANT_SQL.grant, /VALUES \(\$1, 'staff', true/);
  assert.match(STAFF_GRANT_SQL.grant, /ON CONFLICT \(user_id, role\)/);
  assert.ok(validEmail("a.b@example.com"));
  for (const bad of ["", "no-at", "a b@c.d", "x'; drop table access;--@e.f g"])
    assert.ok(!validEmail(bad), bad);
});

test("extractLiveRefs picks the newest live/ready SHA per service and tolerates wrapped shapes or malformed refs", () => {
  const webSha = "a".repeat(40);
  const cronSha = "b".repeat(40);
  const wfOldSha = "c".repeat(40);
  const wfNewSha = "f".repeat(40);
  assert.deepEqual(
    extractLiveRefs({
      webDeploys: [
        { deploy: { status: "build_failed", commit: { id: "d".repeat(40) } } },
        { deploy: { status: "live", commit: { id: webSha } } },
      ],
      cronDeploys: { deploys: [{ status: "live", commit: { id: cronSha } }] },
      workflowVersions: {
        versions: [
          {
            version: {
              status: "ready",
              commitId: wfOldSha,
              updatedAt: "2026-11-26T00:00:00Z",
            },
          },
          { version: { status: "building", commitId: "e".repeat(40) } },
          {
            version: {
              status: "ready",
              commitId: wfNewSha,
              updatedAt: "2026-11-27T00:00:00Z",
            },
          },
        ],
      },
    }),
    { web: webSha, cron: cronSha, workflow: wfNewSha },
  );
  assert.deepEqual(
    extractLiveRefs({
      webDeploys: [{ deploy: { status: "live", commit: { id: "short" } } }],
      cronDeploys: null,
      workflowVersions: [{ status: "failed", commitId: wfOldSha }],
    }),
    { web: null, cron: null, workflow: null },
  );
});

test("planDeployActions isolates component deploys without mutating PROCESSING_CODE_REVISION or active cron state", () => {
  const webOnly = planDeployActions({
    componentsArg: "web",
    cronSuspended: true,
    hasDispatchKey: false,
  });
  assert.deepEqual(webOnly, {
    legacyMode: false,
    services: ["web"],
    deployWeb: true,
    deployCron: false,
    deployWorkflow: false,
    shouldUpdateCodeRevision: false,
    cronPostState: "unchanged",
  });

  const cronPaused = planDeployActions({
    componentsArg: "cron,workflow",
    cronSuspended: true,
    hasDispatchKey: true,
  });
  assert.equal(cronPaused.deployWeb, false);
  assert.equal(cronPaused.deployCron, true);
  assert.equal(cronPaused.deployWorkflow, true);
  assert.equal(cronPaused.cronPostState, "suspend");

  // Active cron stays unchanged (no redundant /resume call).
  const cronRunning = planDeployActions({
    componentsArg: "cron",
    cronSuspended: false,
    hasDispatchKey: false,
  });
  assert.equal(cronRunning.cronPostState, "unchanged");

  const legacy = planDeployActions({
    hasDispatchKey: false,
  });
  assert.equal(legacy.legacyMode, true);
  assert.deepEqual(legacy.services, ["web", "cron", "workflow"]);
  assert.equal(legacy.shouldUpdateCodeRevision, true);
  assert.equal(legacy.cronPostState, "suspend");

  assert.throws(
    () => planDeployActions({ componentsArg: "auto" }),
    /explicit component names/,
  );
});
