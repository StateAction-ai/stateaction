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
};
export default config;
