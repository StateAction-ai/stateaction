import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import test from "node:test";
import { requestSha256 } from "../src/canonical.js";

const api = new URL("../api/", import.meta.url);
const text = (path: string) => readFileSync(new URL(path, api), "utf8");
// catalog.v14.json is the current registry; catalog.v1.json through
// catalog.v13.json stay published and immutable.
const catalog = JSON.parse(text("catalog.v14.json"));
const catalogV13 = JSON.parse(text("catalog.v13.json"));
const catalogV12 = JSON.parse(text("catalog.v12.json"));
const catalogV11 = JSON.parse(text("catalog.v11.json"));
const catalogV10 = JSON.parse(text("catalog.v10.json"));
const catalogV9 = JSON.parse(text("catalog.v9.json"));
const catalogV8 = JSON.parse(text("catalog.v8.json"));
const catalogV7 = JSON.parse(text("catalog.v7.json"));
const catalogV6 = JSON.parse(text("catalog.v6.json"));
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
  assertExactSuperset(catalogV6, catalogV5, ["v5", "v6"], V6_ADDED);
  assert.equal(Object.keys(catalogV6.contracts).length, 40);
  // The frozen v1 siblings are deep-equal entries, not edited in place.
  for (const id of [
    "artifacts.recording-source.v1",
    "http.recording-create.v1",
    "http.recording.v1",
    "http.recording-registration.v1",
    "jobs.task-input.v1",
  ])
    assert.deepEqual(catalogV6.contracts[id], catalogV5.contracts[id], id);
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

const V7_ADDED = [
  "http.input-read.v1",
  "jobs.controller-action.v1",
  "jobs.controller-result.v1",
  "jobs.heartbeat-ack.v1",
  "jobs.reconcile-result.v1",
];

test("catalog v7 (SA-25) is an exact superset of catalog v6 adding only internal job-control contracts", () => {
  assertExactSuperset(catalogV7, catalogV6, ["v6", "v7"], V7_ADDED);
  assert.equal(Object.keys(catalogV7.contracts).length, 45);
  for (const id of V7_ADDED) {
    const entry = catalogV7.contracts[id];
    assert.equal(entry.casing, "camelCase", id);
    assert.deepEqual(entry.version, { path: "/internal/v1" }, id);
    assert.deepEqual(entry.rules, [], id);
  }
  // Frozen worker contracts stay deep-equal; the control DTOs never replace them.
  for (const id of [
    "jobs.worker-claim.v1",
    "jobs.claim-grant.v1",
    "jobs.heartbeat.v1",
    "jobs.job-status.v1",
    "jobs.task-input.v1",
  ])
    assert.deepEqual(catalogV7.contracts[id], catalogV6.contracts[id], id);
});

/** Lock entries published with SA-25 (catalog v7). Frozen once released. */
const PUBLISHED_V7_LOCK: Readonly<Record<string, string>> = {
  "catalog.v7.json":
    "89bc8add1ae7249fefebe807065557f05ce94a01d9d8583c5f159c84716ff2db",
  "jobs/controller-action.v1.schema.json":
    "42d6140d37fe0dfcf0138804c415c854cbdce6b011d4fd1b49aa803ae023ea9f",
  "jobs/controller-result.v1.schema.json":
    "b9ea7573391326d6a6e1a9ab52d5ef850a0ac1fbe4e7786e080a91c044f6ac97",
  "jobs/reconcile-result.v1.schema.json":
    "9e1694d76f8f99c36254445e712adb5a4001023b117e22ede196cdad3b73c8a5",
  "jobs/heartbeat-ack.v1.schema.json":
    "747a4c671aa771dbd67478e655da1ae366e4d44fda08c299996d1c4b0c5599bc",
  "http/input-read.v1.schema.json":
    "aa8dc7988a5114b014ddef918c3f7e1a2075980a0e9de68ef461033c7cf12842",
};

test("v7 lock entries are unchanged and every v7 file keeps its exact bytes", () => {
  for (const [file, hash] of Object.entries(PUBLISHED_V7_LOCK)) {
    assert.equal(lock.files[file], hash, `${file}: lock entry changed`);
    assert.equal(sha256(file), hash, `${file}: published bytes changed`);
  }
  assert.equal(Object.keys(PUBLISHED_V7_LOCK).length, 6);
});

