import assert from "node:assert/strict";
import test from "node:test";
import { authenticateHuman, type GuardDeps } from "../src/auth/guard.js";

const session = {
  sessionId: "s1",
  userId: "opaque-1",
  email: "a@example.test",
  name: "A",
  expiresAt: new Date(Date.now() + 3600e3),
};
const deps = (over: Partial<GuardDeps> = {}): GuardDeps => ({
  sessions: async () => ({
    session,
    setCookies: ["better-auth.session_token=x; Max-Age=604800"],
  }),
  access: { grantsFor: async () => [{ role: "staff", enabled: true }] },
  trustedOrigins: ["https://app.example"],
  ...over,
});
const get = new Request("https://app.example/api/v1/me");

test("refreshed session cookies are forwarded with private cache headers", async () => {
  const result = await authenticateHuman(get, deps());
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.headers.getSetCookie(), [
      "better-auth.session_token=x; Max-Age=604800",
    ]);
    assert.match(
      result.headers.get("cache-control") ?? "",
      /private, no-store/,
    );
    assert.deepEqual(result.principal.access, {
      status: "active",
      roles: ["staff"],
    });
  }
});

test("session or access store outages fail closed with 503", async () => {
  for (const over of [
    {
      sessions: async () => {
        throw new Error("secret-db-detail");
      },
    },
    {
      access: {
        grantsFor: async () => {
          throw new Error("secret-db-detail");
        },
      },
    },
  ] as Partial<GuardDeps>[]) {
    const result = await authenticateHuman(get, deps(over));
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.response.status, 503);
      assert.doesNotMatch(await result.response.text(), /secret-db-detail/);
    }
  }
});

test("mutations are checked before the session is read", async () => {
  let read = false;
  const result = await authenticateHuman(
    new Request("https://app.example/x", {
      method: "POST",
      headers: { origin: "https://evil.example" },
    }),
    deps({
      sessions: async () => {
        read = true;
        return { session, setCookies: [] };
      },
    }),
  );
  assert.equal(result.ok, false);
  assert.equal(read, false);
});

test("a native JSON mutation without Origin passes the origin step", async () => {
  const result = await authenticateHuman(
    new Request("https://app.example/x", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-stateaction-client": "android",
      },
      body: "{}",
    }),
    deps(),
    { anyRole: ["staff"] },
  );
  assert.equal(result.ok, true);
});
