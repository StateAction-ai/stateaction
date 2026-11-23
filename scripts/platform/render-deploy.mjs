#!/usr/bin/env node
// Render deployment driver (SA-41). Used by .github/workflows/deploy.yml and by an operator.
// render.yaml is the source of truth for topology, plans and env-var NAMES; this script
// applies it through the Render REST API (the Blueprint "apply" itself is dashboard-only)
// and the Render CLI (workflow services). Secrets are read from the process environment,
// sent only to the Render API, and never printed, logged or written outside 0600 temp files.
//
// Commands:  estimate | check | provision | configure | migrate | deploy | smoke | rollback
// Common:    --environment production|dev   --ref <40-hex sha>   --state <json file>
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const API = "https://api.render.com/v1";
const SECRET_NAME =
  /(SECRET|PASSWORD|TOKEN|_KEY|ACCESS_KEY|DATABASE_URL|CONNECTION|CREDENTIAL)/;
// Values learned at run time (owner password, URLs, issued tokens) join the environment secrets.
const extraSecrets = [];
const learn = (...values) => {
  for (const v of values)
    if (v) extraSecrets.push(String(v), encodeURIComponent(String(v)));
};
const currentSecrets = () => [
  ...Object.entries(process.env)
    .filter(([k]) => SECRET_NAME.test(k))
    .map(([, v]) => v),
  ...extraSecrets,
];

export const loadConfig = () =>
  JSON.parse(readFileSync(join(root, "config/render-deploy.json"), "utf8"));

/** Minimal render.yaml reader: services with plan/runtime and env keys (value, sync:false, ...). */
export function parseBlueprint(text) {
  const out = { databases: [], services: [] };
  let section = null;
  let item = null;
  let env = null;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s+#.*$/, "");
    if (/^databases:/.test(line)) section = "databases";
    else if (/^services:/.test(line)) section = "services";
    else if (/^ {2}- /.test(line) && section) {
      item = {};
      env = null;
      out[section].push(item);
      const m = line.match(/^ {2}- (\w+): (.*)$/);
      if (m) item[m[1]] = m[2].replace(/^"|"$/g, "");
    } else if (item && /^ {4}envVars:/.test(line)) item.envVars = env = [];
    else if (item && env && /^ {6}- key: /.test(line))
      env.push({ key: line.split("key: ")[1].trim() });
    else if (item && env && /^ {8}\w+:/.test(line)) {
      const m = line.match(/^ {8}(\w+): ?(.*)$/);
      if (m) env.at(-1)[m[1]] = m[2].replace(/^"|"$/g, "");
    } else if (item && /^ {4}\w+:/.test(line)) {
      const m = line.match(/^ {4}(\w+): ?(.*)$/);
      if (m) {
        env = m[1] === "envVars" ? env : null;
        item[m[1]] = m[2].replace(/^"|"$/g, "");
      }
    }
  }
  return out;
}

/** Worst-case monthly USD per resource from the recorded pricing; throws above the cap. */
export function estimate(config, blueprint) {
  const c = config.costModel;
  const plans = Object.fromEntries(
    [...blueprint.databases, ...blueprint.services].map((r) => [
      r.name,
      r.plan,
    ]),
  );
  const expect = {
    "stateaction-db": c.postgres.plan,
    "stateaction-web": c.web.plan,
    "stateaction-repair": c.cron.plan,
  };
  for (const [name, plan] of Object.entries(expect))
    if (plans[name] !== plan)
      throw new Error(`plan drift: ${name} is ${plans[name]}, priced ${plan}`);
  const known = new Set([
    "stateaction-db",
    "stateaction-web",
    "stateaction-repair",
    "stateaction-workflow",
  ]);
  for (const r of [...blueprint.databases, ...blueprint.services]) {
    if (!known.has(r.name))
      throw new Error(`unpriced resource ${r.name} in render.yaml`);
    if (r.disk || r.numInstances || r.scaling)
      throw new Error(`${r.name}: disks, replicas and scaling are not priced`);
  }
  const wf = blueprint.services.find((s) => s.type === "workflow");
  if (!wf || wf.plan) throw new Error("workflow must not pin a paid plan");
  const rows = [
    [
      "stateaction-db",
      c.postgres.monthlyUsd + c.postgres.diskGb * c.postgres.diskUsdPerGb,
    ],
    ["stateaction-web", c.web.monthlyUsd],
    [
      "stateaction-repair",
      Math.min(c.cron.ceilingUsd, c.cron.usdPerMinute * c.cron.minutesPerMonth),
    ],
    [
      "stateaction-workflow",
      c.workflow.allowanceTaskHours *
        (c.workflow.allowanceCpu * c.workflow.usdPerCpuHour +
          c.workflow.allowanceGb * c.workflow.usdPerGbHour),
    ],
  ].map(([name, usd]) => [name, Math.round(usd * 100) / 100]);
  const total = Math.round(rows.reduce((s, [, u]) => s + u, 0) * 100) / 100;
  if (total > config.monthlySpendCapUsd)
    throw new Error(
      `worst-case ${total} USD exceeds the ${config.monthlySpendCapUsd} USD cap`,
    );
  return { rows, total, cap: config.monthlySpendCapUsd };
}

