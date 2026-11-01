import type { NextConfig } from "next";
const config: NextConfig = {
  poweredByHeader: false,
  agentRules: false,
  transpilePackages: ["@stateaction/contracts", "@stateaction/server"],
  serverExternalPackages: ["pg", "@aws-sdk/client-s3", "@renderinc/sdk"],
  experimental: { cpus: 2 },
};
export default config;
