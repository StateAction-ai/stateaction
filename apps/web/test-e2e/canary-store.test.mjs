import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { canaryStore, seedOnly } from "./seed-annotations.mjs";

const sha = (b) => createHash("sha256").update(b).digest("hex");

function stores(t, { mcapSha, files = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "sa101-canary-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const homer = join(root, "homer");
  const canary = join(root, "canary");
  mkdirSync(join(homer, "homer_33"), { recursive: true });
  mkdirSync(join(canary, "homer_33", "flora"), { recursive: true });
  writeFileSync(join(homer, "homer_33", "source.mcap"), "mcap-bytes");
  writeFileSync(
    join(canary, "homer_33", "source.conversion.json"),
    JSON.stringify({ mcap_sha256: mcapSha ?? sha("mcap-bytes") }),
  );
  if (files)
    for (const n of [
      "segments.json",
      "windows.jsonl",
      "captions.json",
      "env.json",
    ])
      writeFileSync(join(canary, "homer_33", "flora", n), "{}");
  return { homer: { ok: true, store: homer }, canary };
}

test("the canary store counts only for the MCAP it ran on and with all four FLORA files", (t) => {
  const ok = stores(t);
  const got = canaryStore(ok.homer, ok.canary);
  assert.equal(got.ok, true);
  assert.equal(got.store, ok.canary);
  assert.equal(got.mcapDir, ok.homer.store);

  const other = stores(t, { mcapSha: "0".repeat(64) });
  assert.match(canaryStore(other.homer, other.canary).reason, /another MCAP/);

  const empty = stores(t, { files: false });
  assert.match(canaryStore(empty.homer, empty.canary).reason, /not present/);

  assert.deepEqual(canaryStore({ ok: false, reason: "no homer" }, ok.canary), {
    ok: false,
    reason: "no homer",
  });
});

test("the canary scenario is selectable only by name and a typo still throws", () => {
  assert.deepEqual(
    [...seedOnly("replay_canary_homer_33")],
    ["replay_canary_homer_33"],
  );
  assert.throws(() => seedOnly("replay_canary_homer_3"), /unknown scenario/);
});
