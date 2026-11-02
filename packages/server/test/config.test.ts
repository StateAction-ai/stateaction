import assert from "node:assert/strict";
import test from "node:test";
import { applicationDatabaseUrl, serverConfig } from "../src/config.js";
const local = {
  APP_ENV: "local",
  DATABASE_URL: "postgresql://u:p@127.0.0.1:54329/db",
  S3_ENDPOINT: "http://127.0.0.1:9000",
  S3_REGION: "us-east-1",
  S3_BUCKET: "stateaction-local",
  S3_ACCESS_KEY_ID: "stateaction-local",
  S3_SECRET_ACCESS_KEY: "stateaction-local-only-secret",
};
const hosted = {
  APP_ENV: "production",
  DATABASE_HOST: "dpg-abc",
  DATABASE_NAME: "stateaction",
  APP_DB_PASSWORD: "p@ss/w:rd",
  S3_ENDPOINT: "https://acct.r2.cloudflarestorage.com",
  S3_REGION: "auto",
  S3_BUCKET: "stateaction-prod",
  S3_ACCESS_KEY_ID: "real-looking-key",
  S3_SECRET_ACCESS_KEY: "real-looking-secret",
};
test("local config defaults the signing origin to the endpoint", () => {
  assert.equal(serverConfig(local).publicEndpoint, "http://127.0.0.1:9000");
  assert.equal(
    serverConfig({ ...local, S3_PUBLIC_ENDPOINT: "http://localhost:9000" })
      .publicEndpoint,
    "http://localhost:9000",
  );
});
test("local environment refuses hosted R2 and non-loopback databases", () => {
  assert.throws(
    () =>
      serverConfig({
        ...local,
        S3_ENDPOINT: hosted.S3_ENDPOINT,
        S3_PUBLIC_ENDPOINT: hosted.S3_ENDPOINT,
      }),
    /loopback|R2/,
  );
  assert.throws(
    () =>
      serverConfig({ ...local, DATABASE_URL: "postgresql://x@db.example/x" }),
    /loopback/,
  );
});
test("production builds the restricted-role URL and rejects mixed settings", () => {
  const config = serverConfig(hosted);
  const url = new URL(config.databaseUrl);
  assert.equal(url.username, "stateaction_app");
  assert.equal(decodeURIComponent(url.password), "p@ss/w:rd");
  assert.equal(url.hostname, "dpg-abc");
  for (const [patch, pattern] of [
    [{ S3_ENDPOINT: "http://127.0.0.1:9000" }, /HTTPS Cloudflare R2/],
    [{ S3_ACCESS_KEY_ID: "stateaction-local" }, /example credentials/],
    [{ S3_BUCKET: "stateaction-dev" }, /development bucket/],
    [{ DATABASE_HOST: "127.0.0.1" }, /loopback/],
    [{ S3_PUBLIC_ENDPOINT: "http://phone.example:9000" }, /HTTPS/],
  ] as const)
    assert.throws(() => serverConfig({ ...hosted, ...patch }), pattern);
});
test("development uses real R2 but may use a local database", () => {
  const config = serverConfig({
    ...hosted,
    APP_ENV: "development",
    S3_BUCKET: "stateaction-dev",
    DATABASE_URL: "postgresql://u:p@127.0.0.1:5432/db",
  });
  assert.equal(config.appEnv, "development");
});
test("a missing application password never falls back to an owner URL", () => {
  assert.throws(
    () => applicationDatabaseUrl({ DATABASE_HOST: "h", DATABASE_NAME: "n" }),
    /APP_DB_PASSWORD/,
  );
});
test("production rejects owner DSNs and accepts only the restricted app role", () => {
  const owner = {
    ...hosted,
    DATABASE_URL: "postgresql://owner:pw@dpg-abc/stateaction",
  };
  assert.throws(() => serverConfig(owner), /restricted stateaction_app/);
  assert.throws(
    () => serverConfig({ ...hosted, DATABASE_URL: "not a url" }),
    /not a valid URL/,
  );
  const app = serverConfig({
    ...hosted,
    DATABASE_URL: "postgresql://stateaction_app:pw@dpg-abc/stateaction",
  });
  assert.equal(new URL(app.databaseUrl).username, "stateaction_app");
});
test("outside local the public presigning origin must equal the private R2 origin", () => {
  for (const appEnv of ["production", "development"] as const)
    for (const publicEndpoint of [
      "https://evil.example.com",
      "https://other.r2.cloudflarestorage.com",
      "https://acct.r2.cloudflarestorage.com:8443",
    ])
      assert.throws(
        () =>
          serverConfig({
            ...hosted,
            APP_ENV: appEnv,
            S3_BUCKET:
              appEnv === "production" ? "stateaction-prod" : "stateaction-dev",
            S3_PUBLIC_ENDPOINT: publicEndpoint,
          }),
        /must equal the private R2/,
      );
  assert.equal(
    serverConfig({ ...hosted, S3_PUBLIC_ENDPOINT: hosted.S3_ENDPOINT })
      .publicEndpoint,
    hosted.S3_ENDPOINT,
  );
  // TLS hostname validation: a non-R2 host fails even when public == endpoint.
  assert.throws(
    () =>
      serverConfig({
        ...hosted,
        S3_ENDPOINT: "https://evil.example.com",
        S3_PUBLIC_ENDPOINT: "https://evil.example.com",
      }),
    /HTTPS Cloudflare R2/,
  );
});
