import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import test from "node:test";
import { canonicalJson } from "@stateaction/contracts";
import {
  normalizeSeal,
  sealRequestSha256,
} from "../src/admission/inventory.js";

// SA-73 shared synthetic seal-identity vectors. The seal digest is
// sha256(UTF-8 sa-cjson-v1 of {"files": <fileId-sorted exact five-field entries>}).
// A mobile consumer derives it from its own journal and compares it with the
// same vectors; it never adopts a digest returned by the server. Synthetic
// data only. Regenerate with UPDATE_SEAL_VECTORS=1.
const FILE = new URL(
  "../../contracts/conformance/seal-identity.v1.json",
  import.meta.url,
);
const entry = (n: number, role: string, size: string, required = true) => ({
  fileId: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
  role,
  sizeBytes: size,
  sha256: String(n).repeat(64).slice(0, 64),
  required,
});
const manifest = entry(1, "source_manifest", "1000");
const mcap = entry(2, "source_mcap", "134217729");
const meta = entry(3, "recorder_metadata", "4096");
const calibration = entry(4, "calibration", "512", false);
const big = entry(5, "source_mcap", "107374182400");

const CASES: Array<{ name: string; files: unknown[] }> = [
  { name: "sorted three required files", files: [manifest, mcap, meta] },
  {
    name: "shuffled input gives the same digest",
    files: [meta, manifest, mcap],
  },
  {
    name: "optional calibration role",
    files: [calibration, meta, mcap, manifest],
  },
  { name: "100 GiB decimal size string", files: [big, manifest, meta] },
  {
    name: "extra keys are dropped before hashing",
    files: [{ ...manifest, signedUrl: "x", objectKey: "k" }, mcap, meta],
  },
];

function build() {
  return {
    description:
      "sealSha256 = sha256 hex of UTF-8 sa-cjson-v1 canonical JSON of {files: entries sorted by fileId, each exactly fileId, role, sizeBytes (decimal string), sha256, required}. Input order and unknown keys do not matter.",
    cases: CASES.map((c) => {
      const normalized = normalizeSeal(c.files as never);
      return {
        name: c.name,
        input: { files: c.files },
        normalizedFileIds: normalized.map((f) => f.fileId),
        canonical: canonicalJson({ files: normalized }),
        sealSha256: sealRequestSha256(c.files as never),
      };
    }),
  };
}

test("seal identity vectors match the server's normalizeSeal and request digest", () => {
  const expected = build();
  if (process.env.UPDATE_SEAL_VECTORS === "1")
    writeFileSync(FILE, `${JSON.stringify(expected, null, 2)}\n`);
  const stored = JSON.parse(readFileSync(FILE, "utf8"));
  assert.deepEqual(stored, expected);
  const digests = new Map(stored.cases.map((c: any) => [c.name, c.sealSha256]));
  assert.equal(
    digests.get("sorted three required files"),
    digests.get("shuffled input gives the same digest"),
  );
  assert.equal(
    digests.get("sorted three required files"),
    digests.get("extra keys are dropped before hashing"),
  );
});
