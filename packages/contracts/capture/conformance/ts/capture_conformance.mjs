// stateaction.capture.v1.1 golden MCAP conformance checker (TypeScript-compatible ESM, no dependencies).
// Port of conformance/python/capture_conformance.py; output must equal golden/expected/<case>.json byte for byte.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32 } from "node:zlib";
import {
  MalformedJson,
  Schema,
  SchemaUnsupported,
  parseJson,
} from "./strict_schema.mjs";

const CAP = join(dirname(fileURLToPath(import.meta.url)), "../..");
const VIDEO = "/camera/rgb/video";
const FRAME_ID = "camera_optical_frame";
const CUSTOM = {
  "stateaction.capture.Profile.v1": "Profile.schema.json",
  "stateaction.capture.Clocks.v1": "Clocks.schema.json",
  "stateaction.capture.Inventory.v1": "Inventory.schema.json",
  "stateaction.capture.FrameEvent.v1": "FrameEvent.schema.json",
  "stateaction.capture.MotionEvent.v1": "MotionEvent.schema.json",
  "stateaction.capture.SensorEvent.v1": "SensorEvent.schema.json",
  "stateaction.capture.Close.v1": "Close.schema.json",
};
// stateaction.capture.v1.2 (SA-68): selected by the schema record name of /stateaction/capture_profile.
// NEW files only; the v1.1 table above, manifest.json and every v1.1 golden stay frozen.
const PROFILE_V2 = "stateaction.capture.Profile.v2";
const CUSTOM12 = {
  [PROFILE_V2]: "Profile.v2.schema.json",
  "stateaction.capture.Close.v2": "Close.v2.schema.json",
  "stateaction.capture.Calibration.v1": "Calibration.schema.json",
  "stateaction.capture.DepthEvent.v1": "DepthEvent.schema.json",
  "stateaction.capture.CameraMetadata.v1": "CameraMetadata.schema.json",
};
const CUSTOM_V12_TABLE = {
  ...Object.fromEntries(
    Object.entries(CUSTOM).filter(
      ([k]) => !k.includes("Profile") && !k.includes("Close"),
    ),
  ),
  ...CUSTOM12,
};
const MANIFEST_V12 = "manifest.v1.2.json";
const RAW_IMAGE_SCHEMA = "foxglove.RawImage";
const RAW_IMAGE_DESC = "foxglove-raw-image.desc";
const JSON_MESSAGE_MAX = 65536; // v1.2: per JSON evidence message, checked before parsing
const RAW_DATA_MAX = 16_777_216;
const RAW_MESSAGE_MAX = RAW_DATA_MAX + 4096;
const RAW_DIM_MAX = 4096;
const DEPTH_FRAME_ID = "depth_optical_frame";
const INT64_MAX = 2n ** 63n - 1n;
const TOLERANCE = 1e-9;
const MAGIC = Buffer.from("\x89MCAP0\r\n", "latin1");
const sha256 = (b) => createHash("sha256").update(b).digest("hex");
class Truncated extends Error {}
class Malformed extends Error {}
class Unsupported extends Error {}
class CrcMismatch extends Error {}
class DefinitionOrder extends Error {}
class DefinitionConflict extends Error {}

function str(buf, off) {
  if (off + 4 > buf.length) throw new Truncated();
  const n = buf.readUInt32LE(off);
  if (off + 4 + n > buf.length) throw new Truncated();
  return [buf.subarray(off + 4, off + 4 + n).toString("utf8"), off + 4 + n];
}

// Supported layout (see capture_conformance.py): Header first; only Schema/Channel/Message records; one
// DataEnd with a nonzero CRC-32 of every preceding byte; a Footer without summary; the closing magic.
// Definitions are checked in file order: a Channel's nonzero schema id and a Message's channel id must already
// be defined (E_DEFINITION_ORDER); a repeated Schema/Channel id must repeat the identical record body and Schema
// id 0 is reserved (E_DEFINITION_CONFLICT).
export function readMcap(data) {
  let out;
  try {
    out = readMcapRecords(data);
  } catch (e) {
    if (e instanceof RangeError) throw new Truncated();
    throw e;
  }
  return out;
}

function readMcapRecords(data) {
  if (
    data.length < MAGIC.length ||
    !data.subarray(0, MAGIC.length).equals(MAGIC)
  )
    throw new Truncated();
  let pos = MAGIC.length;
  const out = {
    profile: null,
    schemas: new Map(),
    channels: new Map(),
    messages: [],
  };
  let dataEnd = false;
  const raw = { 3: new Map(), 4: new Map() }; // id -> exact record body
  const define = (op, id, body) => {
    const prior = raw[op].get(id);
    if (prior !== undefined && !prior.equals(body))
      throw new DefinitionConflict();
    raw[op].set(id, body);
  };
  for (;;) {
    if (pos === data.length || pos + 9 > data.length) throw new Truncated();
    const recordStart = pos;
    const op = data[pos];
    const len = data.readBigUInt64LE(pos + 1);
    const start = pos + 9;
    if (len > BigInt(data.length - start)) throw new Truncated();
    const body = data.subarray(start, start + Number(len));
    pos = start + Number(len);
    if ((op === 0x01) !== (recordStart === MAGIC.length))
      throw new Unsupported();
    if (dataEnd && op !== 0x02) throw new Unsupported();
    if (op === 0x01) out.profile = str(body, 0)[0];
    else if (op === 0x03) {
      const [name, o1] = str(body, 2);
      const [encoding, o2] = str(body, o1);
      const n = body.readUInt32LE(o2);
      if (o2 + 4 + n > body.length) throw new Truncated();
      const sid = body.readUInt16LE(0);
      if (sid === 0) throw new DefinitionConflict();
      define(3, sid, body);
      out.schemas.set(sid, {
        name,
        encoding,
        data: body.subarray(o2 + 4, o2 + 4 + n),
      });
    } else if (op === 0x04) {
      const [topic, o1] = str(body, 4);
      const encoding = str(body, o1)[0];
      const cid = body.readUInt16LE(0);
      const schemaId = body.readUInt16LE(2);
      if (schemaId !== 0 && !out.schemas.has(schemaId))
        throw new DefinitionOrder();
      define(4, cid, body);
      out.channels.set(cid, { schemaId, topic, encoding });
    } else if (op === 0x05) {
      const channel = body.readUInt16LE(0);
      const message = {
        channel,
        sequence: body.readUInt32LE(2),
        logTime: body.readBigUInt64LE(6),
        pos: out.messages.length,
        data: body.subarray(22),
      };
      body.readBigUInt64LE(14); // publish_time: a short record is truncated in every reader
      if (!out.channels.has(channel)) throw new DefinitionOrder();
      out.messages.push(message);
    } else if (op === 0x0f) {
      const crc = body.readUInt32LE(0);
      dataEnd = true;
      if (crc === 0 || crc !== crc32(data.subarray(0, recordStart)))
        throw new CrcMismatch();
    } else if (op === 0x02) {
      if (!dataEnd) throw new Unsupported();
      if (
        body.readBigUInt64LE(0) !== 0n ||
        body.readBigUInt64LE(8) !== 0n ||
        body.readUInt32LE(16) !== 0
      )
        throw new Unsupported();
      if (
        pos + MAGIC.length !== data.length ||
        !data.subarray(pos).equals(MAGIC)
      )
        throw new Truncated();
      return out;
    } else throw new Unsupported();
  }
}

function varint(buf, pos) {
  let shift = 0n,
    value = 0n;
  for (;;) {
    if (pos >= buf.length || shift > 63n) throw new Malformed();
    const b = buf[pos++];
    value |= BigInt(b & 0x7f) << shift;
    if (!(b & 0x80)) return [value, pos];
    shift += 7n;
  }
}

