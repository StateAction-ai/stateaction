import type { NextConfig } from "next";
import { fileURLToPath } from "node:url";
const workspaceRoot = fileURLToPath(new URL("../../", import.meta.url));
// Extra hostnames (e.g. the Tailscale name) allowed to load dev assets. Dev only.
const allowedDevOrigins = (process.env.STATEACTION_DEV_ORIGINS ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const config: NextConfig = {
  poweredByHeader: false,
  outputFileTracingRoot: workspaceRoot,
  turbopack: { root: workspaceRoot },
  agentRules: false,
  allowedDevOrigins,
  transpilePackages: ["@stateaction/contracts", "@stateaction/server"],
  serverExternalPackages: ["pg", "@aws-sdk/client-s3", "@renderinc/sdk"],
  experimental: { cpus: 2 },
  // The viewer package references its 64 MB WASM via new URL(..., import.meta.url).
  // We self-host that file once under /rerun/<version>/ and pass base_url at
  // runtime, so keep the bundler from also emitting a copy per bundle.
  webpack(webpackConfig) {
    webpackConfig.module.rules.push({
      test: /[\\/]@rerun-io[\\/]web-viewer[\\/]index\.js$/,
      parser: { url: false },
    });
    return webpackConfig;
  },
  // Pages and API replies are per-user: never stored by the browser (so Back
  // after sign-out re-requests and re-checks) or by any shared cache.
  async headers() {
    return [
      // Versioned, public, content-addressed viewer asset: cacheable, unlike
      // the per-user pages below.
      {
        source: "/rerun/:version/:file",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=31536000, immutable",
          },
        ],
      },
      {
        source: "/((?!_next/static|_next/image|rerun/).*)",
        headers: [
          { key: "Cache-Control", value: "private, no-store, max-age=0" },
        ],
      },
    ];
  },
};
export default config;
