import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  COMPONENTS,
  isFullSha,
  isTestOrDocPath,
  matchesComponent,
  parseComponents,
  resolveDeployPlan,
} from "./deploy-scope.mjs";

const sha = (c) => c.repeat(40);
const HEAD = sha("a");
const BASE = sha("b");
const LIVE_WEB = sha("c");
const LIVE_CRON = sha("d");
const LIVE_WF = sha("e");

test("parseComponents handles auto, all, none, canonical ordering and rejects unknown names", () => {
  assert.deepEqual(parseComponents(undefined), {
    mode: "auto",
    components: [],
  });
  assert.deepEqual(parseComponents("auto"), { mode: "auto", components: [] });
  assert.deepEqual(parseComponents("all"), {
    mode: "explicit",
    components: COMPONENTS,
  });
  assert.deepEqual(parseComponents("none"), {
    mode: "explicit",
    components: [],
  });
  assert.deepEqual(parseComponents("workflow, web, migrations, web"), {
    mode: "explicit",
    components: ["migrations", "web", "workflow"],
  });
  assert.throws(() => parseComponents("processing"), /unknown component/);
  assert.throws(() => parseComponents("web,"), /unknown component/);
});

test("isFullSha rejects non-hex, short strings and all-zero SHAs", () => {
  assert.equal(isFullSha(HEAD), true);
  assert.equal(isFullSha("0".repeat(40)), false);
  assert.equal(isFullSha("abc123"), false);
  assert.equal(isFullSha("g".repeat(40)), false);
  assert.equal(isFullSha(null), false);
});

test("path matching isolates web, migrations, cron, workflow and ignores processing, mobile, tests and docs", () => {
  // Pure web/server runtime files -> web only.
  for (const p of [
    "apps/web/app/page.tsx",
    "apps/web/app/_research/research-clip.tsx",
    "packages/server/src/http/health.ts",
    "packages/contracts/src/index.ts",
    "recipes/compiled/default-flora.json",
    "examples/compiled/cpu-hand-pose.json",
    "scripts/platform/web.mjs",
    "scripts/platform/rerun-assets.mjs",
    "pnpm-lock.yaml",
    "package.json",
  ]) {
    assert.equal(matchesComponent("web", p), true, p);
    assert.equal(matchesComponent("migrations", p), false, p);
    assert.equal(matchesComponent("cron", p), false, p);
    assert.equal(matchesComponent("workflow", p), false, p);
  }

  // SQL migration only -> migrations only (not web/cron/workflow).
  assert.equal(
    matchesComponent(
      "migrations",
      "packages/server/migrations/026_add_idx.sql",
    ),
    true,
  );
  assert.equal(
    matchesComponent("web", "packages/server/migrations/026_add_idx.sql"),
    false,
  );

  // Migration runner code -> both migrations and web (migrations ordered first).
  assert.equal(
    matchesComponent("migrations", "packages/server/src/migrations.ts"),
    true,
  );
  assert.equal(
    matchesComponent("web", "packages/server/src/migrations.ts"),
    true,
  );

  // Controller runtime and Python contracts -> cron and workflow only (not web).
  for (const p of [
    "workers/controller/src/stateaction_controller/workflow.py",
    "workers/controller/src/stateaction_controller/repair.py",
    "workers/controller/pyproject.toml",
    "workers/controller/uv.lock",
    "packages/contracts/python/src/stateaction_contracts/validate.py",
  ]) {
    assert.equal(matchesComponent("cron", p), true, p);
    assert.equal(matchesComponent("workflow", p), true, p);
    assert.equal(matchesComponent("web", p), false, p);
    assert.equal(matchesComponent("migrations", p), false, p);
  }

  // Shared API contracts -> web, cron, and workflow.
  assert.equal(
    matchesComponent("web", "packages/contracts/api/job-status.schema.json"),
    true,
  );
  assert.equal(
    matchesComponent("cron", "packages/contracts/api/job-status.schema.json"),
    true,
  );
  assert.equal(
    matchesComponent(
      "workflow",
      "packages/contracts/api/job-status.schema.json",
    ),
    true,
  );

  // Recipe schema and module locks -> web and workflow (not cron).
  for (const p of [
    "packages/contracts/recipe/compiled-graph.v1.schema.json",
    "modules/hand_pose/module.lock.json",
  ]) {
    assert.equal(matchesComponent("web", p), true, p);
    assert.equal(matchesComponent("workflow", p), true, p);
    assert.equal(matchesComponent("cron", p), false, p);
    assert.equal(matchesComponent("migrations", p), false, p);
  }

  // Modal verifier -> workflow only.
  assert.equal(
    matchesComponent(
      "workflow",
      "packages/modal-verifier/src/stateaction_modal_verifier/verify.py",
    ),
    true,
  );
  assert.equal(
    matchesComponent(
      "web",
      "packages/modal-verifier/src/stateaction_modal_verifier/verify.py",
    ),
    false,
  );
  assert.equal(
    matchesComponent(
      "cron",
      "packages/modal-verifier/src/stateaction_modal_verifier/verify.py",
    ),
    false,
  );

  // Processing (Modal), mobile, Dart/capture contracts, docs, workflows, tests -> zero Render components.
  for (const p of [
    "workers/processing/modal_app.py",
    "workers/processing/src/stateaction_processing/hand_pose.py",
    "workers/flora/src/runner.py",
    "apps/mobile/lib/main.dart",
    "packages/contracts/dart/lib/contracts.dart",
    "packages/contracts/capture/golden/valid.mcap",
    "packages/contracts/capture-mobile/schema.json",
    "packages/contracts/conformance/fixture.json",
    "packages/contracts/python/tests/test_validate.py",
    "packages/modal-verifier/tests/test_verify.py",
    "packages/modal-verifier/project.json",
    "packages/server/scripts/catalog-integration.sh",
    "packages/server/project.json",
    "docs/components/render-deployment.md",
    "apps/web/README.md",
    "apps/web/test/page.test.mjs",
    "apps/web/test-e2e/recipe.e2e.test.mjs",
    "packages/server/test/auth.test.ts",
    "packages/server/test-integration/migrations.test.ts",
    "workers/controller/tests/test_repair.py",
    "workers/controller/integration/test_loopback.py",
    "workers/controller/README.md",
    "workers/controller/project.json",
    ".github/workflows/deploy.yml",
    "render.yaml",
    "scripts/local-ci/local_ci.py",
  ]) {
    for (const c of COMPONENTS) {
      assert.equal(matchesComponent(c, p), false, `${c} should not match ${p}`);
    }
  }
  assert.equal(isTestOrDocPath("apps/web/app/foo.test.tsx"), true);
});

