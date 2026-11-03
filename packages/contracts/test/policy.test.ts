import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import test from "node:test";

const api = new URL("../api/", import.meta.url);
const text = (path: string) => readFileSync(new URL(path, api), "utf8");
// catalog.v6.json is the current registry; catalog.v1.json through
// catalog.v5.json stay published and immutable.
const catalog = JSON.parse(text("catalog.v6.json"));
const catalogV5 = JSON.parse(text("catalog.v5.json"));
const catalogV4 = JSON.parse(text("catalog.v4.json"));
const catalogV3 = JSON.parse(text("catalog.v3.json"));
const catalogV2 = JSON.parse(text("catalog.v2.json"));
const catalogV1 = JSON.parse(text("catalog.v1.json"));
const lock = JSON.parse(text("schemas.lock.json"));
const sha256 = (path: string) =>
  createHash("sha256")
    .update(readFileSync(new URL(path, api)))
    .digest("hex");

/**
 * The lock as published with SA-12 (catalog v1). These values are frozen
 * here so an edit to schemas.lock.json cannot silently re-bless changed v1
 * bytes: the lock may only gain entries.
 */
const PUBLISHED_V1_LOCK: Readonly<Record<string, string>> = {
  "artifacts/frame-map.v1.schema.json":
    "b15626799d5fc2f2da01374406caabbd3fe11dfc95061f6bc1f56074f4ed00bc",
  "artifacts/hand-observations.v1.schema.json":
    "90f7685d6b49b7b7e84285230a3b33804e2da0c615095724197c3ba00783314d",
  "artifacts/processing-result.v1.schema.json":
    "cdb5c982a9d916a41cb7a4c37632eb09ff1a06a2dc156cf848a16114f4505ad6",
  "artifacts/recording-source.v1.schema.json":
    "090caf78c965c1ea1328eb56b094f58242035ffe4cdebff54f6174e655429dec",
  "catalog.v1.json":
    "77dda8c10cb74618fbe627f4b22397541dcf9a138df8d2a9ad9b4867b1ba7243",
  "common.v1.schema.json":
    "2014e8f1c2d44fc85c0a2efb3e4413e37088b96931e29fc0f1676b311e1d3eeb",
  "http/error-envelope.v1.schema.json":
    "7bfeb5d2fb42bc011b719e0f1d81b1739d430c6231a6af2dc3bed39e82ea5737",
  "http/parts-receipts.v1.schema.json":
    "98abc2516e8b3c62596a56f6a1c7fe150b789e31077b8aad0deb74c6d7e1bd84",
  "http/parts-sign.v1.schema.json":
    "783b88d6f5c5803d649d290b15ebe75a856946add6f0b3d23f48f9fd95e06976",
  "http/parts-signed.v1.schema.json":
    "2d5b5d45125aedc34374744303d20f9c1cc3a727d7c1f0669ca9eadca7d578c5",
  "http/recording-create.v1.schema.json":
    "2a13ec6192a2cda23424c4bb6d89844e4cb174008b8fdfe7c5a6f4fe17af2c11",
  "http/recording-seal.v1.schema.json":
    "01cdaffce1480332cdfe66af40e36fb7495f4a950d22c05aeff7ba887def70d3",
  "http/recording.v1.schema.json":
    "42dbf5d411fcf9cb5ca491358f29708cb073acddf7f67a32455aaf7a7c3ffdb6",
  "http/success-envelope.v1.schema.json":
    "cf560496b08afb227c4e9e4f95e5f168e8265555b9445ef45fa055c8605c7415",
  "http/upload-create.v1.schema.json":
    "e0b4cc4b7d401e1591fa061110857b3584142b598fea7c5ca71fdf4f0faaa471",
  "http/upload-plan.v1.schema.json":
    "ef8407a6576deece43f37987a6ed51ce68d3505ab3184f22995d193f2c888a19",
  "http/upload-transition.v1.schema.json":
    "115f96a1b945430bb9c5b1aa978293cdada70861d0e77602cf0b701f2165c480",
  "jobs/claim-grant.v1.schema.json":
    "46af17214aaaa474b1e71f2aeb2477ef899a496e0e7c3024ee00122fac33ea50",
  "jobs/controller-input.v1.schema.json":
    "0ea0570b479959e431b95575bd49672d909173dd117b4a3a22f1dd3e45bc9544",
  "jobs/heartbeat.v1.schema.json":
    "24954e9d83eba272f61df26bec4c8cb8ae7ce289030d6c5129f2cafe1d35c860",
  "jobs/job-status.v1.schema.json":
    "65c9117ee64826371580eabfaef2cd41ba59e55ec74cadc94ac6c14159433b94",
  "jobs/result-candidate.v1.schema.json":
    "8b0a1aeeb01585809e8324f2bc8a251965b862d00264d2bb63f3067b8ea34c09",
  "jobs/task-input.v1.schema.json":
    "c3904eb5a866aaaf02fc7dec1274729e0a6fdcf58e17b2f5d0913f7bef9c1f75",
  "jobs/worker-claim.v1.schema.json":
    "a2e0fae16d66ea54bd899c98ef206d7d14439821870460f93f7e397205e57fb5",
  "native/capture-capabilities.v1.schema.json":
    "25e3a2f0072dbace71c97b98fa58b21e54efd37eee15b94b9533c2bab115a07f",
  "native/capture-command.v1.schema.json":
    "4a2fd3871a7f5d1e38f3fac4bc56914af024f4d748daa1ade1afcd28d5bf5649",
  "native/capture-error.v1.schema.json":
    "a8b68e808c6adfa39ffb7a2cabf93037b1d24e72c3a6713b161c2099ab6d2682",
  "native/capture-recoverable.v1.schema.json":
    "1f88e79f5ad18330108e1a6b39a551851e1f6fae9371624bd2472741a1f3cdcf",
  "native/capture-snapshot.v1.schema.json":
    "da8ef57c927bad2f114e7e5df663c2135b420596ea43a442922ac340af1773dc",
  "platform-verify.v1.schema.json":
    "171bc49bd9a786d923dfbb14bccabe40a7d4c8281a2caddb5fd0f04f05864080",
};