export function decodeVideo(buf) {
  const out = {
    sec: 0n,
    nanos: 0n,
    frameId: "",
    data: Buffer.alloc(0),
    format: "",
  };
  let pos = 0;
  while (pos < buf.length) {
    let key;
    [key, pos] = varint(buf, pos);
    const field = Number(key >> 3n),
      wire = Number(key & 7n);
    if (wire === 2) {
      let n;
      [n, pos] = varint(buf, pos);
      if (pos + Number(n) > buf.length) throw new Malformed();
      const chunk = buf.subarray(pos, pos + Number(n));
      pos += Number(n);
      if (field === 1) {
        let p = 0;
        while (p < chunk.length) {
          let k, v;
          [k, p] = varint(chunk, p);
          [v, p] = varint(chunk, p);
          if (k >> 3n === 1n) out.sec = v;
          else out.nanos = v;
        }
      } else if (field === 2) out.frameId = chunk.toString("utf8");
      else if (field === 3) out.data = chunk;
      else if (field === 4) out.format = chunk.toString("utf8");
    } else if (wire === 0) [, pos] = varint(buf, pos);
    else throw new Malformed();
  }
  return out;
}

// foxglove.RawImage (v1.2): field number -> [name, wire type]. width/height/step are fixed32 (wire 5).
const RAW_FIELDS = new Map([
  [1, ["timestamp", 2]],
  [2, ["width", 5]],
  [3, ["height", 5]],
  [4, ["encoding", 2]],
  [5, ["step", 5]],
  [6, ["data", 2]],
  [7, ["frame_id", 2]],
]);
// Strict UTF-8 that keeps a leading BOM, exactly like Python bytes.decode().
const UTF8_STRICT = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const utf8Strict = (b) => {
  try {
    return UTF8_STRICT.decode(b);
  } catch {
    throw new Malformed();
  }
};

function rawTimestamp(chunk) {
  let sec = 0n,
    nanos = 0n;
  const seen = new Set();
  let pos = 0;
  while (pos < chunk.length) {
    let key, v;
    [key, pos] = varint(chunk, pos);
    const field = Number(key >> 3n),
      wire = Number(key & 7n);
    if (wire !== 0 || (field !== 1 && field !== 2) || seen.has(field))
      throw new Malformed();
    seen.add(field);
    [v, pos] = varint(chunk, pos);
    if (field === 1) sec = v;
    else nanos = v;
  }
  if (sec > INT64_MAX || nanos >= 1_000_000_000n) throw new Malformed();
  return sec * 1_000_000_000n + nanos;
}

// Strict foxglove.RawImage decoder: only fields 1..7 with their exact wire types, no duplicates, lengths
// checked against the buffer before slicing, dimensions and sizes bounded before use.
export function decodeRawImage(buf) {
  if (buf.length > RAW_MESSAGE_MAX) throw new Malformed();
  const out = {
    captureNs: 0n,
    frameId: "",
    encoding: "",
    width: 0,
    height: 0,
    step: 0,
    data: Buffer.alloc(0),
  };
  const seen = new Set();
  let pos = 0;
  while (pos < buf.length) {
    let key;
    [key, pos] = varint(buf, pos);
    const field = Number(key >> 3n),
      wire = Number(key & 7n);
    const known = RAW_FIELDS.get(field);
    if (!known || known[1] !== wire || seen.has(field)) throw new Malformed();
    seen.add(field);
    if (wire === 5) {
      if (buf.length - pos < 4) throw new Malformed();
      out[known[0]] = buf.readUInt32LE(pos);
      pos += 4;
      continue;
    }
    let n;
    [n, pos] = varint(buf, pos);
    if (n > BigInt(buf.length - pos)) throw new Malformed();
    const len = Number(n);
    const chunk = buf.subarray(pos, pos + len);
    pos += len;
    if (field === 1) out.captureNs = rawTimestamp(chunk);
    else if (field === 6) {
      if (len > RAW_DATA_MAX) throw new Malformed();
      out.data = chunk;
    } else if (field === 4) out.encoding = utf8Strict(chunk);
    else out.frameId = utf8Strict(chunk);
  }
  if (
    !seen.has(1) ||
    !(out.width >= 1 && out.width <= RAW_DIM_MAX) ||
    !(out.height >= 1 && out.height <= RAW_DIM_MAX)
  )
    throw new Malformed();
  return out;
}

export function nals(d) {
  const starts = [];
  for (let i = 0; i + 2 < d.length; ) {
    if (d[i] === 0 && d[i + 1] === 0 && d[i + 2] === 1) {
      starts.push([i, 3]);
      i += 3;
    } else if (
      d[i] === 0 &&
      d[i + 1] === 0 &&
      i + 3 < d.length &&
      d[i + 2] === 0 &&
      d[i + 3] === 1
    ) {
      starts.push([i, 4]);
      i += 4;
    } else i++;
  }
  if (!starts.length || starts[0][0] !== 0) return null;
  return starts.map(([s, k], n) =>
    d.subarray(s + k, n + 1 < starts.length ? starts[n + 1][0] : d.length),
  );
}

function unescape(b) {
  const out = [];
  let zeros = 0;
  for (const x of b) {
    if (zeros >= 2 && x === 3) {
      zeros = 0;
      continue;
    }
    out.push(x);
    zeros = x === 0 ? zeros + 1 : 0;
  }
  return out;
}

function sliceHeader(nal) {
  const bits = unescape(nal.subarray(1, 12))
    .map((x) => x.toString(2).padStart(8, "0"))
    .join("");
  const vals = [];
  let p = 0;
  for (let i = 0; i < 2; i++) {
    let z = 0;
    while (p + z < bits.length && bits[p + z] === "0") z++;
    if (p + 2 * z + 1 > bits.length) return null;
    vals.push(parseInt(bits.slice(p + z, p + 2 * z + 1), 2) - 1);
    p += 2 * z + 1;
  }
  return vals;
}

export function classifyAu(d) {
  const units = nals(d);
  if (!units) return [["E_NOT_ANNEXB"], false];
  const types = units.map((n) => n[0] & 31);
  const slices = units.filter((n) => [1, 5].includes(n[0] & 31));
  if (!slices.length) return [["E_CONFIG_ONLY"], false];
  const errors = [];
  const headers = slices.map(sliceHeader);
  const firsts = headers.filter((h) => h !== null && h[0] === 0).length;
  if (headers.some((h) => h === null) || firsts === 0)
    errors.push("E_PARTIAL_ACCESS_UNIT");
  else if (firsts > 1) errors.push("E_MULTIPLE_ACCESS_UNITS");
  else if (headers.some((h) => h[1] % 5 === 1)) errors.push("E_B_FRAME");
  const idr = types.includes(5);
  if (idr) {
    const before = types.slice(
      0,
      types.findIndex((t) => t === 1 || t === 5),
    );
    if (!before.includes(7) || !before.includes(8))
      errors.push("E_MISSING_PARAMETER_SETS");
  }
  return [errors, idr];
}

function decodePose(d) {
  if (d.length < 16 || d.readUInt32LE(0) !== 0x00000100) throw new Malformed();
  const sec = d.readInt32LE(4),
    nanosec = d.readUInt32LE(8),
    n = d.readUInt32LE(12);
  return {
    sec,
    nanosec,
    frame_id: d.subarray(16, 16 + n - 1).toString("utf8"),
  };
}

