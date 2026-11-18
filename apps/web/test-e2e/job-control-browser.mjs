// SA-27 real-browser click path (run it inside ONE resource-guarded job):
// production stack + real catalog rows; staff signs in, opens the Pipeline detail of a
// live attempt, clicks "Cancel job" (confirm accepted), sees "cancel_requested is not
// stopped" state/guidance, and a failed-source recording shows corrected-source guidance
// with no Retry. Always closes the browser daemon and the stack. Throwaway e2e password.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { startStack } from "./harness.mjs";

const serverDir = fileURLToPath(
  new URL("../../../packages/server/", import.meta.url),
);
const outDir = fileURLToPath(
  new URL("../../../artifacts/sa27/browser/", import.meta.url),
);
mkdirSync(outDir, { recursive: true });
const session = `sa27-${process.pid}`;
const ab = (...args) =>
  execFileSync("agent-browser", ["--session", session, ...args], {
    encoding: "utf8",
    timeout: 60000,
  }).trim();
const text = () => JSON.parse(ab("eval", "document.body.innerText"));
const where = () =>
  JSON.parse(ab("eval", "location.pathname + location.search"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (pred, tries = 30) => {
  for (let i = 0; i < tries; i++) {
    if (pred()) return true;
    await sleep(400);
  }
  return false;
};
const checks = [];
const check = (name, ok, detail = "") => {
  checks.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name} ${detail}`);
};
const run = (cli, stack) => {
  const r = spawnSync(
    process.execPath,
    ["--conditions=react-server", "--import", "tsx", cli],
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
  if (r.status !== 0) throw new Error(r.stderr);
  return JSON.parse(r.stdout);
};

const stack = await startStack();
try {
  const ids = {
    ...run("test-auth/pipeline-seed-cli.ts", stack),
    ...run("test-auth/job-control-seed-cli.ts", stack),
  };
  ab("set", "viewport", "1280", "900");
  ab("cookies", "clear");
  ab("open", `${stack.origin}/login`);
  ab("wait", "input[name=email]");
  for (let attempt = 0; attempt < 4; attempt++) {
    await sleep(1500);
    ab("fill", "input[name=email]", stack.users.staff.email);
    ab("fill", "input[name=password]", stack.password);
    ab("click", "button[type=submit]");
    if (await until(() => !where().startsWith("/login"), 12)) break;
  }

  ab("open", `${stack.origin}/pipeline/${ids.live}`);
  ab("wait", "h1");
  await sleep(1500); // hydration
  check("live attempt shows Cancel job", /Cancel job/.test(text()));
  ab("screenshot", `${outDir}live-before.png`);
  // Accept the confirmation prompt the control raises, then click the real button.
  ab("eval", "window.confirm = () => true");
  ab("find", "role", "button", "click", "--name", "Cancel job");
  const requested = await until(
    () =>
      /Cancellation is requested, not complete|State: cancel_requested/.test(
        text(),
      ),
    40,
  );
  check(
    "click reaches the API and shows cancel_requested, not stopped",
    requested,
  );
  check(
    "no Retry offered before termination is proven",
    !/Retry as new job/.test(text()),
  );
  ab("screenshot", `${outDir}live-after.png`);

  ab("open", `${stack.origin}/pipeline/${ids.failed}`);
  ab("wait", "h1");
  check(
    "failed source asks for corrected source",
    /corrected source/.test(text()),
  );
  check("failed source offers no Retry", !/Retry as new job/.test(text()));
  ab("screenshot", `${outDir}failed-source.png`);
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