export const imageSpecSha = () =>
  createHash("sha256")
    .update(readFileSync(join(root, loadConfig().pins.imageSpecSource)))
    .digest("hex");

/**
 * Env var values per service. Returns { set: {KEY: value}, missingRequired: [KEY] }.
 * Only keys that render.yaml declares for that service are ever produced.
 */
export function serviceEnv(kind, ctx) {
  const { env, pins, ref, webUrl, workflowSlug } = ctx;
  const fromEnv = (names) =>
    Object.fromEntries(names.filter((n) => env[n]).map((n) => [n, env[n]]));
  if (kind === "web") {
    const set = {
      ...fromEnv([
        "APP_DB_PASSWORD",
        "S3_ENDPOINT",
        "S3_BUCKET",
        "S3_ACCESS_KEY_ID",
        "S3_SECRET_ACCESS_KEY",
        "GOOGLE_CLIENT_ID",
        "GOOGLE_CLIENT_SECRET",
      ]),
      PROCESSING_PROFILE_REVISION: pins.processingProfileRevision,
      PROCESSING_EXECUTION_BACKEND: pins.processingExecutionBackend,
      PROCESSING_CODE_REVISION: ref,
      PROCESSING_IMAGE_SPEC_SHA256: ctx.imageSpec,
      PROCESSING_CONFIG_SHA256: pins.configSha256,
      BETTER_AUTH_URL: webUrl,
    };
    // Render dispatch credential: a DEDICATED key only; the deploy key never reaches the web service.
    if (
      env.RENDER_DISPATCH_API_KEY &&
      env.RENDER_DISPATCH_API_KEY === env.RENDER_API_KEY
    )
      throw new Error(
        "RENDER_DISPATCH_API_KEY must differ from the deploy key",
      );
    if (env.RENDER_DISPATCH_API_KEY && workflowSlug) {
      set.RENDER_API_KEY = env.RENDER_DISPATCH_API_KEY;
      set.PROCESS_RECORDING_TASK_SLUG = `${workflowSlug}/process-recording`;
    }
    const required = [
      "APP_DB_PASSWORD",
      "S3_ENDPOINT",
      "S3_BUCKET",
      "S3_ACCESS_KEY_ID",
      "S3_SECRET_ACCESS_KEY",
    ];
    if (set.GOOGLE_CLIENT_ID && !set.GOOGLE_CLIENT_SECRET)
      throw new Error("GOOGLE_CLIENT_ID needs GOOGLE_CLIENT_SECRET");
    return { set, missingRequired: required.filter((k) => !set[k]) };
  }
  if (kind === "cron")
    return {
      set: {
        STATEACTION_API_URL: webUrl,
        ...(ctx.tokens?.repair
          ? { REPAIR_CAPABILITY_TOKEN: ctx.tokens.repair }
          : {}),
      },
      missingRequired: [],
    };
  if (kind === "workflow")
    return {
      set: {
        STATEACTION_API_URL: webUrl,
        EXECUTION_BACKEND: "modal",
        ...(ctx.tokens?.controller
          ? { CONTROLLER_CAPABILITY_TOKEN: ctx.tokens.controller }
          : {}),
        ...fromEnv(["MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET"]),
      },
      missingRequired: [],
    };
  throw new Error(`unknown service kind ${kind}`);
}

/** Parses a 0600 KEY=VALUE env file (no expansion, no quotes semantics beyond trimming). */
export function parseEnvFile(text) {
  const out = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, "$2");
  }
  return out;
}

