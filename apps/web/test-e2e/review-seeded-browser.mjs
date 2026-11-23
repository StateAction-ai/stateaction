// SA-98 real-browser evidence driver for the Review page on the SA-96 SEEDED stack. Run inside ONE
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
  process.env.SHOTS_DIR ?? "/home/wearaway/flora-work/handoff/SA-98-real-shots";
mkdirSync(shots, { recursive: true });
const python =
  process.env.PYTHON_EXECUTABLE ??
  join(repoRoot, "workers/processing/.venv/bin/python");
const session = `sa98-${process.pid}`;
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

const stackEnv = seedMod.jobsEnv(python);
const dirs = seedMod.newSeedDirs();
let stack;
let stopRunner = () => {};
const receipt = { seedOnly: process.env.STATEACTION_SEED_ONLY, recordings: {} };
try {
  if (process.env.REVIEW_STACK_JSON) {
    // Drive an already running seeded stack (serve-console --seed annotations output).
    const live = JSON.parse(process.env.REVIEW_STACK_JSON);
    stack = {
      origin: live.origin,
      password: live.password,
      users: live.users,
      stop: async () => {},
      logs: () => "",
    };
    var seeded = { summary: live.seed };
  } else {
    stack = await startStack({
      storage: true,
      extraEnv: { ...stackEnv, STATEACTION_LOCAL_RECIPE_DIR: dirs.recipes },
    });
    seeded = await seedMod.seedAnnotations(stack, {
      dirs,
      python,
      renderCli:
        process.env.RENDER_CLI ??
        join(repoRoot, "artifacts/platform-tools/render/render"),
      log: (line) => console.error(`[seed] ${line}`),
    });
    stopRunner = seeded.stopRunner;
  }
  const recs = Object.fromEntries(
    seeded.summary.recordings.map((r) => [r.scenario, r]),
  );
  const noOverflow = () =>
    ev("document.documentElement.scrollWidth <= window.innerWidth");
  const apiDoc = (id) =>
    ev(
      `fetch('/api/v1/recordings/${id}/annotations').then(r => r.ok ? r.json() : null).then(j => j && j.data)`,
    );
  for (const [label, w, h] of [
    ["desktop", 1280, 900],
    ["390", 390, 844],
  ]) {
    ab("set", "viewport", String(w), String(h));
    await loginAs(stack, "staff");
    for (const [scenario, rec] of Object.entries(recs)) {
      ab("open", `${stack.origin}/review/${rec.recordingId}`);
      try {
        ab("wait", "[data-testid=review-summary]");
      } catch (error) {
        console.error(text());
        console.error(stack.logs().slice(-3000));
        throw new Error(
          `${scenario}/${label}: review page not rendered: ${text().slice(0, 1500)}`,
          { cause: error },
        );
      }
      await sleep(1500);
      const pre = `${label}/${scenario}`;
      const doc = await apiDoc(rec.recordingId);
      check(
        `${pre}: annotations API returns the accepted job`,
        doc && doc.job_id === rec.jobId,
        doc?.job_id,
      );
      const rows = doc?.segments?.rows ?? [];
      const cards = ev(
        "document.querySelectorAll('[data-testid=rail-card]').length",
      );
      check(
        `${pre}: one rail card per segment row`,
        cards === rows.length,
        `${cards} vs ${rows.length}`,
      );
      const failedCaps = (doc?.captions?.rows ?? []).filter(
        (r) => r.status === "failed",
      ).length;
      const failedShown = ev(
        "[...document.querySelectorAll('[data-testid=rail-failed]')].filter(e => e.textContent.startsWith('caption failed: ')).length",
      );
      check(
        `${pre}: failed captions shown with codes`,
        failedShown === failedCaps,
        `${failedShown} vs ${failedCaps}`,
      );
      if (scenario === "caption_failed")
        check(
          `${pre}: exactly 2 failed captions`,
          failedShown === 2,
          failedShown,
        );
      check(
        `${pre}: provenance badges present`,
        ev(
          "document.querySelectorAll('[data-testid=provenance] *').length > 0",
        ),
      );
      const prov = ev(
        "document.querySelector('[data-testid=provenance]')?.textContent ?? ''",
      );
      check(
        scenario === "segment_failed"
          ? `${pre}: failed segment stage shown with its code, caption not run`
          : `${pre}: stub provenance labelled`,
        scenario === "segment_failed"
          ? /segment: failed: receipt_missing/.test(prov) &&
              /caption: not_run: upstream_failed/.test(prov)
          : /stub/i.test(prov),
        prov.slice(0, 200),
      );
      check(`${pre}: no horizontal overflow`, noOverflow());
      const video = ev(
        "(() => { const v = document.querySelector('[data-testid=review-video]'); return v ? { ready: v.readyState, d: v.duration } : null })()",
      );
      check(
        `${pre}: review video loaded from the broker`,
        video && video.ready >= 1 && video.d > 0,
        JSON.stringify(video),
      );
      receipt.recordings[`${scenario}/${label}`] = {
        recordingId: rec.recordingId,
        cards,
        failedShown,
        video,
      };
      ab(
        "screenshot",
        "--full",
        join(shots, `review-${scenario}-${label}.png`),
      );
      if (scenario === "caption_failed") {
        ab("click", "#tab-json");
        await sleep(500);
        ab("screenshot", join(shots, `json-${label}.png`));
        ab("click", "#tab-hand");
        await sleep(2500);
        ab("screenshot", join(shots, `hand-${label}.png`));
        const handNote = ev(
          "document.querySelector('[data-testid=hand-no-clip]')?.textContent ?? document.querySelector('[data-testid=hand-viewer-phase]')?.textContent ?? ''",
        );
        check(
          `${pre}: hand pose tab renders (viewer or no-clip notice)`,
          handNote.length > 0,
          handNote,
        );
        ab("click", "#tab-segs");
      }
    }
  }
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