const POSE_SCHEMA = "geometry_msgs/msg/PoseStamped";
const POSE_SCHEMA_FILE = "geometry_msgs-PoseStamped.ros2msg";
const JSON_ENC = ["jsonschema", "json"];
// topic -> [schema name, schema encoding, message encoding]: the reviewed channel table.
const CHANNELS = new Map([
  [
    "/stateaction/capture_profile",
    ["stateaction.capture.Profile.v1", ...JSON_ENC],
  ],
  ["/stateaction/clocks", ["stateaction.capture.Clocks.v1", ...JSON_ENC]],
  ["/stateaction/inventory", ["stateaction.capture.Inventory.v1", ...JSON_ENC]],
  [
    "/stateaction/frame_events",
    ["stateaction.capture.FrameEvent.v1", ...JSON_ENC],
  ],
  [
    "/stateaction/imu/accel",
    ["stateaction.capture.MotionEvent.v1", ...JSON_ENC],
  ],
  [
    "/stateaction/imu/gyro",
    ["stateaction.capture.MotionEvent.v1", ...JSON_ENC],
  ],
  [
    "/stateaction/sensor_events",
    ["stateaction.capture.SensorEvent.v1", ...JSON_ENC],
  ],
  ["/stateaction/close", ["stateaction.capture.Close.v1", ...JSON_ENC]],
  [VIDEO, ["foxglove.CompressedVideo", "protobuf", "protobuf"]],
  ["/tracking/pose", [POSE_SCHEMA, "ros2msg", "cdr"]],
]);
const JSON_ENC12 = ["jsonschema", "json"];
const RAW_ENC = [RAW_IMAGE_SCHEMA, "protobuf", "protobuf"];
// v1.2 table: v1.1 entries unchanged except Profile.v2 / Close.v2, plus the optional new channels.
const CHANNELS12 = new Map([
  ...[...CHANNELS].filter(
    ([t]) => t !== "/stateaction/capture_profile" && t !== "/stateaction/close",
  ),
  ["/stateaction/capture_profile", [PROFILE_V2, ...JSON_ENC12]],
  ["/stateaction/close", ["stateaction.capture.Close.v2", ...JSON_ENC12]],
  [
    "/stateaction/calibrations",
    ["stateaction.capture.Calibration.v1", ...JSON_ENC12],
  ],
  [
    "/stateaction/depth_events",
    ["stateaction.capture.DepthEvent.v1", ...JSON_ENC12],
  ],
  [
    "/stateaction/camera_metadata",
    ["stateaction.capture.CameraMetadata.v1", ...JSON_ENC12],
  ],
  ["/camera/depth_raw/image", RAW_ENC],
  ["/camera/depth_raw/confidence", RAW_ENC],
  ["/camera/depth_dense/image", RAW_ENC],
]);
const DEPTH_IMAGE_TOPICS = [
  "/camera/depth_raw/image",
  "/camera/depth_raw/confidence",
  "/camera/depth_dense/image",
];
const IDENTITY_KEYS = [
  "recording_id",
  "stream_id",
  "native_timestamp_ns",
  "native_clock_id",
  "mapped_capture_time_ns",
  "clock_mapping_revision",
  "calibration_id",
  "encoder_pts_us",
  "encoder_time_base",
  "native_timestamps",
];
const isDecimal = (v) => typeof v === "string" && /^(0|[1-9][0-9]*)$/.test(v);
const isObject = (v) =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const same = (a, b) => canonical(a ?? null) === canonical(b ?? null);

const SCHEMAS = new Map();
// The reviewed contract schema (never the file's embedded copy, which is only hash-compared).
function contractSchema(name) {
  if (!SCHEMAS.has(name))
    SCHEMAS.set(
      name,
      new Schema(
        JSON.parse(
          readFileSync(join(CAP, { ...CUSTOM, ...CUSTOM12 }[name]), "utf8"),
        ),
      ),
    );
  return SCHEMAS.get(name);
}
const SINGLETON_TOPICS = [
  "/stateaction/capture_profile",
  "/stateaction/clocks",
  "/stateaction/inventory",
  "/stateaction/close",
];

// Revision dispatch: the schema record name of any /stateaction/capture_profile channel.
function usesV12(f) {
  return [...f.channels.values()].some(
    (ch) =>
      ch.topic === "/stateaction/capture_profile" &&
      f.schemas.get(ch.schemaId)?.name === PROFILE_V2,
  );
}