/** Google OAuth values for the web service; both or neither, never empty. */
export function googleOauthEnv(file) {
  const id = file.GOOGLE_CLIENT_ID;
  const secret = file.GOOGLE_CLIENT_SECRET;
  if (!id || !secret)
    throw new Error(
      "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are both required",
    );
  return { GOOGLE_CLIENT_ID: id, GOOGLE_CLIENT_SECRET: secret };
}

export const STAFF_GRANT_SQL = {
  find: `SELECT id FROM "user" WHERE lower(email) = lower($1)`,
  grant: `INSERT INTO access (user_id, role, enabled, granted_by) VALUES ($1, 'staff', true, 'deploy-grant-staff')
          ON CONFLICT (user_id, role) DO UPDATE SET enabled = true, updated_at = now()`,
};

export const validEmail = (e) =>
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 254;

export const redact = (text, values) =>
  values
    .filter((v) => v && String(v).length >= 6)
    .reduce((t, v) => t.split(String(v)).join("[redacted]"), String(text));

// ---------------------------------------------------------------- Render API
function makeClient(fetchImpl = fetch) {
  const key = process.env.RENDER_CREATE_KEY || process.env.RENDER_API_KEY;
  if (!key) throw new Error("RENDER_API_KEY is not set");
  return async (method, path, body) => {
    const res = await fetchImpl(`${API}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${key}`,
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    if (!res.ok)
      throw new Error(
        `${method} ${path.split("?")[0]} -> ${res.status} ${json?.message ?? ""}`.trim(),
      );
    return json;
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const unwrap = (list, key) => (list ?? []).map((x) => x[key] ?? x);

async function findByName(api, kind, name, owner) {
  const path =
    kind === "postgres"
      ? `/postgres?name=${encodeURIComponent(name)}&ownerId=${owner}&limit=20`
      : `/services?name=${encodeURIComponent(name)}&ownerId=${owner}&limit=20`;
  const list = unwrap(
    await api("GET", path),
    kind === "postgres" ? "postgres" : "service",
  );
  return list.find((r) => r.name === name && r.suspended !== "deleted");
}

function cli(args, { input, env = {}, allowFail = false } = {}) {
  const r = spawnSync("render", args, {
    encoding: "utf8",
    input,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      RENDER_API_KEY: process.env.RENDER_API_KEY,
      ...env,
      RENDER_CLI_NO_UPDATE_CHECK: "1",
    },
  });
  if (r.status !== 0 && !allowFail)
    throw new Error(
      `render ${args.slice(0, 3).join(" ")} failed (${r.status}): ${redact(r.stderr || r.stdout, currentSecrets()).slice(0, 400)}`,
    );
  return r;
}

async function setEnv(api, serviceId, set) {
  for (const [key, value] of Object.entries(set))
    await api("PUT", `/services/${serviceId}/env-vars/${key}`, { value });
}

async function waitDeploy(api, serviceId, deployId, timeoutMs = 25 * 60_000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const d = await api("GET", `/services/${serviceId}/deploys/${deployId}`);
    if (d.status === "live") return d;
    if (
      [
        "build_failed",
        "update_failed",
        "canceled",
        "pre_deploy_failed",
        "deactivated",
      ].includes(d.status)
    )
      throw new Error(`deploy ${deployId} ended ${d.status}`);
    if (Date.now() > end)
      throw new Error(`deploy ${deployId} timed out (${d.status})`);
    await sleep(10_000);
  }
}

// ------------------------------------------------------------------ commands
const flag = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 2 ? process.argv[i + 1] : def;
};

function loadState(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}
const saveState = (path, s) => writeFileSync(path, JSON.stringify(s, null, 2));

async function discover(api, config, envName) {
  const stack = config.environments[envName].stack;
  const owner = config.owner.id;
  const db = await findByName(api, "postgres", stack.db, owner);
  const web = await findByName(api, "service", stack.web, owner);
  const cron = await findByName(api, "service", stack.cron, owner);
  const listed = JSON.parse(
    cli(["workflows", "list", "--confirm", "-o", "json"]).stdout || "[]",
  );
  const workflow = listed
    .map((x) => x.workflow ?? x)
    .find((w) => w.name === stack.workflow);
  return { db, web, cron, workflow };
}

