// Allow/deny matrix for non-human principals (workflow controller, repair
// cron, processing worker). Uses an in-memory credential store; persistence
// and issuance belong to the job-orchestration tickets.
import assert from "node:assert/strict";
import test from "node:test";
import {
  authenticateService,
  issueServiceCredential,
  type ServiceCredentialRecord,
  type ServiceCredentialStore,
  type ServiceRequirement,
} from "../src/auth/service.js";

const AUD = "stateaction-internal-api";
const JOB_A = "6b1f2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const JOB_B = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4e";
const now = new Date("2026-11-01T12:00:00Z");

class MemoryStore implements ServiceCredentialStore {
  records = new Map<string, ServiceCredentialRecord>();
  add(record: ServiceCredentialRecord) {
    this.records.set(record.tokenSha256, record);
  }
  async findByTokenSha256(sha256: string) {
    return this.records.get(sha256) ?? null;
  }
}

const store = new MemoryStore();
function issue(input: Parameters<typeof issueServiceCredential>[0]) {
  const { token, record } = issueServiceCredential({ now, ...input });
  store.add(record);
  return token;
}
const workflow = issue({
  credentialId: "wf",
  kind: "workflow",
  audience: AUD,
  scopes: ["jobs:status", "jobs:reconcile"],
  ttlSeconds: 3600,
});
const cron = issue({
  credentialId: "cron",
  kind: "cron",
  audience: AUD,
  scopes: ["jobs:repair"],
  ttlSeconds: 3600,
});
const workerA = issue({
  credentialId: "worker-a",
  kind: "worker",
  audience: AUD,
  scopes: ["job:claim", "job:heartbeat", "job:result"],
  jobId: JOB_A,
  ttlSeconds: 900,
});
const expired = issue({
  credentialId: "old",
  kind: "worker",
  audience: AUD,
  scopes: ["job:claim"],
  jobId: JOB_A,
  ttlSeconds: 60,
  now: new Date(now.getTime() - 120_000),
});
const otherAudience = issue({
  credentialId: "aud",
  kind: "workflow",
  audience: "some-other-api",
  scopes: ["jobs:status"],
  ttlSeconds: 3600,
});
const revoked = (() => {
  const { token, record } = issueServiceCredential({
    credentialId: "revoked",
    kind: "cron",
    audience: AUD,
    scopes: ["jobs:repair"],
    ttlSeconds: 3600,
    now,
  });
  store.add({ ...record, revokedAt: new Date(now.getTime() - 1000) });
  return token;
})();

const req = (headers: Record<string, string>) =>
  new Request("https://api.example/internal/v1/x", { method: "POST", headers });
const bearer = (token: string) => req({ authorization: `Bearer ${token}` });

const claimA: ServiceRequirement = {
  audience: AUD,
  kinds: ["worker"],
  scope: "job:claim",
  jobId: JOB_A,
};
const claimB: ServiceRequirement = { ...claimA, jobId: JOB_B };
const status: ServiceRequirement = {
  audience: AUD,
  kinds: ["workflow"],
  scope: "jobs:status",
};
const repair: ServiceRequirement = {
  audience: AUD,
  kinds: ["cron"],
  scope: "jobs:repair",
};

const matrix: [string, Request, ServiceRequirement, "allow" | 401 | 403][] = [
  ["worker claims its own job", bearer(workerA), claimA, "allow"],
  ["worker cannot claim another job", bearer(workerA), claimB, 403],
  ["worker cannot use workflow status", bearer(workerA), status, 403],
  ["worker cannot run repair", bearer(workerA), repair, 403],
  ["workflow reads job status", bearer(workflow), status, "allow"],
  ["workflow cannot claim as a worker", bearer(workflow), claimA, 403],
  ["workflow cannot run repair", bearer(workflow), repair, 403],
  ["cron runs repair", bearer(cron), repair, "allow"],
  ["cron cannot read status", bearer(cron), status, 403],
  ["cron cannot claim", bearer(cron), claimA, 403],
  ["expired worker credential", bearer(expired), claimA, 401],
  ["revoked credential", bearer(revoked), repair, 401],
  ["wrong audience", bearer(otherAudience), status, 403],
  ["unknown token", bearer(`sa_svc_${"B".repeat(43)}`), status, 401],
  ["malformed token", bearer("not-a-token"), status, 401],
  ["no credential", req({}), status, 401],
  [
    "human session cookie is never accepted",
    req({ cookie: "better-auth.session_token=abc.def" }),
    status,
    401,
  ],
  [
    "Basic auth is not a bearer",
    req({ authorization: `Basic ${workflow}` }),
    status,
    401,
  ],
];

for (const [name, request, requirement, expected] of matrix)
  test(`service principal: ${name}`, async () => {
    const result = await authenticateService(request, store, requirement, now);
    if (expected === "allow") {
      assert.equal(result.ok, true);
      if (result.ok) assert.equal(result.principal.audience, AUD);
    } else {
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.response.status, expected);
        assert.match(
          result.response.headers.get("cache-control") ?? "",
          /no-store/,
        );
        const body = await result.response.text();
        assert.doesNotMatch(body, /sa_svc_|job|scope|audience/i);
      }
    }
  });

test("issuance rules: workers are job-bound, others are not, lifetimes are bounded", () => {
  const base = { credentialId: "x", audience: AUD, ttlSeconds: 60 } as const;
  assert.throws(() =>
    issueServiceCredential({ ...base, kind: "worker", scopes: ["job:claim"] }),
  );
  assert.throws(() =>
    issueServiceCredential({
      ...base,
      kind: "cron",
      scopes: ["jobs:repair"],
      jobId: JOB_A,
    }),
  );
  assert.throws(() =>
    issueServiceCredential({
      ...base,
      kind: "cron",
      scopes: [],
      ttlSeconds: 60,
    }),
  );
  assert.throws(() =>
    issueServiceCredential({
      ...base,
      kind: "cron",
      scopes: ["jobs:repair"],
      ttlSeconds: 0,
    }),
  );
  assert.throws(() =>
    issueServiceCredential({
      ...base,
      kind: "cron",
      scopes: ["jobs:repair"],
      ttlSeconds: 90_000,
    }),
  );
  const { token, record } = issueServiceCredential({
    ...base,
    kind: "cron",
    scopes: ["jobs:repair"],
  });
  assert.match(token, /^sa_svc_[A-Za-z0-9_-]{43}$/);
  assert.ok(!JSON.stringify(record).includes(token), "only the hash is stored");
});

test("a store outage fails closed with a retryable 503", async () => {
  const result = await authenticateService(
    bearer(workflow),
    {
      findByTokenSha256: async () => {
        throw new Error("db down");
      },
    },
    status,
    now,
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.response.status, 503);
});