const V8_ADDED = [
  "http.clip-read-create.v1",
  "http.clip-read.v1",
  "http.dataset-change.v1",
  "http.dataset-clip-page.v1",
  "http.dataset-clip.v1",
  "http.dataset-create.v1",
  "http.dataset-members-add.v1",
  "http.dataset-page.v1",
  "http.dataset-update.v1",
  "http.dataset.v1",
  "http.staff-clip-page.v1",
];

test("catalog v8 (SA-35) is an exact superset of catalog v7 adding only dataset and read-broker contracts", () => {
  assertExactSuperset(catalogV8, catalogV7, ["v7", "v8"], V8_ADDED);
  assert.equal(Object.keys(catalogV8.contracts).length, 56);
  for (const id of V8_ADDED) {
    const entry = catalogV8.contracts[id];
    assert.equal(entry.casing, "camelCase", id);
    assert.deepEqual(entry.version, { path: "/api/v1" }, id);
    assert.deepEqual(entry.rules, [], id);
  }
});

/** Lock entries published with SA-35 (catalog v8). Frozen once released. */
const PUBLISHED_V8_LOCK: Readonly<Record<string, string>> = {
  "catalog.v8.json":
    "e2c70cf7e157d953fc3fbc1ec5f80a74575f7419d481b544de021ef9a475d589",
  "http/clip-read-create.v1.schema.json":
    "fa846c30d4d722b1f7cb12e3a9ae19ab0343cb652a869ecbe4b9a2e31c97ace4",
  "http/clip-read.v1.schema.json":
    "2123afcd386cc0d66ad1ad7ae28e29b32d29ed3b28d1306309fff27157532175",
  "http/dataset-change.v1.schema.json":
    "6c219fbf03069f152e4f1572ea7d7e921747ad79dd796e4556be762832d05277",
  "http/dataset-clip-page.v1.schema.json":
    "fb837b68ec18bde4568951c01eef8300d634ec7b8f1c1f4ddd57fd8a2692ca07",
  "http/dataset-clip.v1.schema.json":
    "9b1eaf5f2555b51662a6dc100a9ce36b559742dc790a2515596a3d420480fcd9",
  "http/dataset-create.v1.schema.json":
    "5ae948fc71e24004bb3e11a4e93597415d38fae33e33625f507dd5f9f8514157",
  "http/dataset-members-add.v1.schema.json":
    "3cbafb14e570575c3131da438c25c73738e0e6fb607af8d40a8f2ebc969c0d03",
  "http/dataset-page.v1.schema.json":
    "a95d27cc5705ddff8f2537d41eb4765770add8d813bf50bc9cc4ec52c581c92b",
  "http/dataset-update.v1.schema.json":
    "3c54db3058b699193c0fc35f5f99b969fdebd55b80a603a793f33d62d1324b66",
  "http/dataset.v1.schema.json":
    "308501c6595c59a8057af24a5783513f89ccdcd5018f9047c537a145c0056965",
  "http/staff-clip-page.v1.schema.json":
    "5b9c2d69f23cb57202086e1e4f5b9cfe6902f69f16a035433520fb32e60d5e6c",
};

test("v8 lock entries are unchanged and every v8 file keeps its exact bytes", () => {
  for (const [file, hash] of Object.entries(PUBLISHED_V8_LOCK)) {
    assert.equal(lock.files[file], hash, `${file}: lock entry changed`);
    assert.equal(sha256(file), hash, `${file}: published bytes changed`);
  }
  assert.equal(Object.keys(PUBLISHED_V8_LOCK).length, 12);
});

const V9_ADDED = [
  "artifacts.processing-result.v2",
  "jobs.output-close.v1",
  "jobs.output-closure.v1",
  "jobs.result-ack.v1",
];

