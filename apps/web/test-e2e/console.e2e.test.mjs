// SA-16 REAL-STACK HTTP E2E: production `next start`, real Better Auth
// sessions, restricted `stateaction_app` Postgres and operator-managed roles.
// Covers the console's role-protected pages, the guarded own-profile endpoint
// (including attacker inputs) and server-confirmed sign-out. Browser
// interaction (keyboard, widths, Back) is exercised separately with
// agent-browser against the same stack (serve-console.mjs).
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import {
  SESSION,
  browserHeaders,
  call as rawCall,
  signIn as rawSignIn,
  startStack,
  webDir,
} from "./harness.mjs";

let stack;
const call = (path, init) => rawCall(stack.origin, path, init);
const signIn = (label) => rawSignIn(stack, label);
const owner = (sql) => stack.db.ownerSql(sql);
const quote = (v) => `'${String(v).replace(/'/g, "''")}'`;
const nameOf = (id) => owner(`SELECT name FROM "user" WHERE id = ${quote(id)}`);
const emailOf = (id) =>
  owner(`SELECT email FROM "user" WHERE id = ${quote(id)}`);
const rolesOf = (id) =>
  owner(
    `SELECT string_agg(role || ':' || enabled::text, ',' ORDER BY role) FROM access WHERE user_id = ${quote(id)}`,
  );

const navigate = (path, jar) =>
  call(path, {
    jar,
    headers: {
      "sec-fetch-site": "same-origin",
      "sec-fetch-mode": "navigate",
      "sec-fetch-dest": "document",
    },
  });
const patch = (jar, body, headers = {}, raw = false) =>
  call("/api/v1/me/profile", {
    method: "PATCH",
    jar,
    body: raw ? body : JSON.stringify(body),
    headers: browserHeaders(stack.origin, headers),
  });

function assertPrivate(res, what) {
  assert.match(String(res.headers["cache-control"]), /no-store/, what);
}

before(async () => {
  stack = await startStack();
});
after(async () => {
  await stack?.stop();
});

describe("no fixture identity path exists", () => {
  test("production sources contain no fixture role bypass", () => {
    const hits = [];
    const walk = (dir) => {
      for (const entry of readdirSync(dir)) {
        if (["node_modules", ".next", "tsconfig.tsbuildinfo"].includes(entry))
          continue;
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) walk(path);
        else if (
          /STATEACTION_UI_FIXTURE|fixtureSession|fixture-user/.test(
            readFileSync(path, "utf8"),
          ) &&
          !path.includes("test-e2e")
        )
          hits.push(path);
      }
    };
    walk(webDir);
    assert.deepEqual(hits, []);
  });

  test("setting a fixture variable on the server grants nothing", async () => {
    // The running server never had it; assert the pages deny without a session.
    for (const path of [
      "/console",
      "/recordings",
      "/data-browser",
      "/recipes",
      "/settings",
    ]) {
      const res = await navigate(path);
      assert.equal(res.status, 307, path);
      assert.match(res.headers.location, /\/login$/);
      assertPrivate(res, path);
    }
  });
});

