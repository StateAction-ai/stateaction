// SA-96 real-browser evidence driver for the Pipeline pages on the SEEDED stack. Run inside ONE
// resource-guarded job, e.g. `agent-resource run -- node test-e2e/pipeline-seeded-browser.mjs`
// (needs the built web and jobs apps, the processing venv and the Render CLI; see
// serve-console.mjs). Seeds only ok, caption_failed and segment_failed (STATEACTION_SEED_ONLY
// overrides), signs in as staff, checks /pipeline and each /pipeline/<recordingId> at desktop and
// 390 px, clicks the per-stage diagnostics links, checks a customer is denied from the
// diagnostics route, then writes screenshots and a JSON receipt to SHOTS_DIR. Always closes the
// browser session, stops the job runner and the stack (exact pids only). Zero model spend.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startStack } from "./harness.mjs";

process.env.STATEACTION_SEED_ONLY ??= "ok,caption_failed,segment_failed";
const guards = await import("./seed-scenarios.mjs");
guards.refuseNonLocalEnv(process.env);
for (const sc of Object.values({
  ...guards.SYNTHETIC_SCENARIOS,
  ...guards.REPLAY_SCENARIOS,
}))
  guards.refuseSpend(sc.recipe);
const seedMod = await import("./seed-annotations.mjs");
seedMod.seedOnly(process.env.STATEACTION_SEED_ONLY); // validate before starting anything

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const shots =
  process.env.SHOTS_DIR ?? "/home/wearaway/flora-work/handoff/SA-96-shots";
mkdirSync(shots, { recursive: true });
const python =
  process.env.PYTHON_EXECUTABLE ??
  join(repoRoot, "workers/processing/.venv/bin/python");
const session = `sa96-${process.pid}`;
const ab = (...args) =>
  execFileSync("agent-browser", ["--session", session, ...args], {
    encoding: "utf8",
    timeout: 60000,
  }).trim();
const ev = (expr) => JSON.parse(ab("eval", expr));
const where = () => ev("location.pathname + location.search");
const text = () => ev("document.body.innerText");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (pred, tries = 40) => {
  for (let i = 0; i < tries; i++) {
    if (await pred()) return true;
    await sleep(300);
  }
  return false;
};
const checks = [];
const check = (name, ok, detail = "") => {
  checks.push({ name, ok: Boolean(ok), detail: String(detail).slice(0, 300) });
  console.log(
    `${ok ? "PASS" : "FAIL"} ${name} ${String(detail).slice(0, 160)}`,
  );
};
const loginAs = async (stack, label) => {
  ab("cookies", "clear");
  ab("open", `${stack.origin}/login`);
  ab("wait", "input[name=email]");
  for (let attempt = 0; attempt < 4; attempt++) {
    await sleep(1500);
    ab("fill", "input[name=email]", stack.users[label].email);
    ab("fill", "input[name=password]", stack.password);
    ab("click", "button[type=submit]");
    for (let i = 0; i < 20; i++) {
      await sleep(500);
      if (!where().startsWith("/login")) return;
    }
  }
  throw new Error(`could not sign in as ${label}`);
};

const STAGES = ["segment", "caption", "hand_pose"];
const MODULE = {
  segment: "stub_segmenter",
  caption: "stub_captioner",
  hand_pose: "hand_pose_cpu_v1",
};
const EXPECT = {
  ok: { segment: "succeeded", caption: "succeeded", hand_pose: "succeeded" },
  caption_failed: {
    segment: "succeeded",
    caption: "succeeded",
    hand_pose: "succeeded",
  },
  segment_failed: {
    segment: "failed",
    caption: "not_run",
    hand_pose: "succeeded",
  },
};
const dumpStages = () =>
  ev(`[...document.querySelectorAll('[data-testid=recipe-stages] > li')].map(li => ({
    stage: li.dataset.stage, state: li.dataset.state, text: li.innerText,
    receipt: li.querySelector('[data-testid=receipt-sha]')?.getAttribute('title') ?? null,
    diag: [...li.querySelectorAll('[data-testid=diagnostic-link]')].map(b => b.innerText.trim()),
  }))`);

