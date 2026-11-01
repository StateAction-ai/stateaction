import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const require = createRequire(new URL("../../package.json", import.meta.url));
const git = (args) => {
  const result = spawnSync("git", args, {
    encoding: "buffer",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0)
    throw new Error(result.stderr.toString() || "Git index read failed");
  return result.stdout;
};
const paths = git([
  "diff",
  "--cached",
  "--name-only",
  "--diff-filter=ACMR",
  "-z",
])
  .toString("utf8")
  .split("\0")
  .filter(Boolean);
const prettier = require.resolve("prettier/bin/prettier.cjs");
// Shared language floor matches package SDK constraints and the CI format target.
const dartFormatLanguageVersion =
  require("./config/mobile-toolchain.json").dartFormatLanguageVersion;
const ruffConfig = fileURLToPath(
  new URL("../../workers/processing/pyproject.toml", import.meta.url),
);
const ruff = fileURLToPath(
  new URL("../../workers/processing/.venv/bin/ruff", import.meta.url),
);
let failed = false;
for (const path of paths) {
  const isPrettier = /\.(?:[cm]?js|jsx|tsx?|json|ya?ml|md|css|html)$/i.test(
    path,
  );
  const isPython = path.endsWith(".py");
  const isDart = path.endsWith(".dart");
  if (!isPrettier && !isPython && !isDart) continue;
  const mode = git(["ls-files", "--stage", "--", path])
    .toString("utf8")
    .slice(0, 6);
  if (mode !== "100644" && mode !== "100755") continue;
  // Read the Git index, never unstaged worktree bytes. No stash or writes occur.
  const staged = git(["cat-file", "blob", `:${path}`]);
  const commands = isPrettier
    ? [[process.execPath, [prettier, "--check", `--stdin-filepath=${path}`]]]
    : isDart
      ? [
          [
            process.env.STATEACTION_DART_BIN || "dart",
            [
              "format",
              "--output=none",
              "--set-exit-if-changed",
              `--language-version=${dartFormatLanguageVersion}`,
              `--stdin-name=${path}`,
            ],
          ],
        ]
      : [
          [
            ruff,
            ["check", "--config", ruffConfig, `--stdin-filename=${path}`, "-"],
          ],
          [
            ruff,
            [
              "format",
              "--check",
              "--config",
              ruffConfig,
              `--stdin-filename=${path}`,
              "-",
            ],
          ],
        ];
  if (isPython && !existsSync(ruff)) {
    console.error(
      "Install Python checks with uv sync --project workers/processing --locked",
    );
    failed = true;
    continue;
  }
  for (const [command, args] of commands) {
    const result = spawnSync(command, args, {
      input: staged,
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    });
    if (result.status !== 0) {
      failed = true;
      console.error(
        `Staged check failed: ${JSON.stringify(path)}\n${result.stdout ?? ""}${result.stderr ?? ""}${result.error?.message ?? ""}${isDart && result.error ? "\nInstall the pinned Flutter SDK and add its bin directory to PATH (or set STATEACTION_DART_BIN)." : ""}`,
      );
    }
  }
}
const whitespace = spawnSync("git", ["diff", "--cached", "--check"], {
  encoding: "utf8",
});
if (whitespace.status !== 0) {
  failed = true;
  console.error(whitespace.stdout || whitespace.stderr);
}
if (failed) {
  console.error(
    "Format the intended content and stage only the intended hunks. The hook changed no files or staged content.",
  );
  process.exitCode = 1;
}