describe("role-protected console pages (real session, live roles)", () => {
  test("staff sees Recordings, Data browser and Recipes", async () => {
    const jar = await signIn("staff");
    const recordings = await navigate("/recordings", jar);
    assert.equal(recordings.status, 200);
    assertPrivate(recordings, "recordings");
    assert.match(recordings.text, /href="\/recordings"/);
    assert.match(recordings.text, /href="\/data-browser"/);
    assert.match(recordings.text, /href="\/recipes"/);
    assert.doesNotMatch(recordings.text, />(Releases|Projects?)</);
    const data = await navigate("/data-browser", jar);
    assert.equal(data.status, 200);
    const home = await navigate("/console", jar);
    assert.equal(home.status, 307);
    assert.match(home.headers.location, /\/recordings$/);
  });

  test("customer sees Data only; staff routes are 404", async () => {
    const jar = await signIn("customer");
    const data = await navigate("/data-browser", jar);
    assert.equal(data.status, 200);
    assert.doesNotMatch(data.text, /href="\/recordings"/);
    assert.equal((await navigate("/recordings", jar)).status, 404);
    const home = await navigate("/console", jar);
    assert.match(home.headers.location, /\/data-browser$/);
  });

  test("collector-only account gets an honest notice and no console access", async () => {
    const jar = await signIn("collector");
    for (const path of ["/data-browser", "/settings"]) {
      const res = await navigate(path, jar);
      assert.match(res.text, /Capture accounts use the Android app/);
      assert.doesNotMatch(res.text, /href="\/recordings"/);
      assert.doesNotMatch(res.text, /aria-label="Primary"/);
    }
    const recordings = await navigate("/recordings", jar);
    assert.doesNotMatch(recordings.text, /aria-label="Primary"/);
    assert.doesNotMatch(recordings.text, /No recordings are shown yet/);
  });

  test("pending and disabled accounts see only a notice with sign-out", async () => {
    for (const [label, text] of [
      ["pending", /Access pending/],
      ["disabled", /Access disabled/],
    ]) {
      const jar = await signIn(label);
      const res = await navigate("/data-browser", jar);
      assert.match(res.text, text);
      assert.doesNotMatch(res.text, /aria-label="Primary"/);
      const recordings = await navigate("/recordings", jar);
      assert.doesNotMatch(recordings.text, /No recordings are shown yet/);
    }
  });

  test("an operator role change applies on the very next request", async () => {
    const jar = await signIn("staff");
    assert.equal((await navigate("/recordings", jar)).status, 200);
    const id = stack.users.staff.id;
    owner(
      `UPDATE access SET enabled = false WHERE user_id = ${quote(id)} AND role = 'staff'`,
    );
    try {
      const res = await navigate("/recordings", jar);
      assert.match(res.text, /Access disabled/);
      assert.doesNotMatch(res.text, /aria-label="Primary"/);
      assert.doesNotMatch(res.text, /No recordings are shown yet/);
    } finally {
      owner(
        `UPDATE access SET enabled = true WHERE user_id = ${quote(id)} AND role = 'staff'`,
      );
    }
  });
});