// maxRevision "v1.1" reproduces a frozen v1.1 reader: every v1.2 file is rejected.
export function check(data, explicitManifest = null, maxRevision = "v1.2") {
  const errors = new Set();
  const reject = () => ({
    outcome: "reject",
    errors: [...errors].sort(),
    facts: {},
  });
  let f;
  try {
    f = readMcap(data);
  } catch (e) {
    if (e instanceof Truncated)
      return { outcome: "reject", errors: ["E_TRUNCATED"], facts: {} };
    if (e instanceof Unsupported)
      return { outcome: "reject", errors: ["E_UNSUPPORTED_LAYOUT"], facts: {} };
    if (e instanceof CrcMismatch)
      return { outcome: "reject", errors: ["E_DATA_CRC"], facts: {} };
    if (e instanceof DefinitionOrder)
      return { outcome: "reject", errors: ["E_DEFINITION_ORDER"], facts: {} };
    if (e instanceof DefinitionConflict)
      return {
        outcome: "reject",
        errors: ["E_DEFINITION_CONFLICT"],
        facts: {},
      };
    throw e;
  }
  if (f.profile !== "") errors.add("E_PROFILE_NOT_EMPTY");
  const byTopic = new Map();
  for (const m of f.messages) {
    const t = f.channels.get(m.channel).topic;
    if (!byTopic.has(t)) byTopic.set(t, []);
    byTopic.get(t).push(m);
  }
  const names = new Set([...f.schemas.values()].map((s) => s.name));
  const facts = {
    channel_counts: Object.fromEntries(
      [...byTopic]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([t, v]) => [t, v.length]),
    ),
  };
  if (
    names.has("sensor_msgs/msg/CompressedImage") &&
    !names.has("foxglove.CompressedVideo")
  ) {
    const img = byTopic.get("/camera/rgb/image/compressed") ?? [];
    facts.legacy_images = img.length;
    facts.legacy_log_times_ns = img.map((m) => m.logTime.toString());
    return { outcome: "legacy_jpeg", errors: ["E_LEGACY_JPEG"], facts };
  }
  const rev12 = maxRevision !== "v1.1" && usesV12(f);
  const CHANNELS_ = rev12 ? CHANNELS12 : CHANNELS;
  const CUSTOM_ = rev12 ? CUSTOM_V12_TABLE : CUSTOM;
  const manifest =
    explicitManifest ??
    JSON.parse(
      readFileSync(join(CAP, rev12 ? MANIFEST_V12 : "manifest.json"), "utf8"),
    ).files;
  // Exact per-channel encodings and reviewed schema identity.
  for (const ch of f.channels.values()) {
    const schema = f.schemas.get(ch.schemaId);
    const want = CHANNELS_.get(ch.topic);
    if (
      !schema ||
      !want ||
      schema.name !== want[0] ||
      schema.encoding !== want[1] ||
      ch.encoding !== want[2]
    )
      errors.add("E_CHANNEL_ENCODING");
    else if (
      schema.name === POSE_SCHEMA &&
      sha256(schema.data) !== manifest[POSE_SCHEMA_FILE]
    )
      errors.add("E_CHANNEL_ENCODING");
  }
  const descriptor = manifest["foxglove-compressed-video.desc"];
  const hashes = {};
  for (const s of f.schemas.values()) {
    const digest = sha256(s.data);
    hashes[s.name] = digest;
    if (s.name === "foxglove.CompressedVideo") {
      if (digest !== descriptor) errors.add("E_DESCRIPTOR_HASH");
    } else if (rev12 && s.name === RAW_IMAGE_SCHEMA) {
      if (digest !== manifest[RAW_IMAGE_DESC]) errors.add("E_DESCRIPTOR_HASH");
    } else if (CUSTOM_[s.name]) {
      if (digest !== manifest[CUSTOM_[s.name]]) errors.add("E_SCHEMA_MISMATCH");
    }
  }
  facts.schema_sha256 = Object.fromEntries(
    Object.entries(hashes).sort(([a], [b]) => (a < b ? -1 : 1)),
  );
  // Decode every message once; an undecodable message is a defined reject.
  const decoded = new Map();
  try {
    for (const [topic, msgs] of byTopic) {
      const want = CHANNELS_.get(topic);
      if (!want) continue;
      if (want[2] === "json") {
        if (rev12 && msgs.some((m) => m.data.length > JSON_MESSAGE_MAX))
          throw new Malformed();
        decoded.set(
          topic,
          msgs.map((m) => parseJson(m.data)),
        );
      } else if (want[2] === "protobuf") {
        const decode = topic === VIDEO ? decodeVideo : decodeRawImage;
        decoded.set(
          topic,
          msgs.map((m) => decode(m.data)),
        );
      } else
        decoded.set(
          topic,
          msgs.map((m) => decodePose(m.data)),
        );
    }
  } catch (e) {
    if (
      e instanceof Malformed ||
      e instanceof MalformedJson ||
      e instanceof RangeError
    ) {
      errors.add("E_MALFORMED_MESSAGE");
      return reject();
    }
    throw e;
  }
  // Strict schema gate: violations are reported exactly and stop evaluation.
  const violations = [];
  for (const topic of [...decoded.keys()].sort()) {
    const [schemaName, , encoding] = CHANNELS_.get(topic);
    if (encoding !== "json") continue;
    const validator = contractSchema(schemaName);
    decoded.get(topic).forEach((value, i) => {
      for (const v of validator.validate(value))
        violations.push(`${topic}[${i}]${v}`);
    });
  }
  if (violations.length) {
    errors.add("E_SCHEMA_MALFORMED");
    return {
      outcome: "reject",
      errors: [...errors].sort(),
      facts: { schema_violations: violations.sort() },
    };
  }
  if (SINGLETON_TOPICS.some((t) => (decoded.get(t) ?? []).length !== 1))
    errors.add("E_CHANNEL_CARDINALITY");
  const recordingIds = new Set();
  for (const [topic, values] of decoded)
    if (CHANNELS_.get(topic)[2] === "json")
      for (const x of values) recordingIds.add(x.recording_id);
  if (recordingIds.size > 1) errors.add("E_RECORDING_ID");
  const js = (t) => decoded.get(t) ?? [];
  const clocks = js("/stateaction/clocks")[0]?.stream_clocks ?? {};
  const inventory = js("/stateaction/inventory")[0] ?? {};
  const knownCalibrations = new Set(
    (Array.isArray(inventory.calibrations) ? inventory.calibrations : [])
      .filter(isObject)
      .map((c) => c.calibration_id),
  );
  const frames = js("/stateaction/frame_events");
  const ptsSeen = new Set(),
    acquired = new Map(),
    written = new Map(),
    state = new Map(),
    submitted = new Set(),
    dropReasons = new Map();
  const counts = { acquired: 0, submitted: 0, written: 0, dropped: 0 };
  for (const e of frames) {
    const sid = e.source_frame_id;
    const st = e.state;
    // Lifecycle: acquired once, then at most one submit and exactly one terminal outcome;
    // every later event repeats the acquired identity (clock, PTS, calibration, time base).
    if (st === "acquired") {
      if (acquired.has(sid)) errors.add("E_FRAME_IDENTITY");
    } else if (
      !acquired.has(sid) ||
      ["written", "dropped"].includes(state.get(sid)) ||
      (st === "submitted" && submitted.has(sid))
    )
      errors.add("E_FRAME_IDENTITY");
    else {
      const original = acquired.get(sid);
      if (IDENTITY_KEYS.some((k) => !same(e[k], original[k])))
        errors.add("E_FRAME_IDENTITY");
    }
    if (
      (st === "acquired" || st === "written") &&
      clocks[e.stream_id] !== e.native_clock_id
    )
      errors.add("E_CLOCK_MISMATCH");
    if (st === "acquired") {
      if (ptsSeen.has(e.encoder_pts_us)) errors.add("E_DUPLICATE_PTS");
      ptsSeen.add(e.encoder_pts_us);
      if (!knownCalibrations.has(e.calibration_id))
        errors.add("E_CALIBRATION_UNKNOWN");
      if (!acquired.has(sid)) acquired.set(sid, e);
    }
    if (st === "submitted") submitted.add(sid);
    if (st === "written" && !written.has(sid)) written.set(sid, e);
    if (st === "dropped")
      dropReasons.set(e.reason, (dropReasons.get(e.reason) ?? 0) + 1);
    counts[st]++;
    if (acquired.has(sid)) state.set(sid, st);
  }
  facts.frame_event_counts = counts;
  const video = byTopic.get(VIDEO) ?? [];
  const videoDecoded = js(VIDEO);
  const writtenSeqs = [...written.values()].map((e) => e.output_sequence);
  const videoSeqs = video.map((m) => m.sequence);
  if (
    new Set(writtenSeqs).size !== writtenSeqs.length ||
    new Set(videoSeqs).size !== videoSeqs.length ||
    writtenSeqs.some((s) => !videoSeqs.includes(s)) ||
    videoSeqs.some((s) => !writtenSeqs.includes(s))
  )
    errors.add("E_SEQUENCE");
  const bySeq = new Map(
    [...written.values()].map((e) => [e.output_sequence, e]),
  );
  facts.video = video.map((m, i) => {
    const v = videoDecoded[i];
    const [auErrors, idr] = classifyAu(v.data);
    auErrors.forEach((x) => errors.add(x));
    if (i === 0 && !idr && !auErrors.length) errors.add("E_FIRST_NOT_IDR");
    const ts = v.sec * 1_000_000_000n + v.nanos;
    const ev = bySeq.get(m.sequence);
    if (v.frameId !== FRAME_ID || v.format !== "h264")
      errors.add("E_VIDEO_FIELDS");
    if (
      ev &&
      (ts.toString() !== ev.mapped_capture_time_ns ||
        Boolean(ev.is_idr) !== idr)
    )
      errors.add("E_VIDEO_TIMESTAMP_MISMATCH");
    return {
      sequence: m.sequence,
      capture_time_ns: ts.toString(),
      log_time_ns: m.logTime.toString(),
      frame_id: v.frameId,
      format: v.format,
      bytes: v.data.length,
      idr,
      sha256: sha256(v.data),
      source_frame_id: ev ? ev.source_frame_id : null,
      encoder_pts_us: ev ? (ev.encoder_pts_us ?? null) : null,
    };
  });
  facts.motion = {};
  for (const topic of ["/stateaction/imu/accel", "/stateaction/imu/gyro"]) {
    const evs = js(topic);
    facts.motion[topic] = evs.map((e) => ({
      event_id: e.event_id,
      native_timestamp_ns: e.native_timestamp_ns,
      mapped_capture_time_ns: e.mapped_capture_time_ns ?? null,
    }));
    for (const e of evs)
      if (clocks[topic.split("/").pop()] !== e.native_clock_id)
        errors.add("E_CLOCK_MISMATCH");
  }
  const sensors = js("/stateaction/sensor_events");
  const resetAt = new Map();
  for (const e of sensors) {
    if (
      e.source_kind === "arcore_pose" &&
      e.tracking_state !== "tracking" &&
      e.pose_valid
    )
      errors.add("E_TRACKING_LOSS_UNMARKED");
    if (e.source_kind === "calibration_reset")
      resetAt.set(e.supersedes_calibration_id, e.association_source_frame_id);
  }
  const cals = new Set();
  for (const e of acquired.values()) {
    cals.add(e.calibration_id);
    const at = resetAt.get(e.calibration_id);
    if (at != null && BigInt(e.source_frame_id) >= BigInt(at))
      errors.add("E_CALIBRATION_RESET_UNMARKED");
  }
  facts.sensor_events = sensors.map((e) => ({
    event_id: e.event_id,
    source_kind: e.source_kind,
    native_timestamp_ns: e.native_timestamp_ns,
    tracking_state: e.tracking_state ?? null,
  }));
  facts.calibrations_used = [...cals].sort();
  const poseMessages = byTopic.get("/tracking/pose") ?? [];
  facts.cdr_poses = js("/tracking/pose").map((p, i) => ({
    sec: p.sec,
    nanosec: p.nanosec,
    frame_id: p.frame_id,
    log_time_ns: poseMessages[i].logTime.toString(),
  }));
  const close = js("/stateaction/close").at(-1);
  let unresolvedAll = null;
  if (close) {
    const dropped = [...state.values()].filter((x) => x === "dropped").length;
    const unresolved = acquired.size - written.size - dropped;
    unresolvedAll = unresolved;
    const expect = Object.fromEntries(
      Object.entries(counts).map(([k, v]) => [k, String(v)]),
    );
    expect.unresolved = String(unresolved);
    const expectMotion = {
      accel: String(js("/stateaction/imu/accel").length),
      gyro: String(js("/stateaction/imu/gyro").length),
    };
    const expectDrops = [...dropReasons]
      .map(([reason, n]) => ({ reason, count: String(n) }))
      .sort((a, b) => (a.reason < b.reason ? -1 : 1));
    if (
      !same(close.frames, expect) ||
      close.video_messages !== String(video.length) ||
      !same(close.motion_events, expectMotion) ||
      close.sensor_events !== String(sensors.length) ||
      !same(
        [...close.drops].sort((a, b) => (a.reason < b.reason ? -1 : 1)),
        expectDrops,
      )
    )
      errors.add("E_COUNT_MISMATCH");
    const outcome = close.outcome;
    if (outcome === "completed" && unresolved !== 0)
      errors.add("E_OUTCOME_MISMATCH");
    else if (outcome === "failed" && (close.failure_reason ?? null) === null)
      errors.add("E_OUTCOME_MISMATCH");
    facts.close_outcome = outcome;
    facts.unresolved_frames = unresolved;
  }
  if (rev12)
    checkV12(errors, facts, byTopic, decoded, acquired, close, unresolvedAll);
  const list = [...errors].sort();
  return {
    outcome: list.length ? "reject" : "accept",
    errors: list,
    facts: list.length ? {} : facts,
  };
}

