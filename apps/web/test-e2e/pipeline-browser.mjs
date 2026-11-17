// SA-34 real-browser evidence driver (run it inside ONE resource-guarded job,
// e.g. `agent-resource run -- node test-e2e/pipeline-browser.mjs`): starts the
// real production stack with real catalog rows, drives agent-browser through
// staff search/status/detail/Review clips/Back at desktop and phone widths, a
// keyboard-only pass and customer denial, writes screenshots and a JSON
// receipt under artifacts/sa34/browser, and always closes the browser daemon
// and stack. The throwaway e2e password belongs to the ephemeral database.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { startStack } from "./harness.mjs";

const serverDir = fileURLToPath(
  new URL("../../../packages/server/", import.meta.url),
);
const outDir = fileURLToPath(
  new URL("../../../artifacts/sa34/browser/", import.meta.url),
);
mkdirSync(outDir, { recursive: true });
const session = `sa34-${process.pid}`;
const ab = (...args) =>
  execFileSync("agent-browser", ["--session", session, ...args], {
    encoding: "utf8",
    timeout: 60000,
  }).trim();
const where = () =>
  JSON.parse(ab("eval", "location.pathname + location.search"));
const text = () => JSON.parse(ab("eval", "document.body.innerText"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (pred, tries = 20) => {
  for (let i = 0; i < tries; i++) {
    if (pred()) return true;
    await sleep(300);
  }
  return false;
};
const checks = [];
const check = (name, ok, detail = "") => {
  checks.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name} ${detail}`);
};
const loginAs = async (stack, label) => {
  ab("cookies", "clear");
  ab("open", `${stack.origin}/login`);
  ab("wait", "input[name=email]");
  for (let attempt = 0; attempt < 4; attempt++) {
    await sleep(1500); // let the form hydrate before typing
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

const stack = await startStack();
try {
  const seed = spawnSync(
    process.execPath,
    [
      "--conditions=react-server",
      "--import",
      "tsx",
      "test-auth/pipeline-seed-cli.ts",
    ],
    {
      cwd: serverDir,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        CATALOG_APP_URL: stack.db.appUrl,
        CATALOG_TEST_OWNER_URL: stack.db.ownerUrl,
        SEED_USERS: JSON.stringify(stack.users),
      },
      encoding: "utf8",
    },
  );
  if (seed.status !== 0) throw new Error(seed.stderr);
  const ids = JSON.parse(seed.stdout);

  for (const [label, w, h] of [
    ["desktop", 1280, 900],
    ["phone", 375, 760],
  ]) {
    ab("set", "viewport", String(w), String(h));
    await loginAs(stack, "staff");
    ab("open", `${stack.origin}/pipeline`);
    ab("wait", "h1");
    check(
      `${label}: list shows four columns/headings`,
      /Recording activity/.test(text()),
    );
    const noOverflow = JSON.parse(
      ab("eval", "document.documentElement.scrollWidth <= window.innerWidth"),
    );
    check(`${label}: no horizontal scroll on list`, noOverflow);
    ab("screenshot", `${outDir}list-${label}.png`);

    // Status filter via the real form.
    ab("select", "select[name=status]", "failed");
    ab("click", "button[type=submit]");
    await until(() => /status=failed/.test(where()));
    check(
      `${label}: status filter applied in URL`,
      /status=failed/.test(where()),
      where(),
    );
    const rows = JSON.parse(
      ab(
        "eval",
        "JSON.stringify([...document.querySelectorAll('tbody tr')].map(r => /Failed/.test(r.innerText)))",
      ),
    );
    check(
      `${label}: only failed rows`,
      JSON.parse(rows).length >= 1 && JSON.parse(rows).every(Boolean),
      rows,
    );

    // Search keeps the status filter.
    ab("fill", "input[name=q]", "Collector");
    ab("click", "button[type=submit]");
    await until(() => /q=Collector/.test(where()));
    check(
      `${label}: search keeps both filters`,
      /q=Collector/.test(where()) && /status=failed/.test(where()),
      where(),
    );

    // Open detail through the row link.
    ab("scrollintoview", "tbody tr a");
    ab("screenshot", `${outDir}list-filtered-${label}.png`);
    ab("click", "tbody tr a");
    await until(() => /^\/pipeline\/[0-9a-f-]{36}\?/.test(where()));
    check(
      `${label}: row opens detail`,
      /^\/pipeline\/[0-9a-f-]{36}\?/.test(where()),
      where(),
    );
    check(
      `${label}: failed detail has error, no Review clips`,
      /Action required/.test(text()) && !/Review clips/.test(text()),
    );
    ab("screenshot", `${outDir}detail-failed-${label}.png`);
    ab("back");
    await until(() => /^\/pipeline\?/.test(where()));
    check(
      `${label}: Back returns to filtered list`,
      /^\/pipeline\?/.test(where()) && /status=failed/.test(where()),
      where(),
    );

    // Completed recording → Review clips → data browser URL.
    ab("open", `${stack.origin}/pipeline/${ids.completed}?status=completed`);
    ab("wait", "h1");
    ab("screenshot", `${outDir}detail-completed-${label}.png`);
    ab("scrollintoview", 'a[href^="/data-browser?recordingId="]');
    ab("click", 'a[href^="/data-browser?recordingId="]');
    await until(() => /^\/data-browser/.test(where()));
    check(
      `${label}: Review clips opens browser URL without reviewStatus`,
      where() === `/data-browser?recordingId=${ids.completed}`,
      where(),
    );
    ab("back");
    await until(() => /^\/pipeline\//.test(where()));
    ab("scrollintoview", "main > a");
    ab("click", "main > a");
    await until(() => where() === "/pipeline?status=completed");
    check(
      `${label}: detail Back link restores list filter`,
      where() === "/pipeline?status=completed",
      where(),
    );
    ab("open", `${stack.origin}/pipeline/${ids.processing}`);
    ab("wait", "h1");
    check(
      `${label}: processing detail keeps quality checks unknown`,
      /Quality checks[\s\S]{0,40}Unknown/.test(text()),
    );
    ab("screenshot", `${outDir}detail-processing-${label}.png`);
  }

  // Keyboard-only: Tab to the first row link and press Enter.
  ab("set", "viewport", "1280", "900");
  ab("open", `${stack.origin}/pipeline`);
  ab("wait", "h1");
  let reached = false;
  for (let i = 0; i < 40 && !reached; i++) {
    ab("press", "Tab");
    reached = JSON.parse(
      ab(
        "eval",
        "document.activeElement?.tagName === 'A' && /^\\/pipeline\\/[0-9a-f-]{36}/.test(document.activeElement.getAttribute('href') ?? '')",
      ),
    );
  }
  check("keyboard: Tab reaches a row link", reached);
  ab("press", "Enter");
  ab("wait", "1000");
  check(
    "keyboard: Enter opens detail",
    /^\/pipeline\/[0-9a-f-]{36}/.test(where()),
    where(),
  );

  // Customer denial.
  await loginAs(stack, "customer");
  ab("open", `${stack.origin}/pipeline`);
  ab("wait", "1000");
  check(
    "customer: /pipeline is not found",
    /404|could not be found/i.test(text()) &&
      !/Recording activity/.test(text()),
  );
  ab("open", `${stack.origin}/pipeline/${ids.completed}`);
  ab("wait", "1000");
  check(
    "customer: detail is not found",
    /404|could not be found/i.test(text()) && !/Processing stages/.test(text()),
  );
  ab("screenshot", `${outDir}customer-denied.png`);
} finally {
  try {
    ab("close");
  } catch {}
  await stack.stop();
  writeFileSync(`${outDir}receipt.json`, JSON.stringify({ checks }, null, 2));
}
const failed = checks.filter((c) => !c.ok);
console.log(`${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