describe("guarded own-profile endpoint", () => {
  test("updates only the caller's trimmed display name and echoes server state", async () => {
    const jar = await signIn("customer");
    const id = stack.users.customer.id;
    const email = emailOf(id);
    const roles = rolesOf(id);
    const outsiderBefore = nameOf(stack.users.outsider.id);
    const res = await patch(jar, { name: "  Casey  Lee-Ng  " });
    assert.equal(res.status, 200, res.text);
    assertPrivate(res, "profile");
    const body = JSON.parse(res.text);
    assert.equal(body.data.user.name, "Casey  Lee-Ng");
    assert.equal(body.data.user.id, id);
    assert.equal(nameOf(id), "Casey  Lee-Ng");
    assert.equal(emailOf(id), email);
    assert.equal(rolesOf(id), roles);
    assert.equal(nameOf(stack.users.outsider.id), outsiderBefore);
    const me = JSON.parse((await call("/api/v1/me", { jar })).text);
    assert.equal(me.data.user.name, "Casey  Lee-Ng");
  });

  test("any enabled role may edit its own name; pending/disabled may not", async () => {
    const collector = await signIn("collector");
    assert.equal((await patch(collector, { name: "Col Lector" })).status, 200);
    for (const label of ["pending", "disabled"]) {
      const jar = await signIn(label);
      const before = nameOf(stack.users[label].id);
      assert.equal((await patch(jar, { name: "Nope" })).status, 403, label);
      assert.equal(nameOf(stack.users[label].id), before);
    }
  });

  test("attacker-controlled identity, email and role fields are refused and change nothing", async () => {
    const jar = await signIn("customer");
    const victim = stack.users.staff.id;
    const mine = stack.users.customer.id;
    const snapshot = () =>
      [
        nameOf(victim),
        emailOf(victim),
        rolesOf(victim),
        emailOf(mine),
        rolesOf(mine),
      ].join("|");
    const before = snapshot();
    for (const body of [
      { name: "X", userId: victim },
      { name: "X", id: victim },
      { name: "X", email: "evil@example.test" },
      { name: "X", roles: ["staff"] },
      { name: "X", role: "staff" },
      { name: "X", image: "https://evil.test/a.png" },
      { name: "X", constructor: 1 },
      { userId: victim },
      [{ name: "X" }],
      "name",
      null,
    ]) {
      const res = await patch(jar, body);
      assert.equal(res.status, 422, JSON.stringify(body));
    }
    // Query-string identity is ignored: only the session user is ever edited.
    const viaQuery = await call(`/api/v1/me/profile?userId=${victim}`, {
      method: "PATCH",
      jar,
      body: JSON.stringify({ name: "Query Attempt" }),
      headers: browserHeaders(stack.origin),
    });
    assert.equal(viaQuery.status, 200);
    assert.equal(nameOf(mine), "Query Attempt");
    assert.equal(nameOf(victim), before.split("|")[0]);
    assert.equal(emailOf(victim), before.split("|")[1]);
    assert.equal(rolesOf(victim), before.split("|")[2]);
    assert.equal(rolesOf(mine), before.split("|")[4]);
  });

  test("invalid names are rejected with the shared validation", async () => {
    const jar = await signIn("staff");
    const id = stack.users.staff.id;
    const before = nameOf(id);
    for (const name of [
      "",
      "   ",
      "a".repeat(81),
      "😀".repeat(81),
      "a\nb",
      "a\u0000b",
      "a‮b",
      42,
      null,
      undefined,
    ]) {
      const res = await patch(jar, { name });
      assert.equal(res.status, 422, JSON.stringify(name));
    }
    assert.equal((await patch(jar, { name: "a".repeat(80) })).status, 200);
    assert.equal((await patch(jar, { name: "😀".repeat(80) })).status, 200);
    assert.notEqual(nameOf(id), before);
  });

  test("origin, Fetch Metadata, client header, content type and size are enforced", async () => {
    const jar = await signIn("staff");
    const id = stack.users.staff.id;
    const before = nameOf(id);
    const attempt = (headers, body = { name: "Blocked" }, raw = false) =>
      call("/api/v1/me/profile", {
        method: "PATCH",
        jar,
        body: raw ? body : JSON.stringify(body),
        headers,
      });
    const base = browserHeaders(stack.origin);
    const without = (key) => {
      const copy = { ...base };
      delete copy[key];
      return copy;
    };
    assert.equal(
      (await attempt({ ...base, origin: "https://evil.example" })).status,
      403,
    );
    assert.equal((await attempt(without("origin"))).status, 403);
    assert.equal(
      (await attempt({ ...base, "sec-fetch-site": "cross-site" })).status,
      403,
    );
    assert.equal(
      (await attempt({ ...base, "sec-fetch-site": "same-site" })).status,
      403,
    );
    assert.equal((await attempt(without("x-stateaction-client"))).status, 403);
    assert.equal(
      (await attempt({ ...base, "x-stateaction-client": "android" })).status,
      403,
    );
    assert.notEqual(
      (await attempt({ ...base, "content-type": "text/plain" })).status,
      200,
    );
    assert.equal(
      (await attempt(base, JSON.stringify({ name: "x".repeat(5000) }), true))
        .status,
      422,
    );
    assert.equal((await attempt(base, "{not json", true)).status, 422);
    assert.equal((await attempt(base, "", true)).status, 422);
    assert.equal(nameOf(id), before);
    // Bearer credentials never authenticate a human route.
    const bearer = await call("/api/v1/me/profile", {
      method: "PATCH",
      body: JSON.stringify({ name: "Bearer" }),
      headers: browserHeaders(stack.origin, {
        authorization: "Bearer sa_svc_" + "A".repeat(43),
      }),
    });
    assert.equal(bearer.status, 401);
  });

  test("anonymous callers, other methods and the broad update-user path stay closed", async () => {
    assert.equal((await patch(undefined, { name: "Anon" })).status, 401);
    const jar = await signIn("staff");
    for (const method of ["GET", "POST", "PUT", "DELETE"]) {
      const res = await call("/api/v1/me/profile", {
        method,
        jar,
        headers: browserHeaders(stack.origin),
      });
      assert.equal(res.status, 405, method);
    }
    const broad = await call("/api/auth/update-user", {
      method: "POST",
      jar,
      body: JSON.stringify({ name: "Broad" }),
      headers: browserHeaders(stack.origin),
    });
    assert.equal(broad.status, 404);
    assert.notEqual(nameOf(stack.users.staff.id), "Broad");
  });

  test("a revoked session cannot edit the profile", async () => {
    const jar = await signIn("outsider");
    const before = nameOf(stack.users.outsider.id);
    const token = decodeURIComponent(jar.cookies.get(SESSION)).split(".")[0];
    owner(`DELETE FROM session WHERE token = ${quote(token)}`);
    assert.equal((await patch(jar, { name: "Stale" })).status, 401);
    assert.equal(nameOf(stack.users.outsider.id), before);
  });

  test("hostile display names render as escaped text", async () => {
    const jar = await signIn("staff");
    const hostile = `<img src=x onerror=alert(1)> & "q"`;
    assert.equal((await patch(jar, { name: hostile })).status, 200);
    const res = await navigate("/settings", jar);
    assert.equal(res.status, 200);
    assert.doesNotMatch(res.text, /<img src=x/);
    assert.match(res.text, /&lt;img src=x onerror=alert\(1\)&gt;/);
    assert.ok(nameOf(stack.users.staff.id) === hostile);
  });
});