// ---------------------------------------------------------------- v1.2 rules (SA-68)
const isF32 = (x) => Math.fround(x) === x;
const closeTo = (actual, expected) =>
  Math.abs(actual - expected) <= TOLERANCE * Math.max(1, Math.abs(expected));
const matmul3 = (a, b) => {
  const out = [];
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++)
      out.push(
        a[3 * i] * b[j] + a[3 * i + 1] * b[3 + j] + a[3 * i + 2] * b[6 + j],
      );
  return out;
};
const kForm = (k) =>
  k[0] > 0 &&
  k[4] > 0 &&
  k[1] === 0 &&
  k[3] === 0 &&
  k[6] === 0 &&
  k[7] === 0 &&
  k[8] === 1;

// Saved-raster calibration rules (axis-aligned identity/crop/resize only).
function calibrationValuesOk(c, encoder) {
  const { K: k, P: p, source: src, source_to_saved: t } = c;
  const crop = t.crop;
  if (!(kForm(k) && kForm(src.K))) return false;
  const wantP = [k[0], k[1], k[2], 0, k[3], k[4], k[5], 0, k[6], k[7], k[8], 0];
  if (p.some((x, i) => x !== wantP[i])) return false;
  if (
    crop.left + crop.width > src.width ||
    crop.top + crop.height > src.height ||
    c.saved_width !== t.scaled_width ||
    c.saved_height !== t.scaled_height
  )
    return false;
  if (src.value_type === "float32" && !src.K.every(isF32)) return false;
  const sx = t.scaled_width / crop.width;
  const sy = t.scaled_height / crop.height;
  const m = [
    sx,
    0.0,
    (0.5 - crop.left) * sx - 0.5,
    0.0,
    sy,
    (0.5 - crop.top) * sy - 0.5,
    0.0,
    0.0,
    1.0,
  ];
  if (!t.matrix.every((a, i) => closeTo(a, m[i]))) return false;
  const prod = matmul3(t.matrix, src.K);
  if (!k.every((a, i) => closeTo(a, prod[i]))) return false;
  return !(
    ("width" in encoder && encoder.width !== c.saved_width) ||
    ("height" in encoder && encoder.height !== c.saved_height)
  );
}

// Native plane layout beside the stored (tight) layout; products stay far below 2**63.
function planeOk(p, sample) {
  const crop = p.crop;
  if (
    crop !== null &&
    (crop.x + crop.width > p.native_width ||
      crop.y + crop.height > p.native_height)
  )
    return false;
  const [rw, rh] = crop
    ? [crop.width, crop.height]
    : [p.native_width, p.native_height];
  return (
    p.stored_width === rw &&
    p.stored_height === rh &&
    p.native_pixel_stride_bytes >= sample &&
    p.native_row_stride_bytes >=
      (p.native_width - 1) * p.native_pixel_stride_bytes + sample
  );
}

function inventoryEntry(inventory, sensorId, errors) {
  const entries = (inventory.sensors ?? []).filter(
    (s) => s.sensor_id === sensorId,
  );
  if (entries.length > 1) errors.add("E_COUNT_MISMATCH");
  return entries.length === 1 ? entries[0] : null;
}

function inventoryCount(inventory, sensorId, n, errors) {
  const entry = inventoryEntry(inventory, sensorId, errors);
  if (n > 0) {
    if (
      entry === null ||
      entry.supported !== "yes" ||
      entry.enabled !== "yes" ||
      entry.observed !== "yes" ||
      entry.observed_count !== String(n)
    )
      errors.add("E_COUNT_MISMATCH");
  } else if (
    entry !== null &&
    (entry.observed === "yes" ||
      (entry.observed_count !== null && entry.observed_count !== "0"))
  )
    errors.add("E_COUNT_MISMATCH");
}

const sha = (b) => sha256(b);