test("resolveDeployPlan diffs per component against live deployed SHAs and orders migrations before web", () => {
  const calls = [];
  const filesByBase = {
    [LIVE_WEB]: [
      "packages/server/migrations/026_test.sql",
      "apps/web/app/page.tsx",
    ],
    [LIVE_CRON]: ["docs/notes.md"],
    [LIVE_WF]: ["workers/controller/src/stateaction_controller/workflow.py"],
  };
  const plan = resolveDeployPlan({
    requested: "auto",
    head: HEAD,
    fallbackBase: BASE,
    liveRefs: { web: LIVE_WEB, cron: LIVE_CRON, workflow: LIVE_WF },
    isAncestor: () => true,
    listChangedFiles: (base) => {
      calls.push(base);
      return filesByBase[base] ?? [];
    },
    listCommitFiles: () => {
      throw new Error("should not fall back to commit-only");
    },
  });
  assert.deepEqual(plan.components, ["migrations", "web", "workflow"]);
  assert.equal(plan.details.migrations.baseRef, LIVE_WEB);
  assert.equal(plan.details.migrations.baseSource, "live");
  assert.equal(plan.details.web.baseRef, LIVE_WEB);
  assert.equal(plan.details.cron.selected, false);
  assert.equal(plan.details.workflow.selected, true);
  // LIVE_WEB is shared by migrations and web and must only be diffed once.
  assert.equal(calls.filter((b) => b === LIVE_WEB).length, 1);
});