test("catalog v9 (SA-28) is an exact superset of catalog v8 adding only output sealing and acceptance contracts", () => {
  assertExactSuperset(catalogV9, catalogV8, ["v8", "v9"], V9_ADDED);
  assert.equal(Object.keys(catalogV9.contracts).length, 60);
  assert.deepEqual(
    catalogV9.contracts["artifacts.processing-result.v2"].version,
    {
      field: "schema",
      accepted: ["stateaction.processing_result.v2"],
    },
  );
  // v1 stays published, valid and unchanged next to the additive v2.
  assert.deepEqual(
    catalogV9.contracts["artifacts.processing-result.v1"],
    catalogV8.contracts["artifacts.processing-result.v1"],
  );
  for (const id of V9_ADDED.slice(1)) {
    const entry = catalogV9.contracts[id];
    assert.equal(entry.casing, "camelCase", id);
    assert.deepEqual(entry.version, { path: "/internal/v1" }, id);
    assert.deepEqual(entry.rules, [], id);
  }
});

/** Lock entries published with SA-28 (catalog v9). Frozen once released. */
const PUBLISHED_V9_LOCK: Readonly<Record<string, string>> = {
  "catalog.v9.json":
    "233a774a9c6f5834282c269f7e088e00f9bc197ada4f889b2882b0f5bf204261",
  "artifacts/processing-result.v2.schema.json":
    "7776c0b057f41bbd01e755269f61d52846f14581fe4c42a70708782f8fb4020c",
  "jobs/output-close.v1.schema.json":
    "96b3075d3d0210b284accf6dffe8ea0f7852eb9968d1c57320ae426644834e92",
  "jobs/output-closure.v1.schema.json":
    "e70744e57b80abd417a3b6fad503111a4a5966d6410353746f4e33b94ccdd95a",
  "jobs/result-ack.v1.schema.json":
    "1458a64269958a0831a621ce413cec7654d2256d695f488addcf6eae841cca52",
};

test("v9 lock entries are unchanged and every v9 file keeps its exact bytes", () => {
  for (const [file, hash] of Object.entries(PUBLISHED_V9_LOCK)) {
    assert.equal(lock.files[file], hash, `${file}: lock entry changed`);
    assert.equal(sha256(file), hash, `${file}: published bytes changed`);
  }
  assert.equal(Object.keys(PUBLISHED_V9_LOCK).length, 5);
});

const V10_ADDED = [
  "http.clip-review-command.v1",
  "http.clip-review-state.v1",
  "http.clip-review.v1",
];

test("catalog v10 (SA-36) is an exact superset of catalog v9 adding only the staff clip review contracts", () => {
  assertExactSuperset(catalogV10, catalogV9, ["v9", "v10"], V10_ADDED);
  assert.equal(Object.keys(catalogV10.contracts).length, 63);
  for (const id of V10_ADDED) {
    const entry = catalogV10.contracts[id];
    assert.equal(entry.casing, "camelCase", id);
    assert.deepEqual(entry.version, { path: "/api/v1" }, id);
    assert.deepEqual(entry.rules, [], id);
  }
});

/** Lock entries published with SA-36 (catalog v10). Frozen once released. */
const PUBLISHED_V10_LOCK: Readonly<Record<string, string>> = {
  "catalog.v10.json":
    "71f14a6157c9bbad89944658c36d5d473d77c6088dbba99b2fbf7017083b780e",
  "http/clip-review-command.v1.schema.json":
    "191d79248b951deb9c8023fa3aa411e50c32a10deb416658305205739a23c5b8",
  "http/clip-review-state.v1.schema.json":
    "a4a818467b10c95e4d7ffb7655361286595b7da65460d23bea485d57bae14c8d",
  "http/clip-review.v1.schema.json":
    "c8d884f08cf6516d7b90e64877fbbbfaccf6d3ae45b9910e7a93f0ca8eac8565",
};

test("v10 lock entries are unchanged and every v10 file keeps its exact bytes", () => {
  for (const [file, hash] of Object.entries(PUBLISHED_V10_LOCK)) {
    assert.equal(lock.files[file], hash, `${file}: lock entry changed`);
    assert.equal(sha256(file), hash, `${file}: published bytes changed`);
  }
  assert.equal(Object.keys(PUBLISHED_V10_LOCK).length, 4);
});

