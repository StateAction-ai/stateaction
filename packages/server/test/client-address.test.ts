import assert from "node:assert/strict";
import { test } from "node:test";
import { AuthConfigError, authConfig } from "../src/auth/config.js";
import {
  NO_TRUSTED_PROXIES,
  applyClientAddress,
  installClientAddressPolicy,
  parseTrustedProxies,
  resolveClientAddress,
} from "../src/auth/client-address.js";

const proxies = (value: string, extra: Record<string, string> = {}) =>
  parseTrustedProxies({
    APP_ENV: "local",
    AUTH_TRUSTED_PROXIES: value,
    ...extra,
  });

test("default trusts no proxies in every environment", () => {
  for (const APP_ENV of [
    "local",
    "test",
    "development",
    "staging",
    "production",
  ]) {
    const none = parseTrustedProxies({ APP_ENV });
    assert.deepEqual(none.entries, []);
    assert.equal(none.isTrusted("127.0.0.1"), false);
    assert.equal(none.isTrusted("10.0.0.1"), false);
  }
  assert.deepEqual(
    parseTrustedProxies({ AUTH_TRUSTED_PROXIES: " , " }).entries,
    [],
  );
});

test("a spoofed header from an untrusted peer is discarded", () => {
  const spoof = "203.0.113.9";
  assert.equal(
    resolveClientAddress("198.51.100.4", spoof, NO_TRUSTED_PROXIES),
    "198.51.100.4",
  );
  assert.equal(
    resolveClientAddress(
      "198.51.100.4",
      `${spoof}, 1.1.1.1`,
      NO_TRUSTED_PROXIES,
    ),
    "198.51.100.4",
  );
  // A trusted-proxy list does not help a peer outside it.
  assert.equal(
    resolveClientAddress("198.51.100.4", spoof, proxies("10.0.0.0/8")),
    "198.51.100.4",
  );
  // Rotating forged values never change the key.
  const keys = new Set(
    [1, 2, 3, 4].map((i) =>
      resolveClientAddress(
        "::ffff:198.51.100.4",
        `203.0.113.${i}`,
        NO_TRUSTED_PROXIES,
      ),
    ),
  );
  assert.deepEqual([...keys], ["198.51.100.4"]);
});

test("a trusted proxy's header is honored, rightmost untrusted hop wins", () => {
  const t = proxies("10.0.0.0/8, 192.0.2.7");
  assert.equal(
    resolveClientAddress("10.1.2.3", "203.0.113.9", t),
    "203.0.113.9",
  );
  assert.equal(
    resolveClientAddress("10.1.2.3", "6.6.6.6, 203.0.113.9, 10.9.9.9", t),
    "203.0.113.9",
  );
  assert.equal(
    resolveClientAddress("10.1.2.3", ["6.6.6.6", "203.0.113.9"], t),
    "203.0.113.9",
  );
  assert.equal(
    resolveClientAddress("192.0.2.7", "2001:DB8::1", t),
    "2001:db8::1",
  );
  assert.equal(resolveClientAddress("10.1.2.3", "10.5.5.5", t), "10.1.2.3"); // all hops trusted
  assert.equal(resolveClientAddress("10.1.2.3", undefined, t), "10.1.2.3");
});

test("malformed headers from a trusted proxy fall back to the peer", () => {
  const t = proxies("10.0.0.0/8");
  for (const bad of [
    "",
    "not-an-ip",
    "203.0.113.9, junk",
    "203.0.113.9,,1.1.1.1",
    "999.1.1.1",
  ])
    assert.equal(resolveClientAddress("10.1.2.3", bad, t), "10.1.2.3", bad);
});

test("loopback test trust is accepted locally and rejected on hosted services", () => {
  assert.equal(proxies("127.0.0.1,::1").isTrusted("::ffff:127.0.0.1"), true);
  for (const env of [
    { APP_ENV: "production" },
    { APP_ENV: "staging" },
    { APP_ENV: "local", RENDER: "true" },
  ])
    for (const value of [
      "127.0.0.1",
      "::1",
      "127.0.0.0/8",
      "::/1",
      "0.0.0.0/1",
      "::",
      "0.0.0.0/8",
      "::ffff:0:0/96",
      "::ffff:7f00:0/104",
      "::ffff:127.0.0.1",
      "::ffff:127.0.0.0/104",
      "[::1]",
    ])
      assert.throws(
        () => parseTrustedProxies({ ...env, AUTH_TRUSTED_PROXIES: value }),
        AuthConfigError,
        `${JSON.stringify(env)} ${value}`,
      );
  assert.equal(
    parseTrustedProxies({
      APP_ENV: "production",
      AUTH_TRUSTED_PROXIES: "10.0.0.0/8",
    }).isTrusted("10.2.3.4"),
    true,
  );
});