test("resolveDeployPlan skips services already live at head and falls back cleanly when live ref is missing or diverged", () => {
  const plan = resolveDeployPlan({
    requested: "auto",
    head: HEAD,
    fallbackBase: BASE,
    liveRefs: { web: HEAD, cron: sha("9"), workflow: null },
    isAncestor: (base) => base === BASE,
    listChangedFiles: (base) => {
      assert.equal(base, BASE);
      return ["workers/controller/src/stateaction_controller/repair.py"];
    },
    listCommitFiles: () => [],
  });
  assert.deepEqual(plan.components, ["cron", "workflow"]);
  assert.equal(plan.details.web.reason, "already-live");
  assert.equal(plan.details.migrations.reason, "already-live");
  assert.equal(plan.details.cron.baseSource, "fallback");
  assert.equal(plan.details.workflow.baseSource, "fallback");
});

test("resolveDeployPlan falls back to single commit files when both liveRefs and fallbackBase are unavailable", () => {
  const plan = resolveDeployPlan({
    requested: "auto",
    head: HEAD,
    fallbackBase: "0".repeat(40),
    liveRefs: {},
    isAncestor: () => false,
    listChangedFiles: () => {
      throw new Error("no range diff expected");
    },
    listCommitFiles: () => ["apps/web/app/page.tsx"],
  });
  assert.deepEqual(plan.components, ["web"]);
  assert.equal(plan.details.web.baseSource, "commit-only");
});

test("resolveDeployPlan honors explicit component selection without invoking git", () => {
  const plan = resolveDeployPlan({
    requested: "web",
    head: HEAD,
    isAncestor: () => {
      throw new Error("no git call expected");
    },
    listChangedFiles: () => {
      throw new Error("no git call expected");
    },
    listCommitFiles: () => {
      throw new Error("no git call expected");
    },
  });
  assert.deepEqual(plan.components, ["web"]);
  assert.equal(plan.details.web.reason, "explicit");
  assert.equal(plan.details.cron.selected, false);
});

test("CLI runs against a real git repo including root commit fallback and live-refs catch-up", () => {
  const dir = mkdtempSync(join(tmpdir(), "deploy-scope-"));
  const script = fileURLToPath(new URL("./deploy-scope.mjs", import.meta.url));
  const git = (args) => {
    const r = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  try {
    git(["init"]);
    git(["config", "user.email", "test@example.com"]);
    git(["config", "user.name", "Test"]);
    spawnSync("mkdir", ["-p", join(dir, "apps/web/app")]);
    writeFileSync(
      join(dir, "apps/web/app/layout.tsx"),
      "export default () => null;\n",
    );
    git(["add", "."]);
    git(["commit", "-m", "root web commit"]);
    const c1 = git(["rev-parse", "HEAD"]);

    // Root commit with zero fallbackBase must still detect files via --root.
    const rRoot = spawnSync(
      process.execPath,
      [script, "--head", c1, "--base", "0".repeat(40), "--format", "csv"],
      { cwd: dir, encoding: "utf8" },
    );
    assert.equal(rRoot.status, 0, rRoot.stderr);
    assert.equal(rRoot.stdout.trim(), "web");

    writeFileSync(
      join(dir, "apps/web/app/page.tsx"),
      "export default () => null;\n",
    );
    git(["add", "."]);
    git(["commit", "-m", "web change"]);
    const c2 = git(["rev-parse", "HEAD"]);

    writeFileSync(join(dir, "README.md"), "docs update\n");
    git(["add", "."]);
    git(["commit", "-m", "docs only"]);
    const c3 = git(["rev-parse", "HEAD"]);

    // Docs-only push c2..c3 selects nothing.
    const rDocs = spawnSync(
      process.execPath,
      [script, "--head", c3, "--base", c2, "--format", "github-output"],
      { cwd: dir, encoding: "utf8" },
    );
    assert.equal(rDocs.status, 0, rDocs.stderr);
    assert.match(rDocs.stdout, /^components=$/m);
    assert.match(rDocs.stdout, /^has_components=false$/m);

    // Live web stuck at c1 -> catches up web change from c2 even on c3.
    const liveFile = join(dir, "live.json");
    writeFileSync(
      liveFile,
      JSON.stringify({ web: c1, cron: c3, workflow: c3 }),
    );
    const rCatchup = spawnSync(
      process.execPath,
      [
        script,
        "--head",
        c3,
        "--base",
        c2,
        "--live-refs",
        liveFile,
        "--format",
        "csv",
      ],
      { cwd: dir, encoding: "utf8" },
    );
    assert.equal(rCatchup.status, 0, rCatchup.stderr);
    assert.equal(rCatchup.stdout.trim(), "web");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
