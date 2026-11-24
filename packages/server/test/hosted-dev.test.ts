import assert from "node:assert/strict";
import { test } from "node:test";
import { applicationDatabaseUrl } from "../src/config.js";
import {
  HOSTED_DEV_DATABASE_HOST,
  hostedDevProfile,
} from "../src/hosted-dev.js";

const db = (user: string) =>
  `postgresql://${user}:test@${HOSTED_DEV_DATABASE_HOST}/stateaction?sslmode=verify-full`;
const profile = {
  STATEACTION_HOSTED_DEV_MODE: "read-only",
  NODE_ENV: "development",
  APP_ENV: "development",
  DATABASE_URL: db("stateaction_dev_reader"),
  STATEACTION_HOSTED_DEV_AUTH_DATABASE_URL:
    "postgresql://stateaction_app:test@127.0.0.1/local",
  STATEACTION_WEB_HOST: "127.0.0.1",
  BETTER_AUTH_URL: "http://127.0.0.1:3008",
  AUTH_LOCAL_PASSWORD: "true",
  S3_BUCKET: "stateaction-prod",
};

test("hosted development requires explicit mode and a separate local auth database", () => {
  assert.equal(hostedDevProfile(profile)?.mode, "read-only");
  for (const extra of [
    { DATABASE_URL: db("stateaction_app") },
    { STATEACTION_HOSTED_DEV_AUTH_DATABASE_URL: db("stateaction_app") },
    { STATEACTION_WEB_HOST: "0.0.0.0" },
    { RENDER: "true" },
    { CI: "true" },
    { NODE_ENV: "production" },
    { S3_BUCKET: "stateaction-stage" },
  ])
    assert.throws(() => hostedDevProfile({ ...profile, ...extra }));
  assert.throws(() =>
    applicationDatabaseUrl({
      APP_ENV: "development",
      DATABASE_URL: db("stateaction_app"),
    }),
  );
  assert.equal(
    hostedDevProfile({
      ...profile,
      STATEACTION_HOSTED_DEV_MODE: "allow-writes",
      DATABASE_URL: db("stateaction_app"),
    })?.mode,
    "allow-writes",
  );
});