const V11_ADDED = ["http.job-control-command.v1", "http.job-control-result.v1"];

test("catalog v11 (SA-27) is an exact superset of catalog v10 adding only the staff job control contracts", () => {
  assertExactSuperset(catalogV11, catalogV10, ["v10", "v11"], V11_ADDED);
  assert.equal(Object.keys(catalogV11.contracts).length, 65);
  for (const id of V11_ADDED) {
    const entry = catalogV11.contracts[id];
    assert.equal(entry.casing, "camelCase", id);
    assert.deepEqual(entry.version, { path: "/api/v1" }, id);
    assert.deepEqual(entry.rules, [], id);
  }
});

const V12_ADDED = ["jobs.job-status.v2"];

test("catalog v12 (SA-42) is an exact superset of catalog v11 adding only the job status with the recorded execution identity", () => {
  assertExactSuperset(catalogV12, catalogV11, ["v11", "v12"], V12_ADDED);
  assert.equal(Object.keys(catalogV12.contracts).length, 66);
  const entry = catalogV12.contracts["jobs.job-status.v2"];
  assert.equal(entry.casing, "camelCase");
  assert.deepEqual(entry.version, { path: "/internal/v1" });
  assert.deepEqual(entry.rules, []);
  // The published v1 status stays deep-equal; v2 never edits it.
  assert.deepEqual(
    catalogV12.contracts["jobs.job-status.v1"],
    catalogV11.contracts["jobs.job-status.v1"],
  );
});

/** Lock entries published with SA-42 (catalog v12). Frozen once released. */
const PUBLISHED_V12_LOCK: Readonly<Record<string, string>> = {
  "catalog.v12.json":
    "674b089a92875402ac5ebedfc53f9f906c3e609390a48bb56007e6fdb24937d9",
  "jobs/job-status.v2.schema.json":
    "d633d785b58ce4eefdcc0caf5efb4158f0f4cac046fa46ec9a425177d313b36f",
};

test("v12 lock entries are unchanged and every v12 file keeps its exact bytes", () => {
  for (const [file, hash] of Object.entries(PUBLISHED_V12_LOCK)) {
    assert.equal(lock.files[file], hash, `${file}: lock entry changed`);
    assert.equal(sha256(file), hash, `${file}: published bytes changed`);
  }
  assert.equal(Object.keys(PUBLISHED_V12_LOCK).length, 2);
});

/** Lock entries published with SA-27 (catalog v11). Frozen once released. */
const PUBLISHED_V11_LOCK: Readonly<Record<string, string>> = {
  "catalog.v11.json":
    "60e83cc9cabdd87cb9ee398c0de4e175ca6d33e7cd115a0d8b9a13311af613d8",
  "http/job-control-command.v1.schema.json":
    "72c7c78ec195bd098c597fa2b70e2121b8d52394a97894c09481a035eb835cc5",
  "http/job-control-result.v1.schema.json":
    "d3f1ca0c45a501fe17029791cf91afee4072452e7659e95057cbde3e783d6960",
};

test("v11 lock entries are unchanged and every v11 file keeps its exact bytes", () => {
  for (const [file, hash] of Object.entries(PUBLISHED_V11_LOCK)) {
    assert.equal(lock.files[file], hash, `${file}: lock entry changed`);
    assert.equal(sha256(file), hash, `${file}: published bytes changed`);
  }
  assert.equal(Object.keys(PUBLISHED_V11_LOCK).length, 3);
});

