// SA-120 WIRING E2E: the production `next build` output served by `next start`
// WITHOUT the AUTH_TRUSTED_PROXIES opt-in (the production default: nobody is
// trusted). A rotating forged x-forwarded-for must not open fresh sign-in
// buckets, which proves apps/web/instrumentation.ts runs under `next start`,
// patches the HTTP server and reaches Next's route handlers. A second stack
// with the loopback opt-in proves the trusted path still keys per header.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { browserHeaders, call, startStack } from "./harness.mjs";

let untrusted;
let trusted;

before(async () => {
  untrusted = await startStack({ trustedProxies: "" });
  trusted = await startStack();
});
after(async () => {
  await trusted?.stop();
  await untrusted?.stop();
});

async function wrongSignIns(stack, forwardedFor, n = 6) {
  const statuses = [];
  for (let i = 0; i < n; i++) {
    const res = await call(stack.origin, "/api/auth/sign-in/email", {
      method: "POST",
      body: JSON.stringify({
        email: stack.users.staff.email,
        password: "wrong password value",
      }),
      headers: {
        ...browserHeaders(stack.origin),
        "x-forwarded-for": forwardedFor(i),
      },
    });
    statuses.push(res.status);
  }
  return statuses;
}

describe("sign-in limiter client address", () => {
  test("the stack really runs without the proxy opt-in", () => {
    assert.equal(untrusted.env.AUTH_TRUSTED_PROXIES, undefined);
    assert.equal(trusted.env.AUTH_TRUSTED_PROXIES, "127.0.0.1,::1");
  });

  test("untrusted peer: rotating forged x-forwarded-for still hits 429", async () => {
    const statuses = await wrongSignIns(
      untrusted,
      (i) => `203.0.113.${100 + i}`,
    );
    assert.ok(statuses.includes(429), statuses.join(","));
  });

  test("untrusted peer: a forged IPv6 and multi-hop chain also share the peer bucket", async () => {
    const statuses = await wrongSignIns(untrusted, (i) =>
      i % 2 ? `2001:db8::${i}` : `198.51.100.${i}, 203.0.113.${i}`,
    );
    assert.ok(statuses.includes(429), statuses.join(","));
  });

  test("trusted loopback peer: distinct x-forwarded-for values keep separate buckets", async () => {
    const statuses = await wrongSignIns(
      trusted,
      (i) => `198.51.100.${200 + i}`,
    );
    assert.ok(!statuses.includes(429), statuses.join(","));
    const same = await wrongSignIns(trusted, () => "198.51.100.250");
    assert.ok(same.includes(429), same.join(","));
  });
});