function files(dir = ""): string[] {
  return readdirSync(new URL(dir, api)).flatMap((name) =>
    statSync(new URL(dir + name, api)).isDirectory()
      ? files(`${dir}${name}/`)
      : [dir + name],
  );
}

test("catalog lists every published contract schema exactly once", () => {
  const schemas = files()
    .filter((f) => f.includes("/") && f.endsWith(".schema.json"))
    .sort();
  const listed = Object.values(catalog.contracts)
    .map((c: any) => c.schema)
    .sort();
  assert.deepEqual(listed, schemas);
});

test("v1 lock entries are unchanged and every v1 file keeps its exact bytes", () => {
  for (const [file, hash] of Object.entries(PUBLISHED_V1_LOCK)) {
    assert.equal(lock.files[file], hash, `${file}: lock entry changed`);
    assert.equal(sha256(file), hash, `${file}: published bytes changed`);
  }
  assert.equal(Object.keys(PUBLISHED_V1_LOCK).length, 30);
});

/**
 * Lock entries published with SA-15 (catalog v2). Frozen like the v1 values:
 * they may never be re-blessed.
 */
const PUBLISHED_V2_LOCK: Readonly<Record<string, string>> = {
  "catalog.v2.json":
    "cc67b8fd846911850b9b537ea1d4231529b9743d8c5a78e65bb49c7f505dd862",
  "http/me.v1.schema.json":
    "e8cb9e686a4314de5ba0268dc924e2fd5ede2f5d9128d5a75a17ec3b1f25f80a",
};

test("v2 lock entries are unchanged and every v2 file keeps its exact bytes", () => {
  for (const [file, hash] of Object.entries(PUBLISHED_V2_LOCK)) {
    assert.equal(lock.files[file], hash, `${file}: lock entry changed`);
    assert.equal(sha256(file), hash, `${file}: published bytes changed`);
  }
});

function assertExactSuperset(
  next: any,
  previous: any,
  names: [string, string],
  added: string[],
) {
  assert.equal(previous.catalog, `stateaction.contracts.catalog.${names[0]}`);
  assert.equal(next.catalog, `stateaction.contracts.catalog.${names[1]}`);
  for (const key of ["common", "errorCodes", "maxDepth"])
    assert.deepEqual(next[key], previous[key], key);
  assert.deepEqual(Object.keys(next).sort(), Object.keys(previous).sort());
  for (const [id, entry] of Object.entries(previous.contracts))
    assert.deepEqual(next.contracts[id], entry, `${id} differs in ${names[1]}`);
  assert.deepEqual(
    Object.keys(next.contracts).filter((id) => !(id in previous.contracts)),
    added,
  );
}

test("catalog v2 is an exact superset of catalog v1", () => {
  assertExactSuperset(catalogV2, catalogV1, ["v1", "v2"], ["http.me.v1"]);
  assert.equal(Object.keys(catalogV1.contracts).length, 27);
});

