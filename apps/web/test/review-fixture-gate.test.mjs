import assert from "node:assert/strict";
import { test } from "node:test";
import { fixtureEnabled } from "../lib/review/fixture-gate.ts";

test("fixture data needs an explicit flag and is refused on hosted builds", () => {
  assert.equal(fixtureEnabled({}), false);
  // The SA-96 dev stack is APP_ENV=local: it must read the real stack.
  assert.equal(fixtureEnabled({ APP_ENV: "local" }), false);
  assert.equal(
    fixtureEnabled({ APP_ENV: "local", STATEACTION_REVIEW_DATA: "fixture" }),
    true,
  );
  // A hosted build with APP_ENV unset must not serve fixtures.
  assert.equal(fixtureEnabled({ STATEACTION_REVIEW_DATA: "fixture" }), false);
  for (const hosted of [
    { RENDER: "true" },
    { APP_ENV: "production" },
    { APP_ENV: "staging" },
  ]) {
    assert.equal(
      fixtureEnabled({
        APP_ENV: "local",
        ...hosted,
        STATEACTION_REVIEW_DATA: "fixture",
      }),
      false,
    );
  }
});
