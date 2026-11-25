// SA-34 REAL-STACK HTTP E2E for /recordings: production `next start`, real Better
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
// Visible text only (full recording IDs are confined to links).
const visible = (html) =>
  html
    .replace(/<script[\s\S]*?<\/script>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ");
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
  test("list shows searchable records with processing statuses", async () => {
    const res = await navigate("/recordings", staff);
    assert.equal(res.status, 200);
    assert.match(String(res.headers["cache-control"]), /no-store|private/);
    const text = visible(res.text);
    for (const heading of [
      "Search recordings",
      "Status",
      "Sort",
      "All recordings",
    ])
      assert.match(text, new RegExp(heading));
    assert.doesNotMatch(text, UUID);
    for (const id of Object.values(ids)) {
      assert.ok(res.text.includes(`href="/recordings/${id}"`), id);
      assert.ok(text.includes(id.slice(0, 8)), id);
    }
  });

  test("status filter and search narrow the rows", async () => {
    const failed = await navigate("/recordings?status=failed", staff);
    assert.ok(failed.text.includes(`/recordings/${ids.failed}"`));
    assert.ok(!failed.text.includes(`/recordings/${ids.completed}`));
    const byId = await navigate(
      "/recordings?q=" + ids.completed.slice(0, 8),
      staff,
    );
    assert.ok(byId.text.includes("/recordings/" + ids.completed));
    assert.ok(!byId.text.includes("/recordings/" + ids.processing));
    const none = await navigate("/recordings?q=zzzz-no-match", staff);
    assert.match(visible(none.text), /No recordings match your search/);
    // Hostile or malformed parameters never fail the page.
    for (const qs of [
      "status=bogus",
      "page=-5",
      "page=abc",
      "q=%25_%5C",
      `q=${"x".repeat(900)}`,
    ])
      assert.equal(
        (await navigate(`/recordings?${qs}`, staff)).status,
        200,
        qs,
      );
  });
});

describe("recording detail", () => {
  test("completed: recording details link to the clip processing page", async () => {
    const res = await navigate(`/recordings/${ids.completed}`, staff);
    assert.equal(res.status, 200);
    assert.match(visible(res.text), /Clip planning/);
    assert.match(visible(res.text), /Recording estimated cost/);
    assert.ok(res.text.includes('href="/recordings"'));
    assert.match(
      res.text,
      new RegExp(
        `href="/recordings/${ids.completed}/clips/[a-f0-9-]{36}/processing"`,
      ),
    );
  });

  test("failed: curated error and no provider payload", async () => {
    const res = await navigate(`/recordings/${ids.failed}`, staff);
    assert.equal(res.status, 200);
    assert.match(visible(res.text), /Source checksum mismatch/);
    assert.doesNotMatch(res.text, /bad bytes|\/srv\//);
  });

  test("malformed and unknown ids are 404", async () => {
    for (const p of ["not-a-uuid", "00000000-0000-4000-8000-000000000000"])
      assert.equal((await navigate(`/recordings/${p}`, staff)).status, 404, p);
  });
});

describe("role denials", () => {
  test("signed out redirects to login", async () => {
    for (const p of ["/recordings", `/recordings/${ids.completed}`]) {
      const res = await navigate(p);
      assert.equal(res.status, 307);
      assert.match(res.headers.location, /\/login$/);
    }
  });
  test("customer gets 404, collector sees no recording data", async () => {
    const customer = await rawSignIn(stack, "customer");
    for (const p of ["/recordings", `/recordings/${ids.completed}`])
      assert.equal((await navigate(p, customer)).status, 404, p);
    const collector = await rawSignIn(stack, "collector");
    for (const p of ["/recordings", `/recordings/${ids.completed}`]) {
      const res = await navigate(p, collector);
      assert.doesNotMatch(res.text, /All recordings|Clip planning/, p);
    }
  });
});

test("removed review and pipeline URLs return the generic 404", async () => {
  const missing = await navigate("/deleted-console-route", staff);
  assert.equal(missing.status, 404);
  const heading = missing.text.match(/<h1[^>]*>([^<]+)<\/h1>/)?.[1];
  assert.ok(heading);
  for (const parent of ["/pipeline", "/review"]) {
    for (const path of [
      parent,
      `${parent}/${ids.completed}`,
      `${parent}/clips/${ids.completed}`,
    ]) {
      const res = await navigate(path, staff);
      assert.equal(res.status, 404, path);
      assert.equal(res.headers.location, undefined, path);
      assert.equal(
        res.text.match(/<h1[^>]*>([^<]+)<\/h1>/)?.[1],
        heading,
        path,
      );
    }
  }
});
