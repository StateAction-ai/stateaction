// stateaction.capture.v1.1 golden MCAP conformance checker (TypeScript-compatible ESM, no dependencies).
// Port of conformance/python/capture_conformance.py; output must equal golden/expected/<case>.json byte for byte.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
const MAGIC = Buffer.from("\x89MCAP0\r\n", "latin1");
const sha256 = (b) => createHash("sha256").update(b).digest("hex");
class Truncated extends Error {}
class Malformed extends Error {}

function str(buf, off) {
  if (off + 4 > buf.length) throw new Truncated();
  const n = buf.readUInt32LE(off);
  if (off + 4 + n > buf.length) throw new Truncated();
  return [buf.subarray(off + 4, off + 4 + n).toString("utf8"), off + 4 + n];
}

export function readMcap(data) {
  try {
    return readMcapRecords(data);
  } catch (e) {
    if (e instanceof RangeError) throw new Truncated();
    throw e;
  }
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
  for (;;) {
    if (pos === data.length || pos + 9 > data.length) throw new Truncated();
    const op = data[pos];
    const len = Number(data.readBigUInt64LE(pos + 1));
    const start = pos + 9;
    if (start + len > data.length) throw new Truncated();
    const body = data.subarray(start, start + len);
    pos = start + len;
    if (op === 0x01) out.profile = str(body, 0)[0];
    else if (op === 0x03) {
      const [name, o1] = str(body, 2);
      const [encoding, o2] = str(body, o1);
      const n = body.readUInt32LE(o2);
      if (o2 + 4 + n > body.length) throw new Truncated();
      out.schemas.set(body.readUInt16LE(0), {
        name,
        encoding,
        data: body.subarray(o2 + 4, o2 + 4 + n),
      });
    } else if (op === 0x04) {
      const [topic, o1] = str(body, 4);
      out.channels.set(body.readUInt16LE(0), {
        schemaId: body.readUInt16LE(2),
        topic,
        encoding: str(body, o1)[0],
      });
    } else if (op === 0x05) {
      if (!out.channels.has(body.readUInt16LE(0))) throw new Malformed();
      out.messages.push({
        channel: body.readUInt16LE(0),
        sequence: body.readUInt32LE(2),
        logTime: body.readBigUInt64LE(6),
        data: body.subarray(22),
      });
    } else if (op === 0x02) {
      if (
        pos + MAGIC.length !== data.length ||
        !data.subarray(pos).equals(MAGIC)
      )
        throw new Truncated();
      return out;
    }
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
const STATES = ["acquired", "submitted", "written", "dropped"];
const isDecimal = (v) => typeof v === "string" && /^(0|[1-9][0-9]*)$/.test(v);
const isObject = (v) =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const nonEmpty = (v) => typeof v === "string" && v.length > 0;
const same = (a, b) => canonical(a ?? null) === canonical(b ?? null);

function frameEventShapeOk(e) {
  if (!isObject(e) || !STATES.includes(e.state)) return false;
  for (const k of [
    "recording_id",
    "stream_id",
    "native_clock_id",
    "clock_mapping_revision",
    "calibration_id",
  ])
    if (!nonEmpty(e[k])) return false;
  for (const k of [
    "source_frame_id",
    "native_timestamp_ns",
    "mapped_capture_time_ns",
  ])
    if (!isDecimal(e[k])) return false;
  if (!isObject(e.native_timestamps)) return false;
  if (e.state === "dropped" && !nonEmpty(e.reason)) return false;
  if (
    e.state === "written" &&
    !(
      e.output_channel === VIDEO &&
      Number.isInteger(e.output_sequence) &&
      e.output_sequence >= 0 &&
      typeof e.is_idr === "boolean"
    )
  )
    return false;
  return true;
}

export function check(
  data,
  manifest = JSON.parse(readFileSync(join(CAP, "manifest.json"), "utf8")).files,
) {
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
    if (e instanceof Malformed)
      return { outcome: "reject", errors: ["E_MALFORMED_MESSAGE"], facts: {} };
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
  // Exact per-channel encodings and reviewed schema identity.
  for (const ch of f.channels.values()) {
    const schema = f.schemas.get(ch.schemaId);
    const want = CHANNELS.get(ch.topic);
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
    } else if (CUSTOM[s.name]) {
      if (digest !== manifest[CUSTOM[s.name]]) errors.add("E_SCHEMA_MISMATCH");
    }
  }
  facts.schema_sha256 = Object.fromEntries(
    Object.entries(hashes).sort(([a], [b]) => (a < b ? -1 : 1)),
  );
  // Decode every message once; an undecodable message is a defined reject.
  const decoded = new Map();
  try {
    for (const [topic, msgs] of byTopic) {
      const want = CHANNELS.get(topic);
      if (!want) continue;
      if (want[2] === "json") {
        const parsed = msgs.map((m) => JSON.parse(m.data.toString("utf8")));
        if (!parsed.every(isObject)) throw new Malformed();
        decoded.set(topic, parsed);
      } else if (want[2] === "protobuf")
        decoded.set(
          topic,
          msgs.map((m) => decodeVideo(m.data)),
        );
      else
        decoded.set(
          topic,
          msgs.map((m) => decodePose(m.data)),
        );
    }
  } catch (e) {
    if (
      e instanceof Malformed ||
      e instanceof SyntaxError ||
      e instanceof RangeError
    ) {
      errors.add("E_MALFORMED_MESSAGE");
      return reject();
    }
    throw e;
  }
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
    if (!frameEventShapeOk(e)) {
      errors.add("E_SCHEMA_MALFORMED");
      continue;
    }
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
    const tb = e.encoder_time_base;
    if (!(isObject(tb) && tb.numerator === 1 && tb.denominator === 1000000))
      errors.add("E_TIME_BASE");
    if ("encoder_pts_us" in e && !isDecimal(e.encoder_pts_us))
      errors.add("E_PTS_INVALID");
    if (
      (st === "acquired" || st === "written") &&
      clocks[e.stream_id] !== e.native_clock_id
    )
      errors.add("E_CLOCK_MISMATCH");
    if ((st === "acquired" || st === "written") && !("encoder_pts_us" in e))
      errors.add("E_MISSING_PTS");
    if (st === "acquired") {
      if (isDecimal(e.encoder_pts_us)) {
        if (ptsSeen.has(e.encoder_pts_us)) errors.add("E_DUPLICATE_PTS");
        ptsSeen.add(e.encoder_pts_us);
      }
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
  if (close) {
    const dropped = [...state.values()].filter((x) => x === "dropped").length;
    const unresolved = acquired.size - written.size - dropped;
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
    const closeDrops = Array.isArray(close.drops) ? close.drops : null;
    if (
      !same(close.frames, expect) ||
      close.video_messages !== String(video.length) ||
      !same(close.motion_events, expectMotion) ||
      close.sensor_events !== String(sensors.length) ||
      closeDrops === null ||
      !same(
        closeDrops
          .filter(isObject)
          .sort((a, b) => (String(a.reason) < String(b.reason) ? -1 : 1)),
        expectDrops,
      )
    )
      errors.add("E_COUNT_MISMATCH");
    const outcome = close.outcome;
    if (!["completed", "failed", "aborted", "unknown"].includes(outcome))
      errors.add("E_SCHEMA_MALFORMED");
    else if (outcome === "completed" && unresolved !== 0)
      errors.add("E_OUTCOME_MISMATCH");
    else if (outcome === "failed" && !nonEmpty(close.failure_reason))
      errors.add("E_OUTCOME_MISMATCH");
    facts.close_outcome = outcome;
    facts.unresolved_frames = unresolved;
  } else errors.add("E_COUNT_MISMATCH");
  const list = [...errors].sort();
  return {
    outcome: list.length ? "reject" : "accept",
    errors: list,
    facts: list.length ? {} : facts,
  };
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

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const gold = join(CAP, "golden");
  const declared = JSON.parse(readFileSync(join(gold, "cases.json"), "utf8"));
  let failed = 0;
  const fail = (message) => {
    failed++;
    console.error(message);
  };
  const names = readdirSync(gold)
    .filter((n) => n.endsWith(".mcap"))
    .map((n) => n.slice(0, -5))
    .sort();
  if (canonical(names) !== canonical(Object.keys(declared).sort()))
    fail("golden/*.mcap and cases.json disagree");
  for (const name of names) {
    const result = check(readFileSync(join(gold, name + ".mcap")));
    const actual = canonical(result);
    const expected = readFileSync(
      join(gold, "expected", name + ".json"),
      "utf8",
    );
    if (actual !== expected)
      fail(
        `MISMATCH ${name}\n  actual:   ${actual.slice(0, 300)}\n  expected: ${expected.slice(0, 300)}`,
      );
    // The independently declared outcome and error codes are the oracle for rejections.
    const want = declared[name];
    if (
      want &&
      (result.outcome !== want.expect ||
        canonical(result.errors) !== canonical(want.expected_errors))
    )
      fail(
        `DECLARED ${name}: got ${result.outcome} ${result.errors}; declared ${want.expect} ${want.expected_errors}`,
      );
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
      cases: names.length,
      encoder_buffer_cases: Object.keys(fixture.cases).length,
      failed,
    }),
  );
  process.exit(failed ? 1 : 0);
}