test("catalog v3 is an exact superset of catalog v2", () => {
  assertExactSuperset(
    catalogV3,
    catalogV2,
    ["v2", "v3"],
    ["http.recording-registration.v1"],
  );
  assert.equal(Object.keys(catalogV2.contracts).length, 28);
  assert.equal(Object.keys(catalogV3.contracts).length, 29);
});

/** Lock entries published with SA-19 (catalog v3). Frozen. */
const PUBLISHED_V3_LOCK: Readonly<Record<string, string>> = {
  "catalog.v3.json":
    "721e08cd0b30b108881eb4483ade4d7094d1159d4ce3d3f12430df8a5b6536dd",
  "http/recording-registration.v1.schema.json":
    "b4ec236ded3b1f1310bb2f7ddf6070c2050fb4657580501dc87c9c153b421816",
};

test("v3 lock entries are unchanged and every v3 file keeps its exact bytes", () => {
  for (const [file, hash] of Object.entries(PUBLISHED_V3_LOCK)) {
    assert.equal(lock.files[file], hash, `${file}: lock entry changed`);
    assert.equal(sha256(file), hash, `${file}: published bytes changed`);
  }
});

test("catalog v4 is an exact superset of catalog v3", () => {
  assertExactSuperset(
    catalogV4,
    catalogV3,
    ["v3", "v4"],
    ["http.profile-update.v1", "http.profile.v1"],
  );
  assert.equal(Object.keys(catalogV4.contracts).length, 31);
});

/** Lock entries published with SA-16 (catalog v4). Frozen. */
const PUBLISHED_V4_LOCK: Readonly<Record<string, string>> = {
  "catalog.v4.json":
    "beef2a5f78e8bc294e666879997acc9792bc52ec2bf50214b307a9d904e110b4",
  "http/profile-update.v1.schema.json":
    "8af6302756bb767ca51632d83a427b35752d87d18cfc87bc6c4018b73a55ef60",
  "http/profile.v1.schema.json":
    "325b8fd28084a98f7464969db99e19280b9861d7b3c6606b15156bdcff191513",
};

test("v4 lock entries are unchanged and every v4 file keeps its exact bytes", () => {
  for (const [file, hash] of Object.entries(PUBLISHED_V4_LOCK)) {
    assert.equal(lock.files[file], hash, `${file}: lock entry changed`);
    assert.equal(sha256(file), hash, `${file}: published bytes changed`);
  }
});

test("catalog v5 is an exact superset of catalog v4", () => {
  assertExactSuperset(
    catalogV5,
    catalogV4,
    ["v4", "v5"],
    ["http.output-create.v1", "http.output-plan.v1"],
  );
  assert.equal(Object.keys(catalogV5.contracts).length, 33);
});

test("v5 output contracts are internal-path, closed and byte-capped", () => {
  for (const [id, maxBytes] of [
    ["http.output-create.v1", 4096],
    ["http.output-plan.v1", 16384],
  ] as const) {
    const entry = catalogV5.contracts[id];
    assert.equal(entry.version.path, "/internal/v1", id);
    assert.equal(entry.maxBytes, maxBytes, id);
  }
  assert.deepEqual(catalogV5.contracts["http.output-plan.v1"].rules, [
    "upload_plan",
  ]);
});

/** Lock entries published with SA-20 (catalog v5). Frozen. */
const PUBLISHED_V5_LOCK: Readonly<Record<string, string>> = {
  "catalog.v5.json":
    "54b3cf5d4afe9c4bad833bc9b3b00f3f631edfe9b737cc0e558c394c7c684099",
  "http/output-create.v1.schema.json":
    "d8ad1dc0ae2a92f3de3b2038993865c6b29c5fa27576b6ce416f8f5998e78f88",
  "http/output-plan.v1.schema.json":
    "bae373330bcfe3ba2775f63bd35e7a86a5bdcb2658ed85eaf136e3060c3826b1",
};

test("v5 lock entries are unchanged and every v5 file keeps its exact bytes", () => {
  for (const [file, hash] of Object.entries(PUBLISHED_V5_LOCK)) {
    assert.equal(lock.files[file], hash, `${file}: lock entry changed`);
    assert.equal(sha256(file), hash, `${file}: published bytes changed`);
  }
});

const V6_ADDED = [
  "artifacts.recording-source.v2",
  "artifacts.simulation-provenance.v1",
  "http.recording-create.v2",
  "http.recording-registration.v2",
  "http.recording.v2",
  "http.simulation-provenance.v1",
  "jobs.task-input.v2",
];

