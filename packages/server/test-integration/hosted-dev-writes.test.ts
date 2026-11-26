import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { captureRecipeSelectionRoute } from "../src/admission/http.js";
import type { AuthRuntime } from "../src/auth/runtime.js";
import { datasetRoutes, reviewClipRoutes } from "../src/datasets/http.js";
import { HOSTED_DEV_DATABASE_HOST } from "../src/hosted-dev.js";
import { jobControlRoutes } from "../src/jobs/control.js";
import { stageRerunRouteHandlers } from "../src/jobs/next.js";
import { stageRerunRoutes } from "../src/jobs/stage-rerun-http.js";
import { freshDatabase } from "./harness.js";

const id = "00000000-0000-4000-8000-000000000001";
const origin = "http://127.0.0.1:3008";
const decision = `/api/v2/review-clips/${id}/decision`;
const caption = `/api/v2/review-clips/${id}/segments/${id}/caption`;
const datasets = "/api/v1/datasets";
const recording = `/api/v1/recordings/${id}`;
const stageReruns = `/api/v2/recordings/${id}/stage-reruns`;

function validBodies(contract: string) {
  const path = new URL(
    `../../contracts/conformance/fixtures/contracts/http.${contract}.json`,
    import.meta.url,
  );
  const { cases } = JSON.parse(readFileSync(path, "utf8")) as {
    cases: Array<{
      name: string;
      input: { document: unknown };
      expect: { valid: boolean };
    }>;
  };
  const valid = cases
    .filter(({ expect }) => expect.valid)
    .map(({ name, input }) => ({ name, body: input.document }));
  assert.ok(valid.length, contract);
  return valid;
}

