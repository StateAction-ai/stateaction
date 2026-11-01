import type { NextConfig } from "next";
import { fileURLToPath } from "node:url";
const workspaceRoot = fileURLToPath(new URL("../../", import.meta.url));
const config: NextConfig = {
  poweredByHeader: false,
  outputFileTracingRoot: workspaceRoot,
  turbopack: { root: workspaceRoot },
  agentRules: false,
  transpilePackages: ["@stateaction/contracts", "@stateaction/server"],
  serverExternalPackages: ["pg", "@aws-sdk/client-s3", "@renderinc/sdk"],
  experimental: { cpus: 2 },
};
export default config;
