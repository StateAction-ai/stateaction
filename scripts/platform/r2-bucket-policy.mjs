#!/usr/bin/env node
// Applies config/r2-bucket-policy.json (CORS exact origins, multipart-abort lifecycle) and verifies
// that no bucket is public. Operator-only: needs CLOUDFLARE_API_TOKEN (admin) + CLOUDFLARE_ACCOUNT_ID
// in the environment; the token is never passed to the application or the deploy workflow.
import { readFileSync } from "node:fs";
const policy = JSON.parse(
  readFileSync(
    new URL("../../config/r2-bucket-policy.json", import.meta.url),
    "utf8",
  ),
);
const { CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: account } =
  process.env;
if (!token || !account)
  throw new Error(
    "CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are required",
  );
const base = `https://api.cloudflare.com/client/v4/accounts/${account}/r2/buckets`;
const call = async (method, path, body) => {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const j = await r.json();
  return { ok: j.success === true, result: j.result, errors: j.errors };
};
for (const [bucket, { origins }] of Object.entries(policy.buckets)) {
  if (origins.length) {
    const c = policy.cors;
    const put = await call("PUT", `/${bucket}/cors`, {
      rules: [
        {
          id: "stateaction-web",
          allowed: { origins, methods: c.methods, headers: c.headers },
          exposeHeaders: c.expose,
          maxAgeSeconds: c.maxAgeSeconds,
        },
      ],
    });
    if (!put.ok)
      throw new Error(`${bucket} cors: ${JSON.stringify(put.errors)}`);
  }
  const days = policy.lifecycle.abortIncompleteMultipartDays;
  const existing = await call("GET", `/${bucket}/lifecycle`);
  if (!existing.ok) throw new Error(`${bucket} lifecycle read failed`);
  const others = (existing.result?.rules ?? []).filter(
    (r) =>
      r.id !== "abort-incomplete-multipart" &&
      r.id !== "Default Multipart Abort Rule",
  );
  const lc = await call("PUT", `/${bucket}/lifecycle`, {
    rules: [
      ...others,
      {
        id: "abort-incomplete-multipart",
        enabled: true,
        conditions: { prefix: "" },
        abortMultipartUploadsTransition: {
          condition: { type: "Age", maxAge: days * 86400 },
        },
      },
    ],
  });
  if (!lc.ok)
    throw new Error(`${bucket} lifecycle: ${JSON.stringify(lc.errors)}`);
  const managed = await call("GET", `/${bucket}/domains/managed`);
  const custom = await call("GET", `/${bucket}/domains/custom`);
  if (!managed.ok || !custom.ok)
    throw new Error(`${bucket} public-access check failed`);
  if (managed.result?.enabled || (custom.result?.domains ?? []).length)
    throw new Error(`${bucket} is publicly reachable`);
  const cors = await call("GET", `/${bucket}/cors`);
  console.log(
    `${bucket}: cors origins ${JSON.stringify(cors.result?.rules?.[0]?.allowed?.origins ?? [])}, lifecycle ${days}d abort, managed public domain disabled, custom domains 0`,
  );
}
