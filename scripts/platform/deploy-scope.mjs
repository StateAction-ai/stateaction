#!/usr/bin/env node
// Pure change-scope resolver for per-component Render deploys (SA-161).
// Maps changed paths to Render components (`migrations`, `web`, `cron`, `workflow`),
// diffing per component against live deployed SHAs when available (falling back to
// `before..head` or the single commit tree). Keeps workers/processing (Modal), mobile,
// tests and docs out of automatic Render deploys.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const COMPONENTS = ["migrations", "web", "cron", "workflow"];
const COMPONENT_SET = new Set(COMPONENTS);
const ZERO_SHA = "0".repeat(40);

export const isFullSha = (value) =>
  typeof value === "string" &&
  /^[0-9a-f]{40}$/.test(value) &&
  value !== ZERO_SHA;

const normalizePath = (filePath) =>
  String(filePath).replaceAll("\\", "/").replace(/^\.\//, "");

export function isTestOrDocPath(filePath) {
  const p = normalizePath(filePath);
  if (!p) return true;
  if (/\.md$/i.test(p)) return true;
  if (/(^|\/)README(\.[^/]+)?$/i.test(p)) return true;
  if (
    /^apps\/web\/(test|test-e2e|tests)\//.test(p) ||
    /^packages\/(server|contracts|modal-verifier)\/(test|test-auth|test-integration|test-e2e|tests)\//.test(
      p,
    ) ||
    /^packages\/contracts\/python\/tests\//.test(p) ||
    /^workers\/controller\/(tests|integration)\//.test(p)
  ) {
    return true;
  }
  if (/\.(test|spec)\.[^/]+$/.test(p)) return true;
  if (/(^|\/)(test_[^/]+|[^/]+_test)\.py$/.test(p)) return true;
  return false;
}

const isModuleLock = (p) => /^modules\/[^/]+\/module\.lock\.json$/.test(p);

export function matchesComponent(component, filePath) {
  const p = normalizePath(filePath);
  if (!p) return false;
  if (component === "migrations") {
    if (/\.md$/i.test(p)) return false;
    return (
      p.startsWith("packages/server/migrations/") ||
      p === "packages/server/src/migrations.ts"
    );
  }
  if (component === "web") {
    if (isTestOrDocPath(p)) return false;
    if (
      p.startsWith("packages/server/migrations/") ||
      p.startsWith("packages/server/scripts/") ||
      p === "packages/server/project.json"
    ) {
      return false;
    }
    if (
      p.startsWith("packages/contracts/python/") ||
      p.startsWith("packages/contracts/dart/") ||
      p.startsWith("packages/contracts/capture/") ||
      p.startsWith("packages/contracts/capture-mobile/") ||
      p.startsWith("packages/contracts/conformance/") ||
      p === "packages/contracts/project.json"
    ) {
      return false;
    }
    return (
      p.startsWith("apps/web/") ||
      p.startsWith("packages/server/") ||
      p.startsWith("packages/contracts/") ||
      p.startsWith("recipes/compiled/") ||
      p.startsWith("examples/compiled/") ||
      isModuleLock(p) ||
      p === "scripts/platform/web.mjs" ||
      p === "scripts/platform/rerun-assets.mjs" ||
      p === "package.json" ||
      p === "pnpm-lock.yaml" ||
      p === "pnpm-workspace.yaml" ||
      p === "config/typescript.base.json"
    );
  }
  if (component === "cron") {
    if (isTestOrDocPath(p)) return false;
    if (p === "workers/controller/project.json") return false;
    return (
      p.startsWith("workers/controller/") ||
      p.startsWith("packages/contracts/python/") ||
      p.startsWith("packages/contracts/api/")
    );
  }
  if (component === "workflow") {
    if (isTestOrDocPath(p)) return false;
    if (
      p === "workers/controller/project.json" ||
      p === "packages/modal-verifier/project.json"
    ) {
      return false;
    }
    return (
      p.startsWith("workers/controller/") ||
      p.startsWith("packages/contracts/python/") ||
      p.startsWith("packages/contracts/api/") ||
      p.startsWith("packages/contracts/recipe/") ||
      p.startsWith("packages/modal-verifier/") ||
      isModuleLock(p)
    );
  }
  throw new Error(`unknown component: ${component}`);
}

export function parseComponents(spec) {
  const raw = (spec ?? "auto").trim().toLowerCase();
  if (!raw || raw === "auto") return { mode: "auto", components: [] };
  if (raw === "all") return { mode: "explicit", components: [...COMPONENTS] };
  if (raw === "none") return { mode: "explicit", components: [] };
  const chosen = new Set();
  for (const token of raw.split(",")) {
    const name = token.trim();
    if (!name || !COMPONENT_SET.has(name)) {
      throw new Error(
        `unknown component "${name || raw}" (expected auto, all, none, or comma-separated ${COMPONENTS.join(",")})`,
      );
    }
    chosen.add(name);
  }
  return {
    mode: "explicit",
    components: COMPONENTS.filter((c) => chosen.has(c)),
  };
}