function checkV12(
  errors,
  facts,
  byTopic,
  decoded,
  acquired,
  close,
  unresolved,
) {
  const js = (t) => decoded.get(t) ?? [];
  const raw = (t) => byTopic.get(t) ?? [];
  const profile = js("/stateaction/capture_profile")[0] ?? {};
  const clocksMsg = js("/stateaction/clocks")[0] ?? {};
  const clocks = clocksMsg.stream_clocks ?? {};
  const transport = clocksMsg.recorder_transport ?? null;
  const inventory = js("/stateaction/inventory")[0] ?? {};
  const frameEvents = js("/stateaction/frame_events");
  facts.wire_contract_revision = "stateaction.capture.v1.2";

  // ---- mesh / point cloud: declaration only
  for (const sensorId of ["mesh", "point_cloud"]) {
    const entry = inventoryEntry(inventory, sensorId, errors);
    if (
      entry !== null &&
      (entry.observed === "yes" ||
        entry.enabled === "yes" ||
        (entry.observed_count !== null && entry.observed_count !== "0"))
    )
      errors.add("E_UNSUPPORTED_STREAM");
  }

  // ---- calibrations
  const invCals = inventory.calibrations ?? [];
  const ids = invCals.map((c) => c.calibration_id);
  if (new Set(ids).size !== ids.length) errors.add("E_CALIBRATION_VALUES");
  const invById = new Map(invCals.map((c) => [c.calibration_id, c]));
  const calMsgs = js("/stateaction/calibrations");
  const calRaw = raw("/stateaction/calibrations");
  const frameRaw = raw("/stateaction/frame_events");
  const calPos = new Map();
  const calFacts = [];
  calMsgs.forEach((c, idx) => {
    const m = calRaw[idx];
    const cid = c.calibration_id;
    const inv = invById.get(cid);
    if (inv === undefined) {
      errors.add("E_CALIBRATION_UNKNOWN");
      return;
    }
    if (calPos.has(cid) || inv.state !== "yes" || inv.stream_id !== c.stream_id)
      errors.add("E_CALIBRATION_VALUES");
    if (!calPos.has(cid)) calPos.set(cid, m.pos);
    if (!calibrationValuesOk(c, profile.encoder ?? {}))
      errors.add("E_CALIBRATION_VALUES");
    const fi = frameEvents.findIndex((e) => e.calibration_id === cid);
    const firsts = frameEvents.filter(
      (e) => e.calibration_id === cid && e.state === "acquired",
    );
    if (
      fi < 0 ||
      firsts.length === 0 ||
      m.pos > frameRaw[fi].pos ||
      c.first_source_frame_id !== firsts[0].source_frame_id ||
      c.first_native_timestamp_ns !== firsts[0].native_timestamp_ns ||
      c.native_clock_id !== firsts[0].native_clock_id
    )
      errors.add("E_CALIBRATION_ASSOCIATION");
    calFacts.push({
      calibration_id: cid,
      stream_id: c.stream_id,
      saved_width: c.saved_width,
      saved_height: c.saved_height,
      first_source_frame_id: c.first_source_frame_id,
    });
  });
  for (const inv of invCals)
    if (inv.state === "yes" && !calPos.has(inv.calibration_id))
      errors.add("E_CALIBRATION_VALUES");
  facts.calibrations = calFacts;

  // ---- camera metadata
  const meta = js("/stateaction/camera_metadata");
  const seenMeta = new Set();
  for (const e of meta) {
    const frame = acquired.get(e.source_frame_id);
    if (
      frame === undefined ||
      seenMeta.has(e.source_frame_id) ||
      (e.native_timestamp_ns !== null &&
        e.native_timestamp_ns !== frame.native_timestamp_ns)
    )
      errors.add("E_CAMERA_METADATA");
    seenMeta.add(e.source_frame_id);
  }
  inventoryCount(inventory, "camera_metadata", meta.length, errors);
  facts.camera_metadata_count = meta.length;

  // ---- depth
  const events = js("/stateaction/depth_events");
  const images = new Map(DEPTH_IMAGE_TOPICS.map((t) => [t, new Map()]));
  for (const t of DEPTH_IMAGE_TOPICS) {
    const vs = js(t);
    raw(t).forEach((m, i) => {
      const bySeq = images.get(t);
      if (!bySeq.has(m.sequence)) bySeq.set(m.sequence, []);
      bySeq.get(m.sequence).push([m, vs[i]]);
    });
  }
  const used = new Set();
  const take = (topic, sequence) => {
    const got = images.get(topic)?.get(sequence) ?? [];
    if (got.length !== 1 || used.has(`${topic}|${sequence}`)) {
      errors.add("E_DEPTH_EVIDENCE");
      return null;
    }
    used.add(`${topic}|${sequence}`);
    return got[0];
  };
  const offset = transport
    ? BigInt(transport.epoch_anchor_ns) - BigInt(transport.native_anchor_ns)
    : 0n;
  const perStream = new Map();
  const depthFacts = [];
  for (const e of events) {
    const stream = e.stream_id;
    if (!perStream.has(stream))
      perStream.set(stream, {
        ids: new Set(),
        last: null,
        pairs: new Set(),
        events: 0,
        confidence: 0,
      });
    const st = perStream.get(stream);
    st.events++;
    if (st.ids.has(e.event_id)) errors.add("E_DEPTH_EVIDENCE");
    st.ids.add(e.event_id);
    const ts = BigInt(e.native_timestamp_ns),
      epoch = e.clock_epoch;
    // clocks and the capture-timeline basis
    if (clocks[stream] !== e.native_clock_id) errors.add("E_CLOCK_MISMATCH");
    const basis = e.capture_time_basis;
    if (transport === null || e.clock_mapping_revision !== transport.revision)
      errors.add("E_CLOCK_MISMATCH");
    else if (basis === "transport_mapping") {
      if (
        e.native_clock_id !== transport.clock_id ||
        e.receipt_native_timestamp_ns !== null ||
        BigInt(e.capture_time_ns) !== ts + offset
      )
        errors.add("E_CLOCK_MISMATCH");
    } else if (
      e.receipt_native_timestamp_ns === null ||
      BigInt(e.capture_time_ns) !==
        BigInt(e.receipt_native_timestamp_ns) + offset
    )
      errors.add("E_CLOCK_MISMATCH");
    // cadence: native timestamps are preserved verbatim; repeats and resets are explicit
    const last = st.last;
    const rel = e.timestamp_relation;
    let valid;
    if (last === null) valid = rel === "first";
    else if (epoch === last[0])
      valid =
        (rel === "advanced" && ts > last[1]) ||
        (rel === "repeated" && ts === last[1]);
    else valid = rel === "clock_reset" && epoch > last[0];
    if (!valid) errors.add("E_DEPTH_CADENCE");
    const prov = e.estimate_provenance;
    if (
      (rel === "repeated" && prov === "new_estimate") ||
      (rel !== "repeated" && prov === "api_repeat")
    )
      errors.add("E_DEPTH_CADENCE");
    st.last = [epoch, ts];
    st.pairs.add(`${epoch}|${ts}`);
    // associations (exact evidence only)
    const acq = e.acquisition_source_frame_id,
      mea = e.measurement_source_frame_id;
    if (acq !== null && !acquired.has(acq)) errors.add("E_DEPTH_ASSOCIATION");
    if (
      mea !== null &&
      (!acquired.has(mea) ||
        acquired.get(mea).native_clock_id !== e.native_clock_id ||
        acquired.get(mea).native_timestamp_ns !== e.native_timestamp_ns)
    )
      errors.add("E_DEPTH_ASSOCIATION");
    const cal = e.calibration_id;
    if (
      cal !== null &&
      (!invById.has(cal) || invById.get(cal).stream_id !== stream)
    )
      errors.add("E_CALIBRATION_UNKNOWN");
    // image evidence
    const d = e.depth;
    const got = take(d.output_channel, d.output_sequence);
    let depthSha = null;
    if (!planeOk(d, 2)) errors.add("E_DEPTH_EVIDENCE");
    else if (got !== null) {
      const v = got[1];
      const ok =
        v.width === d.stored_width &&
        v.height === d.stored_height &&
        v.encoding === "16UC1" &&
        v.frameId === DEPTH_FRAME_ID &&
        v.step === d.stored_width * 2 &&
        v.data.length === v.step * v.height &&
        v.captureNs.toString() === e.capture_time_ns;
      if (!ok) errors.add("E_DEPTH_EVIDENCE");
      depthSha = sha(v.data);
    }
    const conf = e.confidence;
    let confSha = null,
      confBytes = null;
    if (conf.state === "separate_image") {
      st.confidence++;
      const cgot = take(conf.output_channel, conf.output_sequence);
      const sameLayout =
        [
          "native_width",
          "native_height",
          "stored_width",
          "stored_height",
        ].every((k) => conf[k] === d[k]) && same(conf.crop, d.crop);
      const stamp = conf.native_timestamp;
      if (!planeOk(conf, 1) || !sameLayout) errors.add("E_DEPTH_EVIDENCE");
      if (
        stamp.state === "reported" &&
        stamp.native_clock_id !== clocks.depth_raw_confidence
      )
        errors.add("E_CLOCK_MISMATCH");
      if (cgot !== null) {
        const v = cgot[1];
        const ok =
          v.width === conf.stored_width &&
          v.height === conf.stored_height &&
          v.encoding === "mono8" &&
          v.frameId === DEPTH_FRAME_ID &&
          v.step === conf.stored_width &&
          v.data.length === v.step * v.height &&
          v.captureNs.toString() === e.capture_time_ns;
        if (!ok) errors.add("E_DEPTH_EVIDENCE");
        confSha = sha(v.data);
        confBytes = v.data.length;
      }
    }
    const sep = conf.state === "separate_image";
    depthFacts.push({
      stream_id: stream,
      event_id: e.event_id,
      native_timestamp_ns: e.native_timestamp_ns,
      native_clock_id: e.native_clock_id,
      clock_epoch: epoch,
      timestamp_relation: rel,
      estimate_provenance: prov,
      capture_time_basis: basis,
      capture_time_ns: e.capture_time_ns,
      sequence: d.output_sequence,
      stored_width: d.stored_width,
      stored_height: d.stored_height,
      native_width: d.native_width,
      native_height: d.native_height,
      cropped: d.crop !== null,
      depth_bytes: d.stored_width * d.stored_height * 2,
      depth_sha256: depthSha,
      confidence_state: conf.state,
      confidence_bytes: confBytes,
      confidence_sha256: confSha,
      confidence_timestamp_state: sep ? conf.native_timestamp.state : null,
      confidence_native_timestamp_ns: sep
        ? (conf.native_timestamp.native_timestamp_ns ?? null)
        : null,
    });
  }
  for (const t of DEPTH_IMAGE_TOPICS) // orphans and duplicate sequences
    for (const [sequence, got] of images.get(t))
      if (got.length !== 1 || !used.has(`${t}|${sequence}`))
        errors.add("E_DEPTH_EVIDENCE");
  facts.depth = depthFacts;
  facts.depth_streams = Object.fromEntries(
    [...perStream]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => [
        k,
        { events: v.events, distinct_native_timestamps: v.pairs.size },
      ]),
  );
  for (const stream of ["depth_raw", "depth_dense"])
    inventoryCount(
      inventory,
      stream,
      perStream.get(stream)?.events ?? 0,
      errors,
    );

  // ---- Close.v2
  if (!close) return;
  for (const stream of ["depth_raw", "depth_dense"]) {
    const st = perStream.get(stream);
    const entry = {
      events: String(st?.events ?? 0),
      distinct_native_timestamps: String(st?.pairs.size ?? 0),
    };
    if (stream === "depth_raw")
      entry.confidence_images = String(st?.confidence ?? 0);
    const c = close.depth[stream];
    if (Object.keys(entry).some((k) => c[k] !== entry[k]))
      errors.add("E_COUNT_MISMATCH");
    const repeated = events.some(
      (e) => e.stream_id === stream && e.timestamp_relation === "repeated",
    );
    if (
      (c.retention_policy === "native_updates_only" && repeated) ||
      (c.retention_policy === "all_returned_images" &&
        c.skipped_repeats !== "0")
    )
      errors.add("E_DEPTH_CADENCE");
  }
  if (
    close.calibrations !== String(calMsgs.length) ||
    close.camera_metadata !== String(meta.length)
  )
    errors.add("E_COUNT_MISMATCH");
  const { outcome, stop_reason: reason, encoder_drain: drain } = close;
  const frames = close.frames;
  const bad =
    (outcome === "completed" &&
      (drain !== "eos_reached" ||
        !["user_requested", "duration_limit"].includes(reason))) ||
    ((["writer_error", "encoder_error"].includes(reason) ||
      drain === "encoder_failed") &&
      outcome !== "failed") ||
    ([
      "low_storage_reserve",
      "thermal_critical",
      "session_interrupted",
      "camera_lost",
      "app_terminating",
    ].includes(reason) &&
      !["aborted", "failed"].includes(outcome)) ||
    (drain === "deadline_exceeded" && outcome === "completed") ||
    (drain === "not_started" &&
      (frames.written !== "0" || close.video_messages !== "0")) ||
    (outcome === "unknown" && reason !== "unknown");
  if (bad) errors.add("E_OUTCOME_MISMATCH");
  facts.close_stop_reason = reason;
  facts.encoder_drain = drain;
  facts.auto_admissible =
    outcome === "completed" && unresolved === 0 && drain === "eos_reached";
}

