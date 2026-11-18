// Self-hosts the pinned Rerun web viewer WASM under apps/web/public/rerun/<version>/.
// The directory is generated (git-ignored) and verified against the package's own
// bytes; the viewer is never fetched from a Rerun-hosted origin.
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = "0.41.0";
// SHA-256 of the 0.41.0 npm artifact's re_viewer_bg.wasm (63.8 MB).
const WASM_SHA256 =
  "f2831500e6ca8645fbfc94f4ffff78e62a4eb8d864afd84299f9188b9b577cb2";
const web = fileURLToPath(new URL("../../apps/web/", import.meta.url));
// The package restricts "exports", so locate it through the app's own dependency link.
const pkgDir = join(web, "node_modules", "@rerun-io", "web-viewer");
const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
if (pkg.version !== VERSION)
  throw new Error(
    `Expected @rerun-io/web-viewer ${VERSION}, found ${pkg.version}`,
  );
const source = join(pkgDir, "re_viewer_bg.wasm");
const digest = createHash("sha256").update(readFileSync(source)).digest("hex");
if (digest !== WASM_SHA256)
  throw new Error(`Rerun WASM digest mismatch: ${digest}`);
const target = join(web, "public", "rerun", VERSION);
mkdirSync(target, { recursive: true });
copyFileSync(source, join(target, "re_viewer_bg.wasm"));
console.log(
  `rerun assets: ${VERSION} ${statSync(source).size} bytes sha256 ${digest}`,
);