describe("server-confirmed sign-out", () => {
  test("sign-out revokes the session row; the same cookie is refused everywhere", async () => {
    const jar = await signIn("staff");
    const token = decodeURIComponent(jar.cookies.get(SESSION)).split(".")[0];
    assert.equal(
      owner(`SELECT count(*) FROM session WHERE token = ${quote(token)}`),
      "1",
    );
    const saved = jar.header();
    const out = await call("/api/auth/sign-out", {
      method: "POST",
      jar,
      body: "{}",
      headers: browserHeaders(stack.origin),
    });
    assert.equal(out.status, 200);
    assertPrivate(out, "sign-out");
    assert.equal(
      owner(`SELECT count(*) FROM session WHERE token = ${quote(token)}`),
      "0",
    );
    // A browser Back/direct request replaying the old cookie stays protected.
    const replay = { cookie: saved };
    for (const path of [
      "/recordings",
      "/data-browser",
      "/recipes",
      "/settings",
    ]) {
      const res = await call(path, {
        headers: { ...replay, "sec-fetch-mode": "navigate" },
      });
      assert.equal(res.status, 307, path);
      assert.match(res.headers.location, /\/login$/);
    }
    const me = await call("/api/v1/me", { headers: replay });
    assert.equal(me.status, 401);
    const edit = await call("/api/v1/me/profile", {
      method: "PATCH",
      body: JSON.stringify({ name: "After signout" }),
      headers: browserHeaders(stack.origin, replay),
    });
    assert.equal(edit.status, 401);
  });

  test("sign-out from a foreign origin is refused and the session survives", async () => {
    const jar = await signIn("staff");
    const res = await call("/api/auth/sign-out", {
      method: "POST",
      jar,
      body: "{}",
      headers: browserHeaders(stack.origin, { origin: "https://evil.example" }),
    });
    assert.notEqual(res.status, 200);
    assert.equal((await call("/api/v1/me", { jar })).status, 200);
  });
});