test("catalog v6 (SA-71) is an exact superset of catalog v5 adding only simulation-capable versions", () => {
  assertExactSuperset(catalog, catalogV5, ["v5", "v6"], V6_ADDED);
  assert.equal(Object.keys(catalog.contracts).length, 40);
  // The frozen v1 siblings are deep-equal entries, not edited in place.
  for (const id of [
    "artifacts.recording-source.v1",
    "http.recording-create.v1",
    "http.recording.v1",
    "http.recording-registration.v1",
    "jobs.task-input.v1",
  ])
    assert.deepEqual(catalog.contracts[id], catalogV5.contracts[id], id);
});

/** Lock entries published with SA-71 (catalog v6). Frozen once released. */
const PUBLISHED_V6_LOCK: Readonly<Record<string, string>> = {
  "catalog.v6.json":
    "467d38dfa820815b788595fda918057a796544ccf0ea1121c5519cc1005fb81f",
  "artifacts/simulation-provenance.v1.schema.json":
    "fdb507cedda7ec7363033dfda6adb0ce159621f1848b91cf9e34ca95e8f1f6cd",
  "http/simulation-provenance.v1.schema.json":
    "30472eea6e3a60b58f3bbde0d30ba34d5e195052deeeadd32f709d6a427af5f4",
  "artifacts/recording-source.v2.schema.json":
    "148eb258dc805089ba59261240943625b99f5c0037e7a9c49f4b15790eeb7504",
  "http/recording-create.v2.schema.json":
    "8139a3e4e4bf78bba9d1948cb3e01ce15b8fc90e60709c0bd181537504906a31",
  "http/recording.v2.schema.json":
    "549e6518afe009f223c475bbf27de68baec51931bd81da630d081ced074ca492",
  "http/recording-registration.v2.schema.json":
    "221e1933c3ce5fe6951936470b117f160ecb6eb9fb714044f41364a3d1360ecf",
  "jobs/task-input.v2.schema.json":
    "d2d9a7b587680ded1ba8df531ef157691f79ad66de9e569aa638685dbc65320a",
};

test("v6 lock entries are unchanged and every v6 file keeps its exact bytes", () => {
  for (const [file, hash] of Object.entries(PUBLISHED_V6_LOCK)) {
    assert.equal(lock.files[file], hash, `${file}: lock entry changed`);
    assert.equal(sha256(file), hash, `${file}: published bytes changed`);
  }
  assert.equal(Object.keys(PUBLISHED_V6_LOCK).length, 8);
});

test("v6 contracts keep the version discriminators that select them", () => {
  const field = (id: string) => catalog.contracts[id].version;
  assert.deepEqual(field("artifacts.recording-source.v2"), {
    field: "schema",
    accepted: ["stateaction.recording_source.v2"],
  });
  assert.deepEqual(field("http.recording-create.v2"), {
    field: "schema",
    accepted: ["stateaction.recording_create.v2"],
  });
  assert.deepEqual(field("jobs.task-input.v2"), {
    field: "schemaVersion",
    accepted: [2],
  });
  for (const id of ["http.recording.v2", "http.recording-registration.v2"])
    assert.deepEqual(field(id), { path: "/api/v1" }, id);
});

test("published schema bytes match the immutability lock", () => {
  const actual = Object.fromEntries(
    files()
      .filter((f) => f.endsWith(".json") && f !== "schemas.lock.json")
      .sort()
      .map((f) => [
        f,
        createHash("sha256")
          .update(readFileSync(new URL(f, api)))
          .digest("hex"),
      ]),
  );
  assert.deepEqual(
    actual,
    lock.files,
    `Published v1 files are immutable. Add a new vN file instead; for a new file, record:\n${JSON.stringify(actual, null, 2)}`,
  );
});

// Generates the exact regex for decimal strings 0|1..max (no leading zeros).
function atMost(max: string, allowZero: boolean): string {
  const k = max.length;
  const alts: string[] = allowZero ? ["0"] : [];
  if (k >= 2) alts.push(k === 2 ? "[1-9]" : `[1-9][0-9]{0,${k - 2}}`);
  for (let i = 0; i < k; i++) {
    const d = Number(max[i]);
    const lo = i === 0 ? 1 : 0;
    if (d > lo) {
      const cls = d - 1 === lo ? String(lo) : `[${lo}-${d - 1}]`;
      const rest = k - i - 1;
      alts.push(
        max.slice(0, i) +
          cls +
          (rest === 0 ? "" : rest === 1 ? "[0-9]" : `[0-9]{${rest}}`),
      );
    }
  }
  alts.push(max);
  return `^(${alts.join("|")})$`;
}

