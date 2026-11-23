import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { requestSha256 } from "@stateaction/contracts";
import { jobsConfigFromEnv } from "../src/jobs/config.js";
import { localRecipeDir, withLocalRecipes } from "../src/jobs/local-recipe.js";

const settings = {
  PROCESSING_EXECUTION_BACKEND: "local",
  PROCESSING_CODE_REVISION: "testing",
  PROCESSING_IMAGE_SPEC_SHA256: "0".repeat(64),
  PROCESSING_MODEL_SHA256: "1".repeat(64),
  PROCESSING_CONFIG_SHA256: "2".repeat(64),
};
const DIR = "/tmp/recipes";

test("the local recipe directory is accepted only with APP_ENV=local", () => {
  assert.equal(localRecipeDir({ APP_ENV: "local" }), undefined);
  assert.equal(
    localRecipeDir({ APP_ENV: "local", STATEACTION_LOCAL_RECIPE_DIR: DIR }),
    DIR,
  );
  for (const appEnv of ["production", "staging", "development", "", undefined])
    assert.throws(
      () =>
        localRecipeDir({ APP_ENV: appEnv, STATEACTION_LOCAL_RECIPE_DIR: DIR }),
      /STATEACTION_LOCAL_RECIPE_DIR is refused/,
      String(appEnv),
    );
  // A Render-hosted deployment is refused even when APP_ENV is spoofed to local.
  assert.throws(
    () =>
      localRecipeDir({
        APP_ENV: "local",
        STATEACTION_LOCAL_RECIPE_DIR: DIR,
        RENDER_SERVICE_ID: "srv-x",
      }),
    /refused/,
  );
  assert.throws(
    () =>
      localRecipeDir({
        APP_ENV: "local",
        STATEACTION_LOCAL_RECIPE_DIR: "relative/dir",
      }),
    /absolute/,
  );
});

test("job configuration refuses to start with the override outside local and carries it in local", () => {
  assert.throws(
    () =>
      jobsConfigFromEnv({
        ...settings,
        APP_ENV: "production",
        STATEACTION_LOCAL_RECIPE_DIR: DIR,
      }),
    /refused/,
  );
  assert.equal(jobsConfigFromEnv(settings).localRecipeDir, undefined);
  assert.equal(
    jobsConfigFromEnv({
      ...settings,
      APP_ENV: "local",
      STATEACTION_LOCAL_RECIPE_DIR: DIR,
    }).localRecipeDir,
    DIR,
  );
});

test("admission reads one recipe file per recording id and leaves other recordings on the v2 input", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sa96-recipes-"));
  try {
    const withFile = "3f1b8c2e-6a4d-4e7b-9c1a-2b5d8e9f0a11";
    const other = "4f1b8c2e-6a4d-4e7b-9c1a-2b5d8e9f0a22";
    const bad = "5f1b8c2e-6a4d-4e7b-9c1a-2b5d8e9f0a33";
    const recipe = { schemaVersion: 1, recipeId: "x@1", stages: [] };
    writeFileSync(join(dir, `${withFile}.json`), JSON.stringify(recipe));
    writeFileSync(join(dir, `${bad}.json`), "{not json");
    const build = withLocalRecipes(
      async () => ({ schemaVersion: 2, marker: "base" }),
      dir,
    );
    const job = (recordingId: string) => ({
      jobId: "j",
      recordingId,
      profileRevision: "p",
      sourceManifestSha256: "0".repeat(64),
    });
    const q = undefined as never;
    assert.deepEqual(await build(q, job(withFile)), {
      schemaVersion: 3,
      marker: "base",
      recipe,
      recipeSha256: requestSha256(recipe),
    });
    assert.deepEqual(await build(q, job(other)), {
      schemaVersion: 2,
      marker: "base",
    });
    // A malformed file never runs without its recipe: the v3 contract rejects this input.
    const malformed = await build(q, job(bad));
    assert.equal(malformed.schemaVersion, 3);
    assert.equal(malformed.recipe, null);
    // A recording id that is not a UUID can never name a file outside the directory.
    assert.deepEqual(await build(q, job("../../etc/passwd")), {
      schemaVersion: 2,
      marker: "base",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