// Published wire contracts (catalog.v4): real service bytes validated against
// http.profile-update.v1 / http.profile.v1 and their conformance fixtures.
describe("own-profile service matches the published wire contracts", () => {
  const contractsDir = new URL("../../../packages/contracts/", import.meta.url);
  const { Ajv2020 } = createRequire(new URL("package.json", contractsDir))(
    "ajv/dist/2020.js",
  );
  const readJson = (path) =>
    JSON.parse(readFileSync(new URL(path, contractsDir), "utf8"));
  const ajv = new Ajv2020({
    allErrors: true,
    strict: true,
    allowUnionTypes: true,
    validateFormats: false,
  });
  ajv.addSchema(readJson("api/common.v1.schema.json"));
  const requestSchema = readJson("api/http/profile-update.v1.schema.json");
  const responseSchema = readJson("api/http/profile.v1.schema.json");
  ajv.addSchema(requestSchema);
  ajv.addSchema(responseSchema);
  const validRequest = ajv.getSchema(requestSchema.$id);
  const validResponse = ajv.getSchema(responseSchema.$id);
  const responseCases = readJson(
    "conformance/fixtures/contracts/http.profile.v1.json",
  ).cases;
  const rejectedNames = responseCases
    .filter(
      (c) =>
        !c.expect.valid &&
        c.expect.paths?.[0] === "/user/name" &&
        !/^(leading|trailing|whitespace)/.test(c.name),
    )
    .map((c) => c.input.document.user.name);

  test("success bodies validate and the stored value is trimmed NFC", async () => {
    const jar = await signIn("collector");
    const id = stack.users.collector.id;
    const cases = [
      ["Pilot Staff", "Pilot Staff"],
      ["  Pilot  ", "Pilot"],
      ["Pilot ", "Pilot"],
      ["　Pilot　", "Pilot"],
      ["﻿Pilot", "Pilot"],
      ["Café", "Café"],
      ["\u{1f600}".repeat(80), "\u{1f600}".repeat(80)],
    ];
    for (const [sent, stored] of cases) {
      assert.equal(validRequest({ name: sent }), true, JSON.stringify(sent));
      const res = await patch(jar, { name: sent });
      assert.equal(res.status, 200, `${JSON.stringify(sent)} ${res.text}`);
      const body = JSON.parse(res.text);
      assert.equal(
        validResponse(body.data),
        true,
        JSON.stringify(validResponse.errors),
      );
      assert.equal(body.data.user.name, stored);
      assert.equal(body.data.user.id, id);
      assert.equal(body.data.user.name, body.data.user.name.normalize("NFC"));
      assert.equal(nameOf(id), stored);
    }
  });

  test("every name the response contract rejects is refused or normalized before storage", async () => {
    const half = Math.ceil(rejectedNames.length / 2);
    for (const [label, names] of [
      ["customer", rejectedNames.slice(0, half)],
      ["collector", rejectedNames.slice(half)],
    ]) {
      const jar = await signIn(label);
      const id = stack.users[label].id;
      for (const name of names) {
        const before = nameOf(id);
        const res = await patch(jar, { name });
        assert.equal(res.status, 422, JSON.stringify(name));
        assert.equal(nameOf(id), before, JSON.stringify(name));
      }
    }
  });

  test("wire-bound violations never reach storage", async () => {
    const jar = await signIn("staff");
    const id = stack.users.staff.id;
    const before = nameOf(id);
    for (const body of [
      { name: "" },
      { name: "Pilot", roles: ["staff"] },
      {},
      [{ name: "Pilot" }],
    ]) {
      assert.equal(validRequest(body), false, JSON.stringify(body));
      assert.equal((await patch(jar, body)).status, 422, JSON.stringify(body));
    }
    assert.equal(nameOf(id), before);
  });
});