test("published schema bytes match the immutability lock", () => {
  const actual = Object.fromEntries(
    files()
      // modules.json is the append-only module registry, pinned per entry below.
      .filter(
        (f) =>
          f.endsWith(".json") &&
          f !== "schemas.lock.json" &&
          f !== "modules.json",
      )
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
  // A boolean subschema (`false` forbids a property) has no keywords to check.
  if (typeof node !== "object" || node === null) return;
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
    ...catalog.shared,
    ...Object.values(catalog.contracts).map((c: any) => c.schema),
  ];
  for (const file of all) {
    // common.v2 holds the snake_case artifact definitions (frameRef, producer).
    const snake =
      file.startsWith("artifacts/") || file === "common.v2.schema.json";
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

const V13_ADDED = [
  "http.cleanup-proof-request.v1",
  "http.cleanup-proof.v1",
  "http.source-copy-confirm.v1",
  "http.source-copy-confirmation.v1",
];

test("catalog v13 (SA-73) is an exact superset of catalog v12 adding only the source-copy confirmation and cleanup-proof contracts", () => {
  assertExactSuperset(catalogV13, catalogV12, ["v12", "v13"], V13_ADDED);
  assert.equal(Object.keys(catalogV13.contracts).length, 70);
  for (const id of V13_ADDED) {
    const entry = catalogV13.contracts[id];
    assert.equal(entry.casing, "camelCase", id);
    assert.deepEqual(entry.version, { path: "/api/v1" }, id);
    assert.deepEqual(entry.rules, [], id);
  }
});

test("v13 lock entries are present and match the published bytes", () => {
  const files = [
    "catalog.v13.json",
    "http/source-copy-confirm.v1.schema.json",
    "http/cleanup-proof-request.v1.schema.json",
    "http/source-copy-confirmation.v1.schema.json",
    "http/cleanup-proof.v1.schema.json",
  ];
  for (const file of files)
    assert.equal(lock.files[file], sha256(file), `${file}: lock entry`);
});

const V14_ADDED = [
  "artifacts.captions.v1",
  "artifacts.hand-presence.v1",
  "artifacts.processing-result.v3",
  "artifacts.segments.v1",
  "http.dag-run.v1",
  "jobs.controller-action.v2",
  "jobs.heartbeat.v2",
  "jobs.module-manifest.v1",
  "jobs.recipe.v1",
  "jobs.stage-receipt.v1",
  "jobs.task-input.v3",
];

test("catalog v14 (SA-87) is an exact superset of catalog v13 adding only the stage contracts and common.v2", () => {
  const { shared, ...rest } = catalog;
  assertExactSuperset(rest, catalogV13, ["v13", "v14"], V14_ADDED);
  assert.deepEqual(shared, ["common.v2.schema.json"]);
  assert.equal(Object.keys(catalog.contracts).length, 81);
  for (const id of V14_ADDED) {
    const entry = catalog.contracts[id];
    const artifact = id.startsWith("artifacts.");
    assert.equal(entry.casing, artifact ? "snake_case" : "camelCase", id);
    assert.ok(entry.rules.length > 0, `${id}: cross-field rules`);
  }
  // Every earlier version of an evolved contract stays published and deep-equal.
  for (const id of [
    "artifacts.processing-result.v1",
    "artifacts.processing-result.v2",
    "jobs.task-input.v2",
    "jobs.controller-action.v1",
    "jobs.heartbeat.v1",
  ])
    assert.deepEqual(catalog.contracts[id], catalogV13.contracts[id], id);
  assert.equal(catalog.contracts["jobs.stage-receipt.v1"].maxBytes, 65536);
  // A controller action carries at most one 64 KiB receipt plus its envelope.
  assert.ok(catalog.contracts["jobs.controller-action.v2"].maxBytes > 65536);
});

test("common.v2 is additive: v1 stays locked and v2 output roles are a superset", () => {
  const v1 = JSON.parse(text("common.v1.schema.json")).$defs;
  const v2 = JSON.parse(text("common.v2.schema.json")).$defs;
  assert.equal(
    sha256("common.v1.schema.json"),
    PUBLISHED_V1_LOCK["common.v1.schema.json"],
  );
  assert.deepEqual(
    v2.outputFileRole.enum.slice(0, v1.outputFileRole.enum.length),
    v1.outputFileRole.enum,
  );
  assert.deepEqual(
    v2.outputFileRole.enum.slice(v1.outputFileRole.enum.length),
    [
      "segments_json",
      "captions_json",
      "hand_presence_json",
      "recording_mp4",
      "diagnostic_blob",
    ],
  );
  // common.v2 never redefines a v1 name with a different meaning.
  for (const name of Object.keys(v2))
    if (name in v1 && name !== "outputFileRole")
      assert.fail(`${name} shadows common.v1`);
});

test("the module manifest lists every MVP module with its licence, GPU and provenance", () => {
  const manifest = JSON.parse(text("modules.json"));
  const ids = manifest.modules.map((m: any) => m.moduleId);
  assert.deepEqual(ids, [
    "stub_segmenter",
    "stub_captioner",
    "replay_segmenter",
    "replay_captioner",
    "flora_tempseg_vllm_fp8",
    "flora_captioner_vllm_fp8",
    "flora_tempseg_hf",
    "flora_captioner_hf",
    "hand_pose_cpu_v1",
  ]);
  for (const m of manifest.modules) {
    const local = /^(stub|replay)_/.test(m.moduleId);
    assert.equal(m.localOnly, local, `${m.moduleId}: localOnly`);
    assert.ok(m.gpu.supported.includes(m.gpu.minimum), m.moduleId);
    if (m.moduleId.startsWith("flora_")) {
      // FLORA is NVIDIA non-commercial research only and never runs on CPU.
      assert.equal(m.license.commercialUse, false, m.moduleId);
      assert.ok(!m.gpu.supported.includes("none"), m.moduleId);
      for (const field of [
        "model_revision",
        "weights_sha256",
        "prompt_sha256",
        "observed_gpu",
      ])
        assert.ok(
          m.provenance.requires.includes(field),
          `${m.moduleId}: ${field}`,
        );
    }
    if (m.moduleId.includes("_fp8"))
      assert.ok(m.provenance.requires.includes("quant"), m.moduleId);
  }
});

test("v14 lock entries are present and match the published bytes", () => {
  const files = [
    "catalog.v14.json",
    "common.v2.schema.json",
    ...V14_ADDED.map((id) => catalog.contracts[id].schema),
  ];
  for (const file of files)
    assert.equal(lock.files[file], sha256(file), `${file}: lock entry`);
});

/**
 * Module manifest entries published with SA-87. api/modules.json is append-only:
 * each published module_id@version entry keeps its exact sa-cjson-v1 digest, and
 * a change to a module is a new version entry.
 */
const PUBLISHED_MODULES: Readonly<Record<string, string>> = {
  "stub_segmenter@1":
    "c38f4fc652430e8c747d261cab6bdd713825a0f29d921da96c041bc573a19481",
  "stub_captioner@1":
    "f8c9f83b360b73e48b35ae54f5f74a621e2ad8755840887a41b494fd099c281c",
  "replay_segmenter@1":
    "bf970126bfef4e4742ea22aecff21c851d79c0aed1fceef3e4a90035b12a3e75",
  "replay_captioner@1":
    "ce2f9b0de6076cb23569f2df967d67e8228f833edf12c571be3edd73dfba95c0",
  "flora_tempseg_vllm_fp8@1":
    "66553e893d99951f33ea6c84a37916e10cb762461f1d5ea7ce2490b6a3c4882d",
  "flora_captioner_vllm_fp8@1":
    "e4384b2d63b79361e140b8830f5d43b279f337e3ad862a9b9ac802c5b5001bf3",
  "flora_tempseg_hf@1":
    "444e753f7fadb4512db3208463fca6fd5412a795da1c3ab39f46c7ebb08bce9d",
  "flora_captioner_hf@1":
    "86b643693cea191e22957f8296a534eead2a899c75bbd0ffda2366f2703b19ff",
  "hand_pose_cpu_v1@1":
    "16c7120de377158507bc64819013abfacc0493b8d1dd2e06f1dc98d68d32af19",
};

test("published module manifest entries are append-only", () => {
  const manifest = JSON.parse(text("modules.json"));
  const entries = new Map(
    manifest.modules.map((m: any) => [`${m.moduleId}@${m.version}`, m]),
  );
  for (const [ref, digest] of Object.entries(PUBLISHED_MODULES)) {
    assert.ok(entries.has(ref), `${ref}: published module removed`);
    assert.equal(requestSha256(entries.get(ref)), digest, `${ref} changed`);
  }
});
