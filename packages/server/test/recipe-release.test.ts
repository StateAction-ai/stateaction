import assert from "node:assert/strict";
import { test } from "node:test";
import { readCompiledRecipe, requestSha256 } from "@stateaction/contracts";
import rawCanary from "../../../recipes/compiled/cpu_hand_canary.json" with { type: "json" };
import planLock from "../../../modules/clip_filter_passthrough/module.lock.json" with { type: "json" };
import handLock from "../../../modules/hand_pose_cpu/module.lock.json" with { type: "json" };
import videoLock from "../../../modules/recording_mp4_remux/module.lock.json" with { type: "json" };
import {
  CPU_CANARY_RECIPE_REF,
  DEFAULT_RECIPE_REF,
  publishedRecipe,
} from "../src/jobs/recipe-release.js";

test("the published CPU recipe declares fan-out, original video and a renamed CPU-only leaf", () => {
  const graph = publishedRecipe(CPU_CANARY_RECIPE_REF);
  assert.ok(graph);
  assert.equal(graph.fanOut?.clip, "source_span.plan");
  assert.deepEqual(graph.nodes.original_video?.outputs, {
    video: "review_video@1",
  });
  assert.deepEqual(graph.nodes.track_hands?.producers, ["source_span"]);
  assert.ok(
    Object.values(graph.nodes).every(({ resources }) => resources.gpu === null),
  );
  assert.equal(publishedRecipe("indego_hosted_canary@1"), undefined);
  assert.equal(publishedRecipe("unpublished@1"), undefined);
});

test("the published default preserves the existing clip-stage resource budgets", () => {
  const graph = publishedRecipe(DEFAULT_RECIPE_REF);
  assert.ok(graph);
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(graph.nodes)
        .filter(([, node]) => node.scope === "clip")
        .map(([nodeId, { resources }]) => [
          nodeId,
          [resources.gpu, resources.budget.fixedSeconds],
        ]),
    ),
    {
      segment: ["RTX-PRO-6000", 800],
      caption: ["RTX-PRO-6000", 1300],
      hand_pose: [null, 1100],
    },
  );
  assert.equal(graph.meta.limits.maxClipJobCostUsd, "3.00");
});

test("admission graph validation rejects unreviewed edits, replaced locks and malformed graphs", () => {
  const locks = new Map([
    ["clip_filter_passthrough@1", planLock],
    ["hand_pose_cpu@1", handLock],
    ["recording_mp4_remux@1", videoLock],
  ]);
  const { recipeSha256, authoring, ...body } = rawCanary;
  const changed = { ...body, meta: { ...body.meta, title: "Unreviewed" } };
  const altered = {
    ...changed,
    authoring,
    recipeSha256: requestSha256(changed),
  };
  assert.throws(
    () => readCompiledRecipe(altered, rawCanary.recipe, recipeSha256, locks),
    /identity mismatch/,
  );
  assert.throws(
    () =>
      readCompiledRecipe(
        rawCanary,
        rawCanary.recipe,
        recipeSha256,
        new Map([...locks, ["hand_pose_cpu@1", planLock]]),
      ),
    /module lock mismatch/,
  );
  assert.throws(
    () =>
      readCompiledRecipe(
        { ...rawCanary, extra: true },
        rawCanary.recipe,
        recipeSha256,
        locks,
      ),
    /invalid compiled recipe schema/i,
  );
});

test("graph admission refuses an absent binding, drift and a cost bound violation", async () => {
  const { resolveGraphRuntime } = await import(
    "../src/jobs/graph-admission.js"
  );
  const graph = publishedRecipe(CPU_CANARY_RECIPE_REF)!;
  const codeRevision = "a".repeat(40);
  const bindings = new Map(
    Object.values(graph.nodes).map((node) => [
      node.module,
      {
        mode: "local_cpu" as const,
        definitionFormat: "local" as const,
        moduleLockSha256: node.moduleLockSha256,
        paramsSha256: requestSha256(node.params),
        codeRevision,
        imageSha256: "a".repeat(64),
        definitionSha256: "b".repeat(64),
        gpu: null,
        maxContainers: 1 as const,
        maxBilledSeconds: 120,
        microUsdPerCpuSecond: 0,
        microUsdPerGpuSecond: 0,
      },
    ]),
  );
  const input = {
    graph,
    scope: "recording" as const,
    sourceSeconds: 1,
    executionBackend: "local" as const,
    codeRevision,
    bindings,
  };
  assert.equal(Object.keys(resolveGraphRuntime(input)).length, 3);
  assert.throws(
    () => resolveGraphRuntime({ ...input, bindings: new Map() }),
    /deployment_binding_unavailable/,
  );
  assert.throws(
    () => resolveGraphRuntime({ ...input, codeRevision: "c".repeat(40) }),
    /deployment_binding_unavailable/,
  );
  const bound = bindings.get("hand_pose_cpu@1")!;
  bindings.set("hand_pose_cpu@1", { ...bound, microUsdPerCpuSecond: 999999 });
  assert.throws(() => resolveGraphRuntime(input), /recipe_cost_bound_exceeded/);
});