test("authenticated read-only writes return a private 403 before reaching the catalog", async (t) => {
  const db = await freshDatabase();
  t.after(() => db.close());
  const originalEnv = process.env;
  t.after(() => {
    process.env = originalEnv;
  });
  process.env = {
    ...originalEnv,
    STATEACTION_HOSTED_DEV_MODE: "read-only",
    NODE_ENV: "development",
    APP_ENV: "development",
    DATABASE_URL: `postgresql://stateaction_dev_reader:test@${HOSTED_DEV_DATABASE_HOST}/stateaction?sslmode=verify-full`,
    STATEACTION_HOSTED_DEV_AUTH_DATABASE_URL: db.appUrl,
    STATEACTION_WEB_HOST: "127.0.0.1",
    BETTER_AUTH_URL: origin,
    AUTH_LOCAL_PASSWORD: "true",
    S3_BUCKET: "stateaction-prod",
    CI: "",
    RENDER: "",
    RENDER_SERVICE_ID: "",
    GOOGLE_CLIENT_ID: "",
    GOOGLE_CLIENT_SECRET: "",
    PROCESSING_EXECUTION_BACKEND: "",
  };
  const deps = {
    pool: db.app,
    reader: { read: async () => assert.fail("storage read on write denial") },
    signer: { sign: async () => assert.fail("signed URL on write denial") },
    authenticate: async (request: Request) => {
      if (!request.headers.has("cookie"))
        return {
          ok: false as const,
          response: new Response(null, { status: 401 }),
        };
      if (request.headers.get("cookie") === "test=customer")
        return {
          ok: false as const,
          response: new Response(null, { status: 403 }),
        };
      return {
        ok: true as const,
        principal: { userId: id },
        requestId: id,
        headers: new Headers({ "Set-Cookie": "test=refreshed" }),
      };
    },
  };
  const review = reviewClipRoutes(deps);
  const dataset = datasetRoutes(deps);
  const jobs = jobControlRoutes({ ...deps, config: {} });
  const loadStageDeps = t.mock.fn(() => deps);
  const stages = stageRerunRoutes(deps.authenticate, loadStageDeps);
  const capture = (request: Request) =>
    captureRecipeSelectionRoute(
      () => assert.fail("admission configuration loaded on write denial"),
      deps.authenticate,
      request,
      id,
    );
  type Handler = (request: Request) => Promise<Response>;
  const writes: Array<{
    path: string;
    handler: Handler;
    name: string;
    method: string;
    body?: unknown;
  }> = [];
  function add(
    path: string,
    handler: Handler,
    contract: string,
    method = "POST",
  ) {
    for (const { name, body } of validBodies(contract))
      writes.push({ path, handler, name, method, body });
  }
  add(decision, (req) => review.decision(req, id), "clip-review-command.v2");
  add(
    caption,
    (req) => review.caption(req, id, id),
    "caption-correction-command.v2",
  );
  add(
    `/api/v2/review-clips/${id}/result-selection`,
    (req) => review.select(req, id),
    "recording-result-selection-command.v1",
  );
  add(
    `/api/v1/clips/${id}/review`,
    (req) => dataset.commitClipReview(req, id),
    "clip-review-command.v1",
  );
  add(
    `/api/v1/review-clips/${id}/decision?selection=1`,
    (req) => dataset.commitClipReview(req, id, true),
    "clip-review-command.v1",
  );
  add(datasets, dataset.createDataset, "dataset-create.v1");
  add(
    `${datasets}/${id}`,
    (req) => dataset.renameDataset(req, id),
    "dataset-update.v1",
    "PATCH",
  );
  add(
    `${datasets}/${id}/clips`,
    (req) => dataset.addDatasetClips(req, id),
    "dataset-members-add.v1",
  );
  writes.push({
    name: "remove member",
    path: `${datasets}/${id}/clips/${id}?expectedRevision=1`,
    handler: (req) => dataset.removeDatasetClip(req, id, id),
    method: "DELETE",
  });
  add(
    `${recording}/segments/${id}/marks`,
    (req) => dataset.postSegmentMark(req, id, id),
    "segment-mark-command.v1",
  );
  add(`${recording}/capture-recipe`, capture, "capture-recipe-select.v1");
  add(
    stageReruns,
    (req) => stages.confirmV2(req, id),
    "stage-rerun-command.v2",
  );
  add(
    `${recording}/stage-reruns`,
    (req) => stages.confirm(req, id),
    "stage-rerun-command.v1",
  );
  add(
    `${recording}/result-selection`,
    (req) => stages.select(req, id),
    "recording-result-selection-command.v1",
  );

  for (const { name, body } of validBodies("job-control-command.v1")) {
    const { jobId } = body as { jobId: string };
    writes.push({
      name,
      path: `/api/v1/jobs/${jobId}/control`,
      handler: (req) => jobs.control(req, jobId),
      method: "POST",
      body,
    });
  }

  const query = t.mock.method(db.app, "query");
  const connect = t.mock.method(db.app, "connect");
  assert.equal(
    (
      await review.decision(
        new Request(origin + decision, { method: "POST" }),
        id,
      )
    ).status,
    401,
  );
  assert.equal(
    (
      await review.decision(
        new Request(origin + decision, {
          method: "POST",
          headers: { cookie: "test=customer" },
        }),
        id,
      )
    ).status,
    404,
  );

  for (const { path, handler, name, method, body } of writes) {
    const response = await handler(
      new Request(origin + path, {
        method,
        headers: { "content-type": "application/json", cookie: "test=staff" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
    const result = await response.json();
    const context = `${method} ${path} (${name})`;
    assert.equal(response.status, 403, `${context}: ${JSON.stringify(result)}`);
    assert.deepEqual(
      result,
      {
        error: {
          code: "forbidden",
          message: "This environment is read-only",
          retryable: false,
        },
        requestId: id,
      },
      context,
    );
    assert.match(response.headers.get("cache-control") ?? "", /no-store/);
    assert.equal(response.headers.get("set-cookie"), "test=refreshed");
  }
  assert.equal(query.mock.callCount(), 0);
  assert.equal(connect.mock.callCount(), 0);
  assert.equal(loadStageDeps.mock.callCount(), 0);

  await t.test(
    "Next rerun adapter denies plans without processing settings",
    async (subtest) => {
      const runtimeKey = Symbol.for("stateaction.auth.runtime");
      const holder = globalThis as {
        [runtimeKey]?: Pick<AuthRuntime, "pool" | "guard" | "ready">;
      };
      const previousRuntime = holder[runtimeKey];
      subtest.after(() => {
        if (previousRuntime) holder[runtimeKey] = previousRuntime;
        else delete holder[runtimeKey];
      });
      holder[runtimeKey] = {
        pool: db.app,
        ready: async () => {},
        guard: {
          trustedOrigins: [origin],
          sessions: async (headers) => {
            const role = headers.get("cookie")?.split("=")[1];
            return {
              session:
                role === "staff" || role === "customer"
                  ? {
                      sessionId: id,
                      userId: role,
                      name: role,
                      email: `${role}@example.test`,
                      expiresAt: new Date("2099-01-01T00:00:00Z"),
                    }
                  : null,
              setCookies: ["test=refreshed"],
            };
          },
          access: {
            grantsFor: async (userId) => [
              {
                role: userId === "staff" ? "staff" : "customer",
                enabled: true,
              },
            ],
          },
        },
      };
      const adapter = stageRerunRouteHandlers();
      const rerunsV1 = `${recording}/stage-reruns`;
      const calls = [
        {
          path: rerunsV1 + "/plan",
          handle: adapter.plan,
          contract: "stage-rerun-plan-request.v1",
          customerStatus: 403,
        },
        {
          path: stageReruns + "/plan",
          handle: adapter.planV2,
          contract: "stage-rerun-plan-request.v2",
          customerStatus: 404,
        },
        {
          path: rerunsV1,
          handle: adapter.confirm,
          contract: "stage-rerun-command.v1",
          customerStatus: 403,
        },
        {
          path: stageReruns,
          handle: adapter.confirmV2,
          contract: "stage-rerun-command.v2",
          customerStatus: 404,
        },
      ];
      for (const { path, handle, contract, customerStatus } of calls) {
        const [{ body }] = validBodies(contract);
        const request = (role?: "staff" | "customer") =>
          new Request(origin + path, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-stateaction-client": "web",
              origin,
              ...(role ? { cookie: `test=${role}` } : {}),
            },
            body: JSON.stringify(body),
          });
        assert.equal((await handle(request(), id)).status, 401, path);
        assert.equal(
          (await handle(request("customer"), id)).status,
          customerStatus,
          path,
        );
        const response = await handle(request("staff"), id);
        assert.equal(response.status, 403, path);
        const result = await response.json();
        assert.deepEqual(
          result.error,
          {
            code: "forbidden",
            message: "This environment is read-only",
            retryable: false,
          },
          path,
        );
        assert.deepEqual(
          Object.keys(result).sort(),
          ["error", "requestId"],
          path,
        );
        assert.match(response.headers.get("cache-control") ?? "", /no-store/);
        assert.equal(response.headers.get("set-cookie"), "test=refreshed");
        assert.equal(query.mock.callCount(), 0, path);
        assert.equal(connect.mock.callCount(), 0, path);
      }
    },
  );

  const readRequest = (path: string) =>
    new Request(origin + path, { headers: { cookie: "test=staff" } });
  assert.equal((await dataset.listDatasets(readRequest(datasets))).status, 200);
  assert.equal(
    (await review.decision(readRequest(decision + "?selection=1"), id)).status,
    404,
  );
  const [{ body: clipRead }] = validBodies("clip-read-create.v1");
  const postRead = await dataset.readClip(
    new Request(origin + `/api/v1/clips/${id}/reads`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: "test=staff" },
      body: JSON.stringify(clipRead),
    }),
    id,
  );
  assert.equal(postRead.status, 404);

  process.env.STATEACTION_HOSTED_DEV_MODE = "allow-writes";
  process.env.DATABASE_URL = `postgresql://stateaction_app:test@${HOSTED_DEV_DATABASE_HOST}/stateaction?sslmode=verify-full`;
  const [{ body: addClip }] = validBodies("clip-review-command.v2");
  const beforeWritable = query.mock.callCount() + connect.mock.callCount();
  const writableDecision = await review.decision(
    new Request(origin + decision, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: "test=staff" },
      body: JSON.stringify(addClip),
    }),
    id,
  );
  assert.equal(writableDecision.status, 404);
  assert.ok(query.mock.callCount() + connect.mock.callCount() > beforeWritable);
});