test("malformed or all-encompassing settings fail closed", () => {
  for (const value of [
    "nope",
    "10.0.0.1/33",
    "10.0.0.1/x",
    "10.0.0.0/0",
    "::/0",
    "1.2.3.4/8/9",
  ])
    assert.throws(() => proxies(value), AuthConfigError, value);
});

test("authConfig validates the setting", () => {
  const base = {
    APP_ENV: "local",
    DATABASE_URL: "postgres://x@localhost/db",
    BETTER_AUTH_URL: "http://127.0.0.1:3000",
    BETTER_AUTH_SECRET: "test-only-secret-0123456789abcdefghijklmnop",
    AUTH_LOCAL_PASSWORD: "true",
  };
  assert.doesNotThrow(() =>
    authConfig({ ...base, AUTH_TRUSTED_PROXIES: "127.0.0.1" }),
  );
  assert.throws(
    () => authConfig({ ...base, AUTH_TRUSTED_PROXIES: "bogus" }),
    AuthConfigError,
  );
});

test("applyClientAddress rewrites the real request header from the socket peer", () => {
  const req = (peer: string | undefined, xff?: string) =>
    ({
      headers: xff === undefined ? {} : { "x-forwarded-for": xff },
      socket: { remoteAddress: peer },
    }) as unknown as Parameters<typeof applyClientAddress>[0];
  const direct = req("198.51.100.4", "203.0.113.9");
  applyClientAddress(direct, NO_TRUSTED_PROXIES);
  assert.equal(direct.headers["x-forwarded-for"], "198.51.100.4");
  const proxied = req("10.0.0.2", "203.0.113.9");
  applyClientAddress(proxied, proxies("10.0.0.2"));
  assert.equal(proxied.headers["x-forwarded-for"], "203.0.113.9");
  const unknown = req(undefined, "203.0.113.9");
  applyClientAddress(unknown, proxies("10.0.0.2"));
  assert.equal(unknown.headers["x-forwarded-for"], undefined);
});

test("installClientAddressPolicy wraps request events once", () => {
  const seen: Array<string | string[] | undefined> = [];
  const target = {
    emit(_event: string | symbol, ...args: unknown[]) {
      seen.push(
        (args[0] as { headers: Record<string, string> }).headers[
          "x-forwarded-for"
        ],
      );
      return true;
    },
  };
  installClientAddressPolicy(target, NO_TRUSTED_PROXIES);
  installClientAddressPolicy(target, NO_TRUSTED_PROXIES);
  target.emit("request", {
    headers: { "x-forwarded-for": "1.1.1.1" },
    socket: { remoteAddress: "198.51.100.4" },
  });
  assert.deepEqual(seen, ["198.51.100.4"]);
});

test("applyClientAddress never throws and falls back to the peer", () => {
  const t = proxies("10.0.0.0/8");
  const headers: Record<string, string | string[] | undefined> = {
    "x-forwarded-for": "198.51.100.1",
  };
  // Peer present, header getter explodes: fall back to the peer address.
  const exploding = {
    get headers() {
      return new Proxy(headers, {
        get(target, key) {
          if (key === "x-forwarded-for" && !exploded.done) {
            exploded.done = true;
            throw new Error("boom");
          }
          return Reflect.get(target, key);
        },
      });
    },
    socket: { remoteAddress: "192.0.2.9" },
  };
  const exploded = { done: false };
  assert.doesNotThrow(() => applyClientAddress(exploding as never, t));
  assert.equal(headers["x-forwarded-for"], "192.0.2.9");
  // Destroyed socket: no peer, header removed, no throw.
  const gone = { headers: { "x-forwarded-for": "198.51.100.2" } as never };
  assert.doesNotThrow(() =>
    applyClientAddress({ ...gone, socket: null } as never, t),
  );
  assert.equal(
    (gone.headers as Record<string, unknown>)["x-forwarded-for"],
    undefined,
  );
});
