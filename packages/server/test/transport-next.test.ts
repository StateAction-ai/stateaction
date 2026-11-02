import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { AuthRuntime } from "../src/auth/runtime.js";
import {
  hashServiceToken,
  issueServiceCredential,
} from "../src/auth/service.js";
import {
  jobAuthority,
  ownerAuthority,
  transportRouteHandlers,
} from "../src/transport/next.js";
import {
  JobCapabilityStore,
  WORKER_AUDIENCE,
} from "../src/transport/runtime.js";

const jobId = randomUUID();
const { token } = issueServiceCredential({
  credentialId: "c",
  kind: "worker",
  audience: WORKER_AUDIENCE,
  scopes: ["job:output"],
  jobId,
  ttlSeconds: 60,
});
const bearer = (value: string, extra: Record<string, string> = {}) =>
  new Request("https://api.test/x", {
    method: "POST",
    headers: { authorization: `Bearer ${value}`, ...extra },
  });

/** Pool stub answering the job-capability lookup like the jobs table would. */
function pool(row: { id: string; execution_deadline: Date | null } | null) {
  const seen: unknown[][] = [];
  return {
    seen,
    query: async (_sql: string, values: unknown[]) => {
      seen.push(values);
      return {
        rows: row && values[0] === hashServiceToken(token) ? [row] : [],
      };
    },
  };
}
const runtime = (p: ReturnType<typeof pool>) => () =>
  ({ pool: p }) as unknown as AuthRuntime;
const future = () => new Date(Date.now() + 60_000);

test("worker authority: only the live, job-bound, job:output capability passes", async () => {
  const live = pool({ id: jobId, execution_deadline: future() });
  const ok = await jobAuthority(bearer(token), jobId, runtime(live));
  assert.deepEqual(ok.ok && ok.authority, { kind: "job", jobId });
  assert.deepEqual(
    live.seen[0],
    [hashServiceToken(token)],
    "only the hash is queried",
  );

  const status = async (
    r: Promise<Awaited<ReturnType<typeof jobAuthority>>>,
  ) => {
    const out = await r;
    return out.ok ? 200 : out.response.status;
  };
  // Another job's route with this job's capability.
  assert.equal(
    await status(jobAuthority(bearer(token), randomUUID(), runtime(live))),
    403,
  );
  // Not running / unknown / no deadline recorded / deadline passed.
  assert.equal(
    await status(jobAuthority(bearer(token), jobId, runtime(pool(null)))),
    401,
  );
  assert.equal(
    await status(
      jobAuthority(
        bearer(token),
        jobId,
        runtime(pool({ id: jobId, execution_deadline: null })),
      ),
    ),
    401,
  );
  assert.equal(
    await status(
      jobAuthority(
        bearer(token),
        jobId,
        runtime(
          pool({ id: jobId, execution_deadline: new Date(Date.now() - 1000) }),
        ),
      ),
    ),
    401,
  );
  // Malformed, missing, cookie-only credentials and a malformed job id.
  assert.equal(
    await status(jobAuthority(bearer("nope"), jobId, runtime(live))),
    401,
  );
  assert.equal(
    await status(
      jobAuthority(
        new Request("https://api.test/x", {
          method: "POST",
          headers: { cookie: "better-auth.session_token=abc" },
        }),
        jobId,
        runtime(live),
      ),
    ),
    401,
  );
  assert.equal(
    await status(jobAuthority(bearer(token), "not-a-uuid", runtime(live))),
    404,
  );
});

test("capability store carries only the output scope and fails closed without a deadline", async () => {
  const store = new JobCapabilityStore(
    pool({ id: jobId, execution_deadline: null }),
  );
  const record = await store.findByTokenSha256(hashServiceToken(token));
  assert.deepEqual(record?.scopes, ["job:output"]);
  assert.equal(record?.kind, "worker");
  assert.ok(record && record.expiresAt.getTime() === 0);
});