export function resolveDeployPlan({
  requested = "auto",
  head,
  fallbackBase,
  liveRefs = {},
  isAncestor,
  listChangedFiles,
  listCommitFiles,
}) {
  if (!isFullSha(head)) {
    throw new Error(`head must be a full non-zero 40-hex commit SHA`);
  }
  const parsed = parseComponents(requested);
  if (parsed.mode === "explicit") {
    const selected = new Set(parsed.components);
    const details = Object.fromEntries(
      COMPONENTS.map((c) => [
        c,
        {
          selected: selected.has(c),
          baseRef: null,
          baseSource: "explicit",
          reason: selected.has(c) ? "explicit" : "not-requested",
          matchedFiles: [],
        },
      ]),
    );
    return {
      mode: "explicit",
      head,
      components: parsed.components,
      details,
    };
  }

  const diffCache = new Map();
  const filesSince = (baseRef) => {
    if (!diffCache.has(baseRef)) {
      diffCache.set(baseRef, listChangedFiles(baseRef, head));
    }
    return diffCache.get(baseRef);
  };
  let commitFilesCache;
  const filesInHead = () => {
    if (commitFilesCache === undefined) {
      commitFilesCache = listCommitFiles(head);
    }
    return commitFilesCache;
  };

  const validFallback =
    isFullSha(fallbackBase) &&
    (fallbackBase === head || isAncestor(fallbackBase, head))
      ? fallbackBase
      : null;

  const details = {};
  for (const component of COMPONENTS) {
    // Database schema migrations track the live web/server deployment commit.
    const liveCandidate =
      component === "migrations" ? liveRefs.web : liveRefs[component];
    let baseRef = null;
    let baseSource = "commit-only";
    if (isFullSha(liveCandidate)) {
      if (liveCandidate === head) {
        details[component] = {
          selected: false,
          baseRef: liveCandidate,
          baseSource: "live",
          reason: "already-live",
          matchedFiles: [],
        };
        continue;
      }
      if (isAncestor(liveCandidate, head)) {
        baseRef = liveCandidate;
        baseSource = "live";
      }
    }
    if (!baseRef && validFallback) {
      if (validFallback === head) {
        details[component] = {
          selected: false,
          baseRef: validFallback,
          baseSource: "fallback",
          reason: "same-commit",
          matchedFiles: [],
        };
        continue;
      }
      baseRef = validFallback;
      baseSource = "fallback";
    }

    const changed = baseRef ? filesSince(baseRef) : filesInHead();
    const matchedFiles = changed.filter((f) => matchesComponent(component, f));
    details[component] = {
      selected: matchedFiles.length > 0,
      baseRef,
      baseSource,
      reason: matchedFiles.length > 0 ? "changed" : "unchanged",
      matchedFiles,
    };
  }

  return {
    mode: "auto",
    head,
    components: COMPONENTS.filter((c) => details[c].selected),
    details,
  };
}

function git(args, cwd) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(
      `git ${args.slice(0, 3).join(" ")} failed (${r.status}): ${(r.stderr || r.stdout || "").trim().slice(0, 300)}`,
    );
  }
  return r.stdout;
}

export function gitHelpers(cwd = process.cwd()) {
  return {
    isAncestor: (base, head) =>
      spawnSync("git", ["merge-base", "--is-ancestor", base, head], {
        cwd,
        encoding: "utf8",
      }).status === 0,
    listChangedFiles: (base, head) =>
      git(["diff", "--name-only", base, head], cwd)
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean),
    listCommitFiles: (head) =>
      git(
        [
          "diff-tree",
          "--root",
          "--no-commit-id",
          "--name-only",
          "-r",
          "-m",
          "--first-parent",
          head,
        ],
        cwd,
      )
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean),
  };
}

function loadLiveRefs(arg) {
  if (!arg) return {};
  const trimmed = arg.trim();
  if (!trimmed) return {};
  const text = trimmed.startsWith("{")
    ? trimmed
    : readFileSync(trimmed, "utf8");
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("live-refs must be a JSON object");
  }
  return parsed;
}

function main() {
  const flag = (name, def) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > 1 ? process.argv[i + 1] : def;
  };
  const head = flag("head", process.env.GITHUB_SHA);
  const fallbackBase = flag("base", "");
  const requested = flag("components", "auto");
  const liveRefs = loadLiveRefs(flag("live-refs", ""));
  const format = flag("format", "json");
  const plan = resolveDeployPlan({
    requested,
    head,
    fallbackBase,
    liveRefs,
    ...gitHelpers(process.cwd()),
  });
  if (format === "csv") {
    console.log(plan.components.join(","));
    return;
  }
  if (format === "github-output") {
    const set = new Set(plan.components);
    console.log(`components=${plan.components.join(",")}`);
    console.log(`has_components=${plan.components.length > 0}`);
    for (const c of COMPONENTS) {
      console.log(`has_${c}=${set.has(c)}`);
    }
    return;
  }
  if (format === "json") {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }
  throw new Error(`unknown format "${format}"`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (e) {
    console.error(`deploy-scope: ${e.message}`);
    process.exit(1);
  }
}
