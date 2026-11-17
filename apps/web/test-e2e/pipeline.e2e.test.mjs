// SA-34 REAL-STACK HTTP E2E for /pipeline: production `next start`, real Better
// Auth sessions, restricted `stateaction_app` Postgres, operator-managed roles
// and real catalog rows (processing, completed with clips, failed).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";
import {
  call as rawCall,
  signIn as rawSignIn,
  startStack,
} from "./harness.mjs";

const serverDir = fileURLToPath(
  new URL("../../../packages/server/", import.meta.url),
);
let stack;
let ids;
let staff;
const call = (path, init) => rawCall(stack.origin, path, init);
const navigate = (path, jar) =>
  call(path, {
    jar,
    headers: {
      "sec-fetch-site": "same-origin",
      "sec-fetch-mode": "navigate",
      "sec-fetch-dest": "document",
    },
  });
// Visible text only (hrefs may carry ids; they must never be displayed).
const visible = (html) =>
  html
    .replace(/<script[\s\S]*?<\/script>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ");
// Page content only (the shell header holds the account-menu button).
const main = (html) => /<main[\s\S]*<\/main>/.exec(html)?.[0] ?? "";
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;

before(async () => {
  stack = await startStack();
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
  ids = JSON.parse(seed.stdout);
  staff = await rawSignIn(stack, "staff");
});
after(async () => {
  await stack?.stop();
});

describe("staff list", () => {
  test("four columns, real rows, no row actions or raw ids", async () => {
    const res = await navigate("/pipeline", staff);
    assert.equal(res.status, 200);
    assert.match(String(res.headers["cache-control"]), /no-store|private/);
    const text = visible(res.text);
    for (const h of ["Recording", "Collector", "Source", "Status"])
      assert.match(text, new RegExp(h));
    for (const s of ["Processing", "Completed", "Failed"])
      assert.match(text, new RegExp(s));
    // The three seeded rows plus the SA-13 local seed's own recording.
    assert.ok(
      (res.text.match(/href="\/pipeline\/[0-9a-f-]{36}"/g) ?? []).length >= 3,
    );
    assert.doesNotMatch(text, UUID);
    assert.doesNotMatch(text, /Scenario|\b(Cancel|Retry|Reconcile|Inspect)\b/);
    for (const id of Object.values(ids))
      assert.ok(res.text.includes(`href="/pipeline/${id}"`), id);
  });

  test("status filter and search narrow the rows and links preserve filters", async () => {
    const failed = await navigate("/pipeline?status=failed", staff);
    assert.ok(failed.text.includes(`/pipeline/${ids.failed}?status=failed`));
    assert.ok(!failed.text.includes(`/pipeline/${ids.completed}`));
    const none = await navigate("/pipeline?q=zzzz-no-match", staff);
    assert.match(visible(none.text), /No recordings match these filters/);
    // Hostile or malformed parameters never fail the page.
    for (const qs of [
      "status=bogus",
      "page=-5",
      "page=abc",
      "q=%25_%5C",
      `q=${"x".repeat(900)}`,
    ])
      assert.equal((await navigate(`/pipeline?${qs}`, staff)).status, 200, qs);
  });
});

describe("recording detail", () => {
  test("completed: Review clips link, no reviewStatus, no fake controls", async () => {
    const res = await navigate(
      `/pipeline/${ids.completed}?status=completed`,
      staff,
    );
    assert.equal(res.status, 200);
    assert.ok(
      res.text.includes(`href="/data-browser?recordingId=${ids.completed}"`),
    );
    assert.doesNotMatch(res.text, /reviewStatus/);
    assert.ok(res.text.includes('href="/pipeline?status=completed"'));
    const text = visible(res.text);
    assert.match(text, /Review clips/);
    assert.match(text, /Ready for review/);
    assert.match(text, /2 clips/);
    assert.doesNotMatch(text, UUID);
    assert.doesNotMatch(main(res.text), /<button/);
  });

  test("processing: quality checks stay unknown and no Review clips", async () => {
    const text = visible(
      (await navigate(`/pipeline/${ids.processing}`, staff)).text,
    );
    assert.match(text, /Quality checks Unknown/);
    assert.doesNotMatch(text, /Review clips/);
  });

  test("failed: curated error, no Review clips", async () => {
    const res = await navigate(`/pipeline/${ids.failed}`, staff);
    const text = visible(res.text);
    assert.match(text, /Source checksum mismatch/);
    assert.doesNotMatch(text, /bad bytes|\/srv\/|Review clips/);
  });

  test("malformed and unknown ids are 404", async () => {
    for (const p of ["not-a-uuid", "00000000-0000-4000-8000-000000000000"])
      assert.equal((await navigate(`/pipeline/${p}`, staff)).status, 404, p);
  });
});

describe("role denials", () => {
  test("signed out redirects to login", async () => {
    for (const p of ["/pipeline", `/pipeline/${ids.completed}`]) {
      const res = await navigate(p);
      assert.equal(res.status, 307);
      assert.match(res.headers.location, /\/login$/);
    }
  });
  test("customer gets 404, collector sees no pipeline data", async () => {
    const customer = await rawSignIn(stack, "customer");
    for (const p of ["/pipeline", `/pipeline/${ids.completed}`])
      assert.equal((await navigate(p, customer)).status, 404, p);
    const collector = await rawSignIn(stack, "collector");
    for (const p of ["/pipeline", `/pipeline/${ids.completed}`]) {
      const res = await navigate(p, collector);
      assert.doesNotMatch(res.text, /Recording activity|Processing stages/, p);
    }
  });
});