test("decimal bound patterns are generated from their exact limits", () => {
  const defs = JSON.parse(text("common.v1.schema.json")).$defs;
  assert.equal(defs.int64Decimal.pattern, atMost("9223372036854775807", true));
  assert.equal(defs.byteCount.pattern, atMost("107374182400", true));
  assert.equal(defs.fileSizeBytes.pattern, atMost("107374182400", false));
  const re = new RegExp(defs.int64Decimal.pattern, "u");
  for (const [value, ok] of [
    ["9223372036854775807", true],
    ["9223372036854775808", false],
    ["0", true],
    ["00", false],
    ["-1", false],
  ] as const)
    assert.equal(re.test(value), ok, value);
});

/**
 * Regex features whose meaning differs between ECMA-262 (Ajv, Dart) and Python
 * `re`: class shorthands and the unescaped dot. Patterns spell explicit ASCII
 * ranges instead. Returns the first offending token or null.
 */
export function nonPortableToken(pattern: string): string | null {
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === "\\") {
      const next = pattern[i + 1] ?? "";
      if (/[sSdDwWbB]/.test(next)) return `\\${next}`;
      i++;
      continue;
    }
    if (inClass) {
      if (ch === "]") inClass = false;
    } else if (ch === "[") {
      inClass = true;
      if (pattern[i + 1] === "]") i++;
    } else if (ch === ".") return ".";
  }
  return null;
}

test("pattern policy rejects engine-dependent regex features", () => {
  for (const [pattern, token] of [
    ["^https?://[^\\s]+$", "\\s"],
    ["^\\d+$", "\\d"],
    ["^\\w+$", "\\w"],
    ["^a.b$", "."],
    ["^[.]$", null],
    ["^a\\.b$", null],
    ["^https?://[!-~]+$", null],
  ] as const)
    assert.equal(nonPortableToken(pattern), token, pattern);
});

type Schema = Record<string, any>;
function* walk(node: Schema, path: string): Generator<[Schema, string]> {
  yield [node, path];
  for (const key of [
    "items",
    "additionalProperties",
    "propertyNames",
    "if",
    "then",
    "else",
    "not",
  ])
    if (node[key] && typeof node[key] === "object")
      yield* walk(node[key], `${path}/${key}`);
  for (const key of ["oneOf", "anyOf", "allOf", "prefixItems"])
    for (const [i, sub] of (node[key] ?? []).entries())
      yield* walk(sub, `${path}/${key}/${i}`);
  for (const key of ["properties", "$defs"])
    for (const [name, sub] of Object.entries(node[key] ?? {}))
      yield* walk(sub as Schema, `${path}/${key}/${name}`);
}

test("schemas are closed, bounded and use the documented casing", () => {
  const all = [
    "common.v1.schema.json",
    ...Object.values(catalog.contracts).map((c: any) => c.schema),
  ];
  for (const file of all) {
    const snake = file.startsWith("artifacts/");
    for (const [node, at] of walk(JSON.parse(text(file)), file)) {
      assert.ok(
        !("format" in node),
        `${at}: use explicit patterns, not format`,
      );
      if (node.pattern) {
        assert.match(node.pattern, /^\^.*\$$/, `${at}: patterns are anchored`);
        assert.equal(
          nonPortableToken(node.pattern),
          null,
          `${at}: use explicit ASCII classes, not \\s/\\d/\\w or .`,
        );
      }
      const type = node.type;
      if (type === "object") {
        assert.ok("additionalProperties" in node, `${at}: closed object`);
        if (node.additionalProperties !== false)
          assert.ok(node.maxProperties, `${at}: bounded open map`);
        for (const name of Object.keys(node.properties ?? {}))
          assert.match(
            name,
            snake ? /^[a-z][a-z0-9_]*$/ : /^[a-z][A-Za-z0-9]*$/,
            `${at}: ${name} casing`,
          );
      }
      if (type === "array" || (Array.isArray(type) && type.includes("array")))
        assert.ok(Number.isInteger(node.maxItems), `${at}: bounded array`);
      if (type === "string")
        assert.ok(
          node.maxLength || node.pattern || node.enum || node.const,
          `${at}: bounded string`,
        );
      if (type === "integer" || type === "number")
        assert.ok(
          ("maximum" in node && "minimum" in node) || node.enum,
          `${at}: bounded number`,
        );
    }
  }
});

test("every contract declares a byte bound and version discriminator", () => {
  for (const [id, c] of Object.entries<any>(catalog.contracts)) {
    assert.ok(c.maxBytes > 0 && c.maxBytes <= 16 * 1048576, id);
    assert.ok(c.version, `${id}: version`);
  }
});