const session = {
  sessionId: "sess-1",
  userId: "ba_user-1",
  email: "c@example.test",
  name: "C",
  expiresAt: new Date(Date.now() + 3600e3),
};
function humanRuntime(
  roles: { role: string; enabled: boolean }[],
  signedIn = true,
) {
  return () =>
    ({
      ready: async () => undefined,
      pool: {},
      guard: {
        sessions: async () => ({
          session: signedIn ? session : null,
          setCookies: ["better-auth.session_token=fresh; Max-Age=60"],
        }),
        access: { grantsFor: async () => roles },
        trustedOrigins: ["https://app.test"],
      },
    }) as unknown as AuthRuntime;
}
const human = (headers: Record<string, string> = {}, method = "POST") =>
  new Request("https://app.test/api/v1/uploads", {
    method,
    headers: {
      "x-stateaction-client": "android",
      "content-type": "application/json",
      ...headers,
    },
    body: method === "GET" ? undefined : "{}",
  });

test("owner authority is the live session's own user and needs an enabled collector role", async () => {
  const collector = [{ role: "collector", enabled: true }];
  const ok = await ownerAuthority(human(), humanRuntime(collector));
  assert.deepEqual(ok.ok && ok.authority, {
    kind: "owner",
    userId: "ba_user-1",
    sessionId: "sess-1",
  });
  assert.ok(
    ok.ok && ok.headers?.getSetCookie().length === 1,
    "refreshed cookie is forwarded",
  );

  const status = async (
    r: Promise<Awaited<ReturnType<typeof ownerAuthority>>>,
  ) => {
    const out = await r;
    return out.ok ? 200 : out.response.status;
  };
  assert.equal(
    await status(
      ownerAuthority(human(), humanRuntime([{ role: "staff", enabled: true }])),
    ),
    403,
  );
  assert.equal(
    await status(
      ownerAuthority(
        human(),
        humanRuntime([{ role: "collector", enabled: false }]),
      ),
    ),
    403,
  );
  assert.equal(await status(ownerAuthority(human(), humanRuntime([]))), 403);
  assert.equal(
    await status(ownerAuthority(human(), humanRuntime(collector, false))),
    401,
  );
  // No bearer fallback for a human route, a missing client header is refused.
  assert.equal(
    await status(
      ownerAuthority(
        human({ authorization: `Bearer ${token}` }),
        humanRuntime(collector),
      ),
    ),
    401,
  );
  assert.equal(
    await status(
      ownerAuthority(
        human({ "x-stateaction-client": "" }),
        humanRuntime(collector),
      ),
    ),
    403,
  );
  assert.equal(
    await status(
      ownerAuthority(
        human({ origin: "https://evil.test" }),
        humanRuntime(collector),
      ),
    ),
    403,
  );
  // Runtime/config failure answers 503 with no detail.
  const failing = await ownerAuthority(human(), () => {
    throw new Error("DATABASE_URL=postgres://secret");
  });
  assert.ok(!failing.ok && failing.response.status === 503);
  assert.doesNotMatch(
    await (!failing.ok ? failing.response.text() : Promise.resolve("")),
    /secret|postgres/,
  );
});

test("route layer: bad ids are 404 before any lookup; storage configuration failure is a private 503", async () => {
  const lookups: string[] = [];
  const p = { query: async (sql: string) => (lookups.push(sql), { rows: [] }) };
  const routes = transportRouteHandlers(
    () =>
      ({
        ...(humanRuntime([{ role: "collector", enabled: true }])() as object),
        pool: p,
      }) as unknown as AuthRuntime,
    () => {
      throw new Error("S3_SECRET_ACCESS_KEY is missing");
    },
  );
  const badId = await routes.owner.get(human({}, "GET"), "../../etc");
  assert.equal(badId.status, 404);
  const badJob = await routes.job.create(bearer(token), "x");
  assert.equal(badJob.status, 404);
  assert.equal(lookups.length, 0);
  const failed = await routes.owner.create(human());
  assert.equal(failed.status, 503);
  const text = await failed.text();
  assert.doesNotMatch(text, /S3_SECRET|missing/);
  assert.match(failed.headers.get("cache-control") ?? "", /no-store/);
});
