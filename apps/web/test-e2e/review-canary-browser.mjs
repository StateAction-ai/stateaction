// SA-101 evidence driver: the Review page on a stack seeded ONLY with `replay_canary_homer_33`, the
// REAL FLORA stage outputs of the Modal canary (store `artifacts/fixtures/flora-canary`, written by
// `modal_flora.py::canary`). Run inside ONE resource-guarded job, e.g.
// `REVIEW_STACK_JSON=<line> agent-resource run -- node test-e2e/review-canary-browser.mjs`, where the line
// is the output of `STATEACTION_SEED_ONLY=replay_canary_homer_33 node test-e2e/serve-console.mjs --seed
// failure-fixtures` (needs the built web and jobs apps, the processing venv and the Render CLI). The stack
// must live in ANOTHER process: this driver blocks its event loop in `agent-browser` calls, and the
// stack's in-process storage proxy (outage-proxy.mjs) then cannot answer the web server, so the review
// page fails with provider_unavailable (seen 3 of 3 times when the driver hosted the stack). Signs in as staff, opens the review
// page at desktop and 390 px, checks it against the annotations API, and writes screenshots and a
// JSON receipt to SHOTS_DIR. Always closes the browser session, stops the job runner and the stack
// (exact pids only). Zero model spend: the canary store is read, nothing is run on a GPU.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

process.env.STATEACTION_SEED_ONLY = "replay_canary_homer_33";
const guards = await import("./seed-scenarios.mjs");
guards.refuseNonLocalEnv(process.env);
for (const sc of Object.values({
  ...guards.SYNTHETIC_SCENARIOS,
  ...guards.REPLAY_SCENARIOS,
  ...guards.CANARY_SCENARIOS,
}))
  guards.refuseSpend(sc.recipe);
const seedMod = await import("./seed-annotations.mjs");
seedMod.seedOnly(process.env.STATEACTION_SEED_ONLY); // validate before starting anything

const shots =
  process.env.SHOTS_DIR ?? "/home/wearaway/flora-work/handoff/SA-101-shots";
mkdirSync(shots, { recursive: true });
const session = `sa101-${process.pid}`;
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

let stack;
const receipt = { seedOnly: process.env.STATEACTION_SEED_ONLY, recordings: {} };
try {
  if (!process.env.REVIEW_STACK_JSON)
    throw new Error(
      "REVIEW_STACK_JSON is required: seed with serve-console --seed failure-fixtures in another process",
    );
  const live = JSON.parse(process.env.REVIEW_STACK_JSON);
  stack = {
    origin: live.origin,
    password: live.password,
    users: live.users,
    stop: async () => {},
    logs: () => "",
  };
  const seeded = { summary: live.seed };
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
        console.error(
          await ev(
            `fetch('/api/v1/recordings/${rec.recordingId}/annotations').then(r => r.text().then(t => r.status + ' ' + t.slice(0, 600)))`,
          ),
        );
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
      const capRows = doc?.captions?.rows ?? [];
      const cards = ev(
        "document.querySelectorAll('[data-testid=rail-card]').length",
      );
      check(
        `${pre}: one rail card per segment row`,
        cards === rows.length && rows.length > 0,
        `${cards} vs ${rows.length}`,
      );
      const failedCaps = capRows.filter((r) => r.status === "failed").length;
      const failedShown = ev(
        "[...document.querySelectorAll('[data-testid=rail-failed]')].filter(e => e.textContent.includes('No caption is available') && Boolean(e.title)).length",
      );
      check(
        `${pre}: failed captions shown as found (never forced to 0)`,
        failedShown === failedCaps,
        `${failedShown} vs ${failedCaps}`,
      );
      const shownText = ev(
        "[...document.querySelectorAll('[data-testid=rail-card]')].map(e => e.textContent).join('\\n')",
      );
      const complete = capRows.filter((r) => r.status === "complete");
      check(
        `${pre}: every complete caption's steps are on the page`,
        complete.length > 0 &&
          complete.every((r) =>
            r.derived.steps.every((step) => shownText.includes(step)),
          ),
        `${complete.length} complete`,
      );
      const prov = ev(
        "document.querySelector('[data-testid=provenance]')?.textContent ?? ''",
      );
      check(
        `${pre}: provenance labelled as a replay of the real run`,
        /replay/i.test(prov),
        prov.slice(0, 240),
      );
      const replayed = rows.find((r) => r.ext?.replayed_from)?.ext
        .replayed_from;
      check(
        `${pre}: segment rows carry the real Modal run in ext.replayed_from`,
        replayed &&
          /RTX PRO 6000/.test(replayed.gpu_name ?? "") &&
          /^2026-/.test(replayed.run_utc ?? ""),
        JSON.stringify(replayed),
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
        provenance: prov,
        replayed,
        video,
      };
      ab(
        "screenshot",
        "--full",
        join(shots, `review-${scenario}-${label}.png`),
      );
    }
  }
} catch (error) {
  check("driver completed without error", false, error?.stack ?? error);
} finally {
  try {
    ab("close");
  } catch {}
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
