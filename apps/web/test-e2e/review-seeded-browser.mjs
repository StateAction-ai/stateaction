// SA-98/SA-99 real-browser evidence driver for the Review page on the SA-96 SEEDED stack. Run inside ONE
// resource-guarded job, e.g. `agent-resource run -- node test-e2e/review-seeded-browser.mjs`
// (needs the built web and jobs apps, the processing venv and the Render CLI; see
// serve-console.mjs). Seeds only ok, caption_failed and segment_failed (STATEACTION_SEED_ONLY
// overrides), signs in as staff, checks selected clips and team marks at desktop and
// 390 px, then writes screenshots and a JSON receipt to SHOTS_DIR. Always closes the
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
  process.env.SHOTS_DIR ?? "/home/wearaway/flora-work/handoff/SA-99-real-shots";
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

// SA-99: the G, B, N team-check flow on the seeded caption_failed recording. Desktop appends the
// marks; 390 px reloads and must show the same marks (they live on the server, not in the page).
const summaryText = () =>
  ev("document.querySelector('[data-testid=mark-summary]')?.innerText ?? ''");
const badgeOf = (i) =>
  ev(
    `(() => { const b = document.querySelectorAll('[data-testid=rail-card]')[${i}]?.querySelector('[data-testid=mark-badge]'); return b ? { mark: b.dataset.mark, text: b.innerText.trim() } : null })()`,
  );
const selectedCard = () =>
  ev(
    "[...document.querySelectorAll('[data-testid=rail-card]')].findIndex(c => c.dataset.selected === 'true')",
  );
const marksListing = (id) =>
  ev(
    `fetch('/api/v1/recordings/${id}/segment-marks').then(r => r.ok ? r.json() : null).then(j => j && j.data)`,
  );
async function marksFlow({ label, pre, rec, rows }) {
  const total = rows.length;
  if (label === "desktop") {
    check(
      `${pre}: starts unchecked`,
      (await summaryText()) === "0 checked, 0 issue",
      await summaryText(),
    );
    const clickCard = async (i) => {
      ab(
        "eval",
        `document.querySelectorAll('[data-testid=rail-card]')[${i}].querySelector('button').click()`,
      );
      await until(async () => (await selectedCard()) === i);
    };
    // A segment whose caption failed can still be marked (B, then the type picker).
    const fi = ev(
      "[...document.querySelectorAll('[data-testid=rail-card]')].findIndex(c => c.dataset.failed === 'true')",
    );
    check(`${pre}: a failed-caption card exists`, fi >= 0, fi);
    await clickCard(fi);
    ab("press", "b");
    check(
      `${pre}: B marks the failed-caption segment Issue (boundary)`,
      await until(async () => (await badgeOf(fi))?.text === "Boundary"),
    );
    const gi = fi === 0 ? 1 : 0;
    await clickCard(gi);
    ab("press", "g");
    check(
      `${pre}: G marks a card Good`,
      await until(async () => (await badgeOf(gi))?.mark === "good"),
    );
    // N goes to the next unchecked card after the selected one, wrapping.
    const expected = [...Array(total).keys()]
      .map((k) => (gi + 1 + k) % total)
      .find((i) => i !== fi && i !== gi);
    ab("press", "n");
    check(
      `${pre}: N selects the next unchecked card (${expected})`,
      await until(async () => (await selectedCard()) === expected),
      await selectedCard(),
    );
    ab("press", "b");
    await until(async () => (await badgeOf(expected))?.mark === "issue");
    ab("click", "[data-issue-type=hand_pose]");
    check(
      `${pre}: B then Hand pose marks the next card`,
      await until(async () => (await badgeOf(expected))?.text === "Hand pose"),
    );
    check(
      `${pre}: header counts follow`,
      await until(async () => (await summaryText()) === "3 checked, 2 issue"),
      await summaryText(),
    );
    ab("screenshot", join(shots, `marks-${scenarioShot}-${label}.png`));
  } else {
    await until(async () => (await summaryText()) === "3 checked, 2 issue");
    check(
      `${pre}: marks survive a reload and a new viewport`,
      (await summaryText()) === "3 checked, 2 issue",
      await summaryText(),
    );
    ab("screenshot", join(shots, `marks-${scenarioShot}-${label}.png`));
  }
  const listing = await marksListing(rec.recordingId);
  check(
    `${pre}: server listing matches (3 checked, 2 issue)`,
    listing && listing.checkedCount === 3 && listing.issueCount === 2,
    JSON.stringify(
      listing && [
        listing.segmentCount,
        listing.checkedCount,
        listing.issueCount,
      ],
    ),
  );
  for (const f of ["issue", "unchecked"]) {
    ab("click", `[data-filter=${f}]`);
    await until(
      async () =>
        ev(
          "document.querySelector('[data-filter=" +
            f +
            "]').getAttribute('aria-pressed')",
        ) === "true",
    );
    const shown = ev(
      "document.querySelectorAll('[data-testid=rail-card]').length",
    );
    check(
      `${pre}: ${f} chip filters the rail`,
      shown === (f === "issue" ? 2 : total - 3),
      `${shown}`,
    );
    ab("screenshot", join(shots, `marks-${f}-${label}.png`));
  }
  ab("click", "[data-filter=all]");
  check(
    `${pre}: no horizontal overflow with marks`,
    ev("document.documentElement.scrollWidth <= window.innerWidth"),
  );
}
const scenarioShot = "caption_failed";

const stackEnv = seedMod.jobsEnv(python);
const dirs = seedMod.newSeedDirs();
let stack;
let stopRunner = () => {};
const receipt = { seedOnly: process.env.STATEACTION_SEED_ONLY, recordings: {} };
try {
  if (process.env.REVIEW_STACK_JSON) {
    // Drive an already running seeded stack (serve-console --seed failure-fixtures output).
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
      ab("open", `${stack.origin}/clips/${rec.clipId ?? rec.recordingId}`);
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
        "[...document.querySelectorAll('[data-testid=rail-failed]')].filter(e => e.textContent.includes('No caption is available') && Boolean(e.title)).length",
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
          ? /Segmentation failed/.test(text())
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
        await marksFlow({ label, pre, rec, rows });
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