// ---- Encoder buffer sequences (MediaCodec flags: CODEC_CONFIG=2, END_OF_STREAM=4, PARTIAL_FRAME=8)
const START = Buffer.from([0, 0, 0, 1]);

function encoderBufferData(buf, sources) {
  if (!buf.nals) return Buffer.alloc(0);
  const [first, last] = buf.nals;
  let data = Buffer.concat(
    sources[buf.source].slice(first, last).flatMap((n) => [START, n]),
  );
  if (buf.bytes) data = data.subarray(buf.bytes[0], buf.bytes[1]);
  return data;
}

export function assembleEncoderBuffers(buffers, sources) {
  const errors = new Set();
  const aus = [];
  let config = Buffer.alloc(0),
    pending = null;
  let finished = false;
  for (const buf of buffers) {
    const flags = buf.flags;
    const data = encoderBufferData(buf, sources);
    if (flags & 2) {
      if (pending) {
        errors.add("E_INCOMPLETE_AU");
        finished = true;
        break;
      }
      config = data;
      continue;
    }
    if (flags & 4 && data.length === 0) {
      if (pending) errors.add("E_INCOMPLETE_AU");
      finished = true;
      break;
    }
    const pts = buf.pts_us;
    if (!isDecimal(pts)) {
      errors.add("E_PTS_INVALID");
      finished = true;
      break;
    }
    if (pending && pending.pts !== pts) {
      errors.add("E_PARTIAL_PTS_MISMATCH");
      finished = true;
      break;
    }
    let acc = Buffer.concat([pending ? pending.data : Buffer.alloc(0), data]);
    if (flags & 8) {
      pending = { pts, data: acc };
      continue;
    }
    pending = null;
    const units = nals(acc);
    if (units && units.some((n) => (n[0] & 31) === 5)) {
      const types = units.map((n) => n[0] & 31);
      const before = types.slice(
        0,
        types.findIndex((t) => t === 1 || t === 5),
      );
      if ((!before.includes(7) || !before.includes(8)) && config.length)
        acc = Buffer.concat([config, acc]);
    }
    const [auErrors, idr] = classifyAu(acc);
    if (auErrors.length) {
      auErrors.forEach((x) => errors.add(x));
      finished = true;
      break;
    }
    aus.push({ pts_us: pts, idr, bytes: acc.length, sha256: sha256(acc) });
  }
  if (!finished && pending) errors.add("E_INCOMPLETE_AU");
  if (errors.size)
    return { outcome: "reject", errors: [...errors].sort(), aus: [] };
  return { outcome: "accept", errors: [], aus };
}