const stackEnv = seedMod.jobsEnv(python);
const dirs = seedMod.newSeedDirs();
let stack;
let stopRunner = () => {};
let htmlSecrets = [];
const receipt = { seedOnly: process.env.STATEACTION_SEED_ONLY, recordings: {} };
try {
  stack = await startStack({
    storage: true,
    extraEnv: { ...stackEnv, STATEACTION_LOCAL_RECIPE_DIR: dirs.recipes },
  });
  const seeded = await seedMod.seedAnnotations(stack, {
    dirs,
    python,
    renderCli:
      process.env.RENDER_CLI ??
      join(repoRoot, "artifacts/platform-tools/render/render"),
    log: (line) => console.error(`[seed] ${line}`),
  });
  stopRunner = seeded.stopRunner;
  const recs = Object.fromEntries(
    seeded.summary.recordings.map((r) => [r.scenario, r]),
  );
  check(
    "seed: exactly the three requested scenarios",
    Object.keys(recs).sort().join() === "caption_failed,ok,segment_failed",
    Object.keys(recs).join(),
  );
  const secretValues = [
    stack.password,
    stack.s3?.secretAccessKey,
    stack.s3?.accessKeyId,
  ].filter(Boolean);
  htmlSecrets = secretValues;
  const leaks = (s) => secretValues.some((v) => s.includes(v));
  const SECRET_RE =
    /(secret|password|token|authorization|bearer\s+[a-z0-9]|private key|x-amz-signature|x-amz-credential)/i;

  const noOverflow = () =>
    ev("document.documentElement.scrollWidth <= window.innerWidth");
  const diagnosticsRoutes = {};
  for (const [label, w, h] of [
    ["desktop", 1280, 900],
    ["390", 390, 844],
  ]) {
    const mobile = label === "390";
    ab("set", "viewport", String(w), String(h));
    await loginAs(stack, "staff");

    ab("open", `${stack.origin}/pipeline`);
    ab("wait", "h1");
    const listText = text();
    for (const [scenario, rec] of Object.entries(recs))
      check(
        `${label}: list links the ${scenario} recording`,
        ev(
          `!!document.querySelector('a[href^="/pipeline/${rec.recordingId}"]')`,
        ),
      );
    check(`${label}: list renders`, /Recording activity/.test(listText));
    if (mobile) check(`${label}: no horizontal overflow on list`, noOverflow());
    ab("screenshot", "--full", join(shots, `list-${label}.png`));

    for (const scenario of ["ok", "caption_failed", "segment_failed"]) {
      const rec = recs[scenario];
      ab("open", `${stack.origin}/pipeline/${rec.recordingId}`);
      ab("wait", "[data-testid=recipe-stages]");
      const stages = dumpStages();
      const pageText = text();
      receipt.recordings[scenario] ??= {
        recordingId: rec.recordingId,
        jobId: rec.jobId,
        stages: {},
      };
      check(
        `${label}/${scenario}: one row per recipe stage`,
        stages.map((s) => s.stage).join() === STAGES.join(),
        stages.map((s) => s.stage).join(),
      );
      for (const s of stages) {
        const exp = EXPECT[scenario][s.stage];
        const prefix = `${label}/${scenario}/${s.stage}`;
        check(`${prefix}: state ${exp}`, s.state === exp, s.state);
        check(
          `${prefix}: module badge ${MODULE[s.stage]}`,
          s.text.includes(MODULE[s.stage]),
        );
        if (s.state === "not_run")
          check(
            `${prefix}: not_run states upstream_failed reason`,
            /Not run/.test(s.text) &&
              /A stage it depends on failed/.test(s.text),
            s.text.replace(/\s+/g, " "),
          );
        if (s.state === "failed")
          check(
            `${prefix}: failed shows receipt_missing`,
            /did not return a stage receipt/.test(s.text),
            s.text.replace(/\s+/g, " "),
          );
        if (s.state === "succeeded")
          check(
            `${prefix}: succeeded has counts`,
            /\d+\s+\S/.test(s.text.split("Stage receipt")[0]),
            s.text.replace(/\s+/g, " "),
          );
        check(
          `${prefix}: stage receipt digest shown`,
          s.state === "not_run"
            ? !s.receipt && !/No stage receipt recorded/.test(s.text)
            : s.state === "failed"
              ? /No stage receipt recorded/.test(s.text)
              : /^[0-9a-f]{64}$/.test(s.receipt ?? ""),
          s.receipt ?? "none",
        );
        const wantsDiag =
          (s.stage === "segment" || s.stage === "caption") &&
          s.state === "succeeded";
        check(
          `${prefix}: diagnostics links ${wantsDiag ? "present" : "absent (none expected)"}`,
          wantsDiag ? s.diag.length > 0 : s.diag.length === 0,
          s.diag.join(","),
        );
        receipt.recordings[scenario].stages[`${label}:${s.stage}`] = {
          state: s.state,
          text: s.text.replace(/\s+/g, " "),
          diagnostics: s.diag,
        };
      }
      if (scenario === "caption_failed") {
        const cap = stages.find((s) => s.stage === "caption");
        check(
          `${label}/caption_failed: caption shows 2 failed captions`,
          /(^|\s)2\s+(failed|captions? failed)/i.test(cap.text) ||
            /failed[^\n]*\n?[^\n]*2|2[^\n]*failed/i.test(cap.text),
          cap.text.replace(/\s+/g, " "),
        );
      }
      check(
        `${label}/${scenario}: no secrets or signed URLs in page HTML`,
        !leaks(ev("document.documentElement.outerHTML")) &&
          !/X-Amz-Signature/i.test(ev("document.documentElement.outerHTML")),
      );
      if (mobile) {
        check(`${label}/${scenario}: no horizontal overflow`, noOverflow());
        const stacked =
          ev(`[...document.querySelectorAll('[data-testid=recipe-stages] > li')].every(li => {
          const [a, b] = li.children; return b.getBoundingClientRect().top >= a.getBoundingClientRect().bottom - 1; })`);
        check(`${label}/${scenario}: stage rows stack`, stacked);
        const small =
          ev(`[...document.querySelectorAll('[data-testid=diagnostic-link]')].map(b => {
          const r = b.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; })`);
        check(
          `${label}/${scenario}: diagnostics links tappable (>=24x24 CSS px)`,
          small.every(([bw, bh]) => bw >= 24 && bh >= 24),
          JSON.stringify(small),
        );
      }
      ab("screenshot", "--full", join(shots, `${scenario}-${label}.png`));

      // Click every diagnostics link; window.open and fetch are captured, not followed.
      if (scenario !== "ok" || label === "desktop") {
        const n = stages.reduce((a, s) => a + s.diag.length, 0);
        for (let i = 0; i < n; i++) {
          ev(`(() => { window.__opened = null; window.__calls = [];
            if (!window.__wrapped) { window.__wrapped = true;
              const f = window.fetch; window.fetch = async (...a) => { const c = [String(a[0]), a[1]?.method]; window.__calls.push(c);
                try { const r = await f(...a); c.push(r.status); c.push(await r.clone().text().then(t => t.replace(/"url":"[^"]*"/, '"url":"<redacted>"').slice(0, 200))); return r; }
                catch (e) { c.push('threw ' + e.name + ': ' + e.message); throw e; } };
              window.open = (u) => { window.__opened = u; return null; }; }
            document.querySelectorAll('[data-testid=diagnostic-link]')[${i}].click(); return true; })()`);
          const got = await until(() => ev("!!window.__opened"), 40);
          const opened = got ? ev("window.__opened") : null;
          const call = ev("window.__calls[0] ?? null");
          const name = `${label}/${scenario}/link#${i}`;
          check(
            `${name}: click POSTs the read route`,
            call?.[1] === "POST" &&
              /^\/api\/v1\/jobs\/[0-9a-f-]{36}\/diagnostics\/[0-9a-f-]{36}\/read$/.test(
                call[0],
              ),
            call?.[0],
          );
          if (call) diagnosticsRoutes[scenario] ??= call[0];
          check(
            `${name}: click yields a signed URL`,
            !!opened,
            JSON.stringify(ev("window.__calls[0]")?.slice(2)) +
              " alert=" +
              ev("document.querySelector('[role=alert]')?.innerText ?? ''"),
          );
          if (opened) {
            const r = await fetch(opened, {
              signal: AbortSignal.timeout(15000),
            });
            const body = await r.text();
            check(
              `${name}: fetched body is plain text, no secrets`,
              r.ok &&
                /text\/plain/.test(r.headers.get("content-type") ?? "") &&
                !/[\u0000-\u0008\u000e-\u001f]/.test(body) &&
                !leaks(body) &&
                !SECRET_RE.test(body),
              `${r.status} ${r.headers.get("content-type")} ${body.length}B`,
            );
            if (label === "desktop" && i === 0)
              receipt.recordings[scenario].sampleDiagnostic = body.slice(
                0,
                400,
              );
          }
          check(
            `${name}: signed URL not left in page HTML`,
            !opened ||
              !ev("document.documentElement.outerHTML").includes(
                opened.split("?")[0],
              ),
          );
        }
      }
    }
  }

  // Customer denial from the diagnostics route.
  const route = diagnosticsRoutes.ok ?? Object.values(diagnosticsRoutes)[0];
  await loginAs(stack, "customer");
  ab("open", `${stack.origin}/pipeline`);
  ab("wait", "1000");
  check(
    "customer: /pipeline not found",
    /404|could not be found/i.test(text()) &&
      !/Recording activity/.test(text()),
  );
  const denied = await (async () => {
    ev(`(async () => { const r = await fetch(${JSON.stringify(route)}, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", "x-stateaction-client": "web" }, body: "{}" });
      window.__deny = { status: r.status, body: await r.text() }; })() && true`);
    await until(() => ev("!!window.__deny"));
    return ev("window.__deny");
  })();
  check(
    "customer: diagnostics route denied, no URL issued",
    denied &&
      [401, 403, 404].includes(denied.status) &&
      !/JSON body required/.test(denied.body) &&
      !/"url"/.test(denied.body),
    `${denied?.status} ${denied?.body?.slice(0, 120)}`,
  );
  ab("screenshot", join(shots, "customer-denied-desktop.png"));
} catch (error) {
  check("driver completed without error", false, error?.stack ?? error);
} finally {
  try {
    ab("close");
  } catch {}
  stopRunner();
  await stack?.stop().catch(() => {});
  const failed = checks.filter((c) => !c.ok);
  writeFileSync(
    join(shots, "receipt.json"),
    JSON.stringify(
      {
        ...receipt,
        passed: checks.length - failed.length,
        total: checks.length,
        checks,
      },
      null,
      2,
    ),
  );
  console.log(
    `${checks.length - failed.length}/${checks.length} checks passed`,
  );
  process.exitCode = failed.length ? 1 : 0;
}
process.exit(process.exitCode ?? 0);