async function main() {
  const command = process.argv[2];
  const environment = flag("environment", "production");
  const config = loadConfig();
  const blueprint = parseBlueprint(
    readFileSync(join(root, "render.yaml"), "utf8"),
  );
  if (command === "estimate" || command === "check") {
    const e = estimate(config, blueprint);
    for (const [n, u] of e.rows)
      console.log(`${n.padEnd(22)} ${u.toFixed(2)} USD/month`);
    console.log(
      `worst case total ${e.total.toFixed(2)} USD of ${e.cap} USD cap`,
    );
    if (command === "check" && config.pins.configSha256 === "TO_BE_PINNED")
      throw new Error("config digest pin missing");
    return;
  }
  if (!config.environments[environment]?.stack)
    throw new Error(
      `environment ${environment} has no hosted stack (dry-run only)`,
    );
  const ref = flag("ref", process.env.GITHUB_SHA);
  const statePath = flag(
    "state",
    join(root, "artifacts/render-deploy-state.json"),
  );
  const api = makeClient();
  const stack = config.environments[environment].stack;
  const owner = config.owner.id;
  const found = await discover(api, config, environment);
  const log = (m) => console.log(redact(m, currentSecrets()));

  if (command === "provision") {
    estimate(config, blueprint); // cap check before ANY create
    if (!/^[0-9a-f]{40}$/.test(ref ?? ""))
      throw new Error("--ref must be a 40-hex commit");
    const state = loadState(statePath);
    let { db, web, cron, workflow } = found;
    const bpWeb = blueprint.services.find((s) => s.type === "web");
    const bpCron = blueprint.services.find((s) => s.type === "cron");
    const bpWf = blueprint.services.find((s) => s.type === "workflow");
    if (!db) {
      db = await api("POST", "/postgres", {
        name: stack.db,
        ownerId: owner,
        plan: "basic_256mb",
        version: config.postgresMajor,
        region: config.region,
        diskSizeGB: config.costModel.postgres.diskGb,
        databaseName: "stateaction",
        databaseUser: "stateaction",
        ipAllowList: [],
      });
      log(`created postgres ${db.id}`);
    }
    const common = {
      ownerId: owner,
      repo: config.repo,
      branch: config.branch,
      autoDeploy: "no",
    };
    const literals = (bp) =>
      bp.envVars
        .filter((e) => e.value !== undefined)
        .map((e) => ({ key: e.key, value: e.value }));
    const webUrl = `https://${stack.web}.onrender.com`;
    if (!web) {
      const ctx = {
        env: process.env,
        pins: config.pins,
        ref,
        webUrl,
        imageSpec: imageSpecSha(),
      };
      const { set, missingRequired } = serviceEnv("web", ctx);
      if (missingRequired.length)
        throw new Error(
          `missing required secrets: ${missingRequired.join(",")}`,
        );
      const created = await api("POST", "/services", {
        ...common,
        type: "web_service",
        name: stack.web,
        rootDir: "",
        envVars: [
          ...literals(bpWeb),
          ...Object.entries(set).map(([key, value]) => ({ key, value })),
          { key: "BETTER_AUTH_SECRET", generateValue: true },
        ],
        serviceDetails: {
          runtime: "node",
          plan: bpWeb.plan,
          region: config.region,
          healthCheckPath: bpWeb.healthCheckPath,
          envSpecificDetails: {
            buildCommand: bpWeb.buildCommand,
            startCommand: bpWeb.startCommand,
          },
        },
      });
      web = created.service ?? created;
      log(`created web ${web.id}`);
    }
    if (!cron) {
      const created = await api("POST", "/services", {
        ...common,
        type: "cron_job",
        name: stack.cron,
        envVars: [
          ...literals(bpCron),
          { key: "STATEACTION_API_URL", value: webUrl },
        ],
        serviceDetails: {
          runtime: "node",
          plan: bpCron.plan,
          region: config.region,
          schedule: bpCron.schedule,
          envSpecificDetails: {
            buildCommand: bpCron.buildCommand,
            startCommand: bpCron.startCommand,
          },
        },
      });
      cron = created.service ?? created;
      log(`created cron ${cron.id}`);
    }
    if (!workflow) {
      const dir = mkdtempSync(join(tmpdir(), "wf-env-"));
      const file = join(dir, "env");
      try {
        const lit = literals(bpWf).map((e) => `${e.key}=${e.value}`);
        lit.push(`STATEACTION_API_URL=${webUrl}`, "EXECUTION_BACKEND=modal");
        writeFileSync(file, lit.join("\n") + "\n", { mode: 0o600 });
        chmodSync(file, 0o600);
        const r = cli(
          [
            "workflows",
            "create",
            "--name",
            stack.workflow,
            "--repo",
            config.repo,
            "--branch",
            config.branch,
            "--runtime",
            "node",
            "--region",
            config.region,
            "--build-command",
            bpWf.buildCommand,
            "--run-command",
            bpWf.startCommand,
            "--auto-deploy-trigger",
            "off",
            "--env-file",
            file,
            "--confirm",
            "-o",
            "json",
          ],
          {},
        );
        log(`created workflow (${r.stdout.slice(0, 0)})`);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    const again = await discover(api, config, environment);
    saveState(statePath, {
      db: again.db?.id,
      web: again.web?.id,
      cron: again.cron?.id,
      workflow: again.workflow?.id,
    });
    log(`state ${JSON.stringify(loadState(statePath))}`);
    return;
  }

  const need = (x, what) => {
    if (!x) throw new Error(`${what} is not provisioned (run provision first)`);
    return x;
  };
  const webSvc = need(found.web, "web");
  const cronSvc = need(found.cron, "cron");
  const wfl =
    command === "rollback" ||
    command === "apply-google" ||
    command === "grant-staff" ||
    command === "smoke" ||
    command === "restore-allowlist"
      ? (found.workflow ?? {})
      : need(found.workflow, "workflow");
  const dbRec = need(found.db, "database");
  const webUrl =
    webSvc.serviceDetails?.url ?? `https://${stack.web}.onrender.com`;
  const baseCtx = () => ({
    env: process.env,
    pins: config.pins,
    ref,
    webUrl,
    imageSpec: imageSpecSha(),
    workflowSlug: wfl.slug ?? stack.workflow,
  });

  if (command === "configure") {
    const conn = await api("GET", `/postgres/${dbRec.id}/connection-info`);
    const u = new URL(conn.internalConnectionString);
    const dbEnv = {
      DATABASE_HOST: u.hostname,
      DATABASE_PORT: u.port || "5432",
      DATABASE_NAME: u.pathname.slice(1),
    };
    const w = serviceEnv("web", baseCtx());
    if (w.missingRequired.length)
      throw new Error(
        `missing required secrets: ${w.missingRequired.join(",")}`,
      );
    delete w.set.PROCESSING_CODE_REVISION; // set together with the deploy
    await setEnv(api, webSvc.id, { ...dbEnv, ...w.set });
    await setEnv(api, cronSvc.id, serviceEnv("cron", baseCtx()).set);
    await setEnv(api, wfl.id, serviceEnv("workflow", baseCtx()).set);
    log("environment variables set (names only: web, cron, workflow)");
    return;
  }

  if (command === "migrate") {
    // Owner path: temporary /32 allow-list entry for this machine, always removed.
    const conn = await api("GET", `/postgres/${dbRec.id}/connection-info`);
    const ip = (await (await fetch("https://api.ipify.org")).text()).trim();
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip))
      throw new Error("could not determine the egress IP");
    const child = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      APP_ENV: "production",
      MIGRATION_DATABASE_URL: conn.externalConnectionString.includes("sslmode=")
        ? conn.externalConnectionString
        : `${conn.externalConnectionString}${conn.externalConnectionString.includes("?") ? "&" : "?"}sslmode=require`,
      APP_DB_PASSWORD: process.env.APP_DB_PASSWORD,
    };
    learn(
      conn.password,
      conn.externalConnectionString,
      conn.internalConnectionString,
      child.MIGRATION_DATABASE_URL,
    );
    const tokens = {};
    const dir = mkdtempSync(join(tmpdir(), "cap-"));
    const restore = async () => {
      let last;
      for (let i = 0; i < 4; i++) {
        try {
          await api("PATCH", `/postgres/${dbRec.id}`, { ipAllowList: [] });
          const now = await api("GET", `/postgres/${dbRec.id}`);
          if ((now.ipAllowList ?? []).length === 0) return;
          last = new Error("allow list not empty after restore");
        } catch (e) {
          last = e;
        }
        await sleep(3_000);
      }
      throw new Error(
        `could not restore the database allow list: ${last.message}`,
      );
    };
    const onSignal = (sig) => () => {
      restore().finally(() => process.exit(128 + sig));
    };
    process.once("SIGTERM", onSignal(15));
    process.once("SIGINT", onSignal(2));
    let failure;
    try {
      await api("PATCH", `/postgres/${dbRec.id}`, {
        ipAllowList: [
          {
            cidrBlock: `${ip}/32`,
            description: "deploy migration (temporary)",
          },
        ],
      });
      await sleep(15_000);
      const run = (args, retries = 0) => {
        const r = spawnSync("node", ["packages/server/dist/cli.js", ...args], {
          cwd: root,
          encoding: "utf8",
          env: child,
        });
        if (r.status !== 0 && retries > 0) {
          spawnSync("sleep", ["10"]);
          return run(args, retries - 1);
        }
        if (r.status !== 0)
          throw new Error(
            `server cli ${args[0]} failed: ${redact(r.stderr || r.stdout, [
              ...Object.values(child),
              conn.password,
            ])
              .split("\n")
              .filter((l) => /Error|FATAL|message/.test(l))
              .join(" | ")
              .slice(0, 400)}`,
          );
        return r.stdout.trim();
      };
      log(run(["migrate"], 3));
      for (const [kind, scopes, name] of [
        ["workflow", "jobs:status,jobs:reconcile", "controller"],
        ["cron", "jobs:repair", "repair"],
      ]) {
        const out = join(dir, name);
        log(
          run([
            "issue-service-capability",
            "--kind",
            kind,
            "--scopes",
            scopes,
            "--label",
            `deploy-${ref?.slice(0, 7) ?? "manual"}`,
            "--out",
            out,
            "--ttl-hours",
            "24",
          ]),
        );
        tokens[name] = readFileSync(out, "utf8").trim();
        learn(tokens[name]);
      }
      await setEnv(
        api,
        wfl.id,
        serviceEnv("workflow", { ...baseCtx(), tokens }).set,
      );
      await setEnv(
        api,
        cronSvc.id,
        serviceEnv("cron", { ...baseCtx(), tokens }).set,
      );
      log("service capabilities issued (24 h) and set on workflow and cron");
    } catch (e) {
      failure = e;
    }
    rmSync(dir, { recursive: true, force: true });
    try {
      await restore();
      log("database allow list restored to empty (verified)");
    } catch (e) {
      throw new Error(`${failure ? `${failure.message}; ` : ""}${e.message}`);
    }
    if (failure) throw failure;
    return;
  }

  if (command === "restore-allowlist") {
    await api("PATCH", `/postgres/${dbRec.id}`, { ipAllowList: [] });
    const now = await api("GET", `/postgres/${dbRec.id}`);
    if ((now.ipAllowList ?? []).length) throw new Error("allow list not empty");
    log("database allow list is empty");
    return;
  }

  if (command === "deploy") {
    if (!/^[0-9a-f]{40}$/.test(ref ?? ""))
      throw new Error("--ref must be a 40-hex commit");
    const state = loadState(statePath);
    state.deploys = {};
    saveState(statePath, state);
    const failures = [];
    const revKey = "PROCESSING_CODE_REVISION";
    // The recorded code revision changes together with the deploy (and is restored on rollback).
    const prevRev = await api(
      "GET",
      `/services/${webSvc.id}/env-vars/${revKey}`,
    ).catch(() => undefined);
    state.previousCodeRevision = prevRev?.value;
    saveState(statePath, state);
    await setEnv(api, webSvc.id, { [revKey]: ref });
    for (const [label, svc] of [
      ["web", webSvc],
      ["cron", cronSvc],
    ]) {
      // A suspended cron cannot deploy: resume first (it is paused again below when needed).
      if (label === "cron")
        await api("POST", `/services/${svc.id}/resume`).catch(() => {}); // already running
      const prev = (await api("GET", `/services/${svc.id}/deploys?limit=10`))
        .map((x) => x.deploy)
        .find((d) => d.status === "live");
      state.deploys[label] = { previous: prev?.id };
      saveState(statePath, state);
      // Cron jobs cannot deploy by commit id: they build the branch tip, which must equal --ref.
      const d = await api(
        "POST",
        `/services/${svc.id}/deploys`,
        label === "cron" ? {} : { commitId: ref },
      );
      let id = d?.id ?? d?.deploy?.id;
      if (!id) {
        await sleep(5_000); // empty 202: take the newest deploy
        id = (await api("GET", `/services/${svc.id}/deploys?limit=1`))[0]
          ?.deploy?.id;
      }
      if (!id) throw new Error(`${label}: no deploy was created`);
      log(`${label}: deploy ${id} started at ${ref.slice(0, 7)}`);
      try {
        const done = await waitDeploy(api, svc.id, id);
        state.deploys[label].current = done.id;
        saveState(statePath, state);
        if (done.commit?.id !== ref)
          throw new Error(
            `${label} built ${String(done.commit?.id).slice(0, 7)}, not ${ref.slice(0, 7)} (branch tip moved)`,
          );
        log(`${label}: deploy ${done.id} live`);
      } catch (e) {
        failures.push(`${label}: ${e.message}`);
        break; // later services and the workflow release are not started after a failure
      }
    }
    if (!failures.length) {
      const rel = cli(
        [
          "workflows",
          "versions",
          "release",
          wfl.id,
          "--commit",
          ref,
          "--wait",
          "--confirm",
          "-o",
          "json",
        ],
        { allowFail: true },
      );
      if (rel.status !== 0)
        failures.push(
          `workflow release: ${redact(rel.stderr || rel.stdout, currentSecrets()).slice(0, 300)}`,
        );
      else log("workflow version released");
    }
    // Repair is paused (billing and noise) until a dispatch credential exists.
    const wantCron = Boolean(process.env.RENDER_DISPATCH_API_KEY);
    await api(
      "POST",
      `/services/${cronSvc.id}/${wantCron ? "resume" : "suspend"}`,
    );
    log(
      `cron ${wantCron ? "resumed" : "suspended (no dispatch key configured)"}`,
    );
    saveState(statePath, state);
    if (failures.length) throw new Error(failures.join("; "));
    return;
  }

  if (command === "rollback") {
    const state = loadState(statePath);
    // Render does not support rollback of cron jobs; the cron holds no state and is paused without a dispatch key.
    for (const [label, svc] of [["web", webSvc]]) {
      const prev = state.deploys?.[label]?.previous;
      if (!prev) {
        log(`${label}: no previous live deploy recorded`);
        continue;
      }
      await api("POST", `/services/${svc.id}/rollback`, { deployId: prev });
      log(`${label}: rollback to ${prev} requested`);
    }
    if (state.previousCodeRevision) {
      await setEnv(api, webSvc.id, {
        PROCESSING_CODE_REVISION: state.previousCodeRevision,
      });
      log("web: recorded code revision restored");
    }
    return;
  }

  if (command === "apply-google") {
    const file = parseEnvFile(readFileSync(flag("env-file"), "utf8"));
    const g = googleOauthEnv(file);
    learn(g.GOOGLE_CLIENT_SECRET, g.GOOGLE_CLIENT_ID);
    await setEnv(api, webSvc.id, g);
    log("GOOGLE_CLIENT_ID/SECRET set on the web service; redirecting a deploy");
    const d = await api("POST", `/services/${webSvc.id}/deploys`, {});
    const id = d?.id ?? d?.deploy?.id;
    if (id) await waitDeploy(api, webSvc.id, id);
    log(
      `web redeployed with Google sign-in (redirect URI ${webUrl}/api/auth/callback/google)`,
    );
    return;
  }

  if (command === "grant-staff") {
    const email = flag("email");
    if (!email || !validEmail(email))
      throw new Error("--email <address> required");
    const conn = await api("GET", `/postgres/${dbRec.id}/connection-info`);
    learn(conn.password, conn.externalConnectionString);
    const ip = (await (await fetch("https://api.ipify.org")).text()).trim();
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip))
      throw new Error("could not determine the egress IP");
    const { createRequire } = await import("node:module");
    const pg = createRequire(join(root, "packages/server/package.json"))("pg");
    let failure;
    try {
      await api("PATCH", `/postgres/${dbRec.id}`, {
        ipAllowList: [
          { cidrBlock: `${ip}/32`, description: "grant staff (temporary)" },
        ],
      });
      await sleep(15_000);
      const url = conn.externalConnectionString.includes("sslmode=")
        ? conn.externalConnectionString
        : `${conn.externalConnectionString}${conn.externalConnectionString.includes("?") ? "&" : "?"}sslmode=require`;
      const pool = new pg.Pool({ connectionString: url, max: 1 });
      try {
        const found = await pool.query(STAFF_GRANT_SQL.find, [email]);
        if (found.rowCount !== 1)
          throw new Error(
            "no such user yet: sign in with Google once (it shows Access pending), then rerun",
          );
        await pool.query(STAFF_GRANT_SQL.grant, [found.rows[0].id]);
        log("staff role granted (enabled)");
      } finally {
        await pool.end();
      }
    } catch (e) {
      failure = e;
    }
    await api("PATCH", `/postgres/${dbRec.id}`, { ipAllowList: [] });
    const now = await api("GET", `/postgres/${dbRec.id}`);
    if ((now.ipAllowList ?? []).length)
      throw new Error("allow list not empty after grant");
    log("database allow list restored to empty (verified)");
    if (failure) throw failure;
    return;
  }

  if (command === "smoke") {
    const get = async (path, init) => {
      const r = await fetch(`${webUrl}${path}`, {
        ...init,
        redirect: "manual",
        signal: AbortSignal.timeout(30_000),
      });
      return { status: r.status, text: await r.text() };
    };
    const until = async (fn, ms) => {
      const end = Date.now() + ms;
      for (;;) {
        try {
          const v = await fn();
          if (v) return v;
        } catch {}
        if (Date.now() > end) return undefined;
        await sleep(5_000);
      }
    };
    const live = await until(
      async () => (await get("/api/v1/live")).status === 200,
      300_000,
    );
    if (!live) throw new Error("smoke: /api/v1/live not 200");
    log(`smoke: ${webUrl}/api/v1/live 200`);
    const health = await until(async () => {
      const r = await get("/api/v1/health");
      return r.status === 200 && /"status":\s*"ok"/.test(r.text)
        ? r.text
        : undefined;
    }, 120_000);
    if (!health) throw new Error("smoke: /api/v1/health not ok");
    log(`smoke: /api/v1/health 200 ${health.slice(0, 300)}`);
    const http = await fetch(
      webUrl.replace("https://", "http://") + "/api/v1/live",
      { redirect: "manual" },
    );
    if (![301, 302, 307, 308].includes(http.status))
      throw new Error(`smoke: http did not redirect (${http.status})`);
    log(`smoke: http redirects to https (${http.status})`);
    const dispatch = await get("/api/v1/development/workflows/verify", {
      method: "POST",
    });
    if (dispatch.status !== 404)
      throw new Error(
        `smoke: development dispatch route reachable (${dispatch.status})`,
      );
    log("smoke: development dispatch route is 404 in production");
    const internal = await get("/internal/v1/jobs/reconcile", {
      method: "POST",
    });
    const dispatchConfigured = Boolean(process.env.RENDER_DISPATCH_API_KEY);
    const anonymousRefused =
      [401, 403].includes(internal.status) ||
      (!dispatchConfigured &&
        internal.status === 503 &&
        /provider_unavailable/.test(internal.text));
    if (!anonymousRefused)
      throw new Error(
        `smoke: internal route without credential is ${internal.status}`,
      );
    log(
      `smoke: internal route refuses anonymous (${internal.status}${dispatchConfigured ? "" : ", fail-closed: dispatch key not configured"})`,
    );
    for (const [name, cmd, marker] of [
      [
        "storage-check",
        "pnpm --filter @stateaction/server hosted:storage-check",
        /S3 Put\/Get verified/,
      ],
      [
        "presign-check",
        "pnpm --filter @stateaction/server hosted:presign-check",
        /presigned PUT\/GET verified/,
      ],
    ]) {
      const job = await api("POST", `/services/${webSvc.id}/jobs`, {
        startCommand: cmd,
      });
      const end = Date.now() + 600_000;
      let st;
      for (;;) {
        st = await api("GET", `/services/${webSvc.id}/jobs/${job.id}`);
        if (
          st.status === "succeeded" ||
          st.status === "failed" ||
          st.status === "canceled"
        )
          break;
        if (Date.now() > end) throw new Error(`smoke: job ${name} timed out`);
        await sleep(5_000);
      }
      if (st.status !== "succeeded")
        throw new Error(`smoke: job ${name} ${st.status}`);
      log(
        `smoke: R2 ${name} job ${job.id} succeeded from the deployed web service (expects ${marker})`,
      );
    }
    return;
  }
  throw new Error(`unknown or unimplemented command ${command}`);
}

export {
  setEnv,
  waitDeploy,
  findByName,
  cli,
  discover,
  makeClient,
  loadState,
  saveState,
  randomBytes,
};
if (process.argv[1] === fileURLToPath(import.meta.url))
  main().catch((e) => {
    console.error(`render-deploy: ${redact(e.message, currentSecrets())}`);
    process.exit(1);
  });