// Canonical JSON identical to Python json.dumps(sort_keys=True, separators=(',', ':'), ensure_ascii=False).
export function canonical(v) {
  const enc = (x) => {
    if (x === null || typeof x !== "object") return JSON.stringify(x);
    if (Array.isArray(x)) return "[" + x.map(enc).join(",") + "]";
    return (
      "{" +
      Object.keys(x)
        .sort()
        .map((k) => JSON.stringify(k) + ":" + enc(x[k]))
        .join(",") +
      "}"
    );
  };
  return enc(v) + "\n";
}

// Direct foxglove.RawImage build recipe (see fixtures/raw_image_cases.v1.2.json).
function pbVarint(n) {
  let v = BigInt(n);
  const out = [];
  while (v >= 0x80n) {
    out.push(Number(v & 0x7fn) | 0x80);
    v >>= 7n;
  }
  out.push(Number(v));
  return Buffer.from(out);
}
const pbField = (n, payload) =>
  Buffer.concat([pbVarint((n << 3) | 2), pbVarint(payload.length), payload]);
const u32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};
export function buildRaw(r) {
  const frameId =
    r.frame_id_len !== undefined
      ? "x".repeat(r.frame_id_len)
      : "depth_optical_frame";
  const stamp = Buffer.concat([
    Buffer.from([0x08]),
    pbVarint(1_800_000_000),
    Buffer.from([0x10]),
    pbVarint(7),
  ]);
  return Buffer.concat([
    pbField(1, stamp),
    Buffer.from([0x15]),
    u32(r.width),
    Buffer.from([0x1d]),
    u32(r.height),
    pbField(4, Buffer.from(r.encoding)),
    Buffer.from([0x2d]),
    u32(r.step),
    pbField(6, Buffer.alloc(r.data_len, r.fill)),
    pbField(7, Buffer.from(frameId)),
  ]);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let failed = 0;
  const fail = (message) => {
    failed++;
    console.error(message);
  };
  const counts = {};
  // One golden corpus directory: byte hash, byte-exact expected result, declared verdict, declared schema
  // violations, and the frozen v1.1 reader (max_revision v1.1) verdict.
  const runCorpus = (label, dir, frozenReader) => {
    const declared = JSON.parse(readFileSync(join(dir, "cases.json"), "utf8"));
    const names = readdirSync(dir)
      .filter((n) => n.endsWith(".mcap"))
      .map((n) => n.slice(0, -5))
      .sort();
    if (canonical(names) !== canonical(Object.keys(declared).sort()))
      fail(`${label}: *.mcap and cases.json disagree`);
    for (const name of names) {
      const bytes = readFileSync(join(dir, name + ".mcap"));
      const want = declared[name];
      if (want?.sha256 && sha256(bytes) !== want.sha256)
        fail(`${label} DRIFT ${name}`);
      const result = check(bytes);
      const actual = canonical(result);
      const expected = readFileSync(
        join(dir, "expected", name + ".json"),
        "utf8",
      );
      if (actual !== expected)
        fail(
          `MISMATCH ${label}/${name}\n  actual:   ${actual.slice(0, 300)}\n  expected: ${expected.slice(0, 300)}`,
        );
      // The independently declared outcome and error codes are the oracle for rejections.
      if (
        want &&
        (result.outcome !== want.expect ||
          canonical(result.errors) !== canonical(want.expected_errors))
      )
        fail(
          `DECLARED ${label}/${name}: got ${result.outcome} ${result.errors}; declared ${want.expect} ${want.expected_errors}`,
        );
      // Declared schema violations (without message index) must match exactly.
      const stripped = (result.facts.schema_violations ?? [])
        .map((v) => v.replace(/\[[0-9]+\]/, ""))
        .sort();
      if (
        want &&
        canonical(stripped) !== canonical(want.expected_violations ?? [])
      )
        fail(`VIOLATIONS ${label}/${name}: ${stripped}`);
      // max_revision=v1.1 reproduces the frozen reader: v1.1 files are unchanged, v1.2 files carry the
      // declared frozen-reader verdict.
      const old = check(bytes, null, "v1.1");
      const oldSummary = { errors: old.errors, outcome: old.outcome };
      if (frozenReader) {
        if (canonical(oldSummary) !== canonical(want.v1_1_reader))
          fail(`FROZEN READER ${label}/${name}: ${canonical(oldSummary)}`);
      } else if (canonical(old) !== canonical(result))
        fail(`FROZEN READER ${label}/${name} differs from default reader`);
    }
    counts[label] = names.length;
  };
  runCorpus("v1.1", join(CAP, "golden"), false);
  runCorpus("v1.2", join(CAP, "golden/v1.2"), true);
  // Direct strict-schema interpreter cases and fail-closed schema loading.
  const runSchemaCases = (file, qualify) => {
    const doc = JSON.parse(readFileSync(join(CAP, "fixtures", file), "utf8"));
    for (const c of doc.cases) {
      const raw =
        c.json === "__INVALID_UTF8__"
          ? Buffer.from([0xff, 0xfe])
          : Buffer.from(c.json, "utf8");
      let got;
      try {
        got = contractSchema(qualify(c.schema)).validate(parseJson(raw));
      } catch (e) {
        if (!(e instanceof MalformedJson)) throw e;
        got = "malformed";
      }
      if (canonical(got) !== canonical(c.expect))
        fail(`SCHEMA CASE ${file} ${c.name}: ${canonical(got)}`);
    }
    return doc;
  };
  const schemaCases = runSchemaCases(
    "schema_cases.json",
    (n) => `stateaction.capture.${n}.v1`,
  );
  const schemaCases12 = runSchemaCases("schema_cases.v1.2.json", (n) => n);
  for (const u of schemaCases.unsupported_schemas) {
    try {
      new Schema(u.schema);
      fail(`UNSUPPORTED SCHEMA ACCEPTED ${u.name}`);
    } catch (e) {
      if (!(e instanceof SchemaUnsupported)) throw e;
    }
  }
  // Direct bounded RawImage decoder cases (including the 16 MiB cap recipes).
  const rawCases = JSON.parse(
    readFileSync(join(CAP, "fixtures/raw_image_cases.v1.2.json"), "utf8"),
  );
  if (
    rawCases.data_cap_bytes !== RAW_DATA_MAX ||
    rawCases.message_cap_bytes !== RAW_MESSAGE_MAX
  )
    fail("RawImage caps differ from the fixture");
  for (const c of rawCases.cases) {
    const data =
      c.hex !== undefined ? Buffer.from(c.hex, "hex") : buildRaw(c.build);
    let verdict = "ok";
    try {
      decodeRawImage(data);
    } catch (e) {
      if (!(e instanceof Malformed)) throw e;
      verdict = "malformed";
    }
    if (verdict !== c.expect) fail(`RAW IMAGE ${c.name}: ${verdict}`);
  }
  const fixture = JSON.parse(
    readFileSync(join(CAP, "fixtures/encoder_buffers.json"), "utf8"),
  );
  const sources = Object.fromEntries(
    Object.entries(fixture.sources).map(([k, v]) => [
      k,
      nals(readFileSync(join(CAP, v))),
    ]),
  );
  for (const [name, c] of Object.entries(fixture.cases)) {
    const got = assembleEncoderBuffers(c.buffers, sources);
    if (canonical(got) !== canonical(c.expect))
      fail(`ENCODER BUFFERS ${name}: ${canonical(got)}`);
  }
  console.log(
    JSON.stringify({
      runner: "typescript",
      cases: counts["v1.1"],
      v12_cases: counts["v1.2"],
      encoder_buffer_cases: Object.keys(fixture.cases).length,
      schema_cases: schemaCases.cases.length,
      v12_schema_cases: schemaCases12.cases.length,
      raw_image_cases: rawCases.cases.length,
      unsupported_schemas: schemaCases.unsupported_schemas.length,
      failed,
    }),
  );
  process.exit(failed ? 1 : 0);
}
