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

function str(buf, off) {
  if (off + 4 > buf.length) throw new Truncated();
  const n = buf.readUInt32LE(off);
  if (off + 4 + n > buf.length) throw new Truncated();
  return [buf.subarray(off + 4, off + 4 + n).toString("utf8"), off + 4 + n];
}

export function readMcap(data) {
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
    else throw new Error("wire type");
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
  if (
    headers.some((h) => h === null) ||
    headers.filter((h) => h[0] === 0).length !== 1
  )
    errors.push("E_PARTIAL_ACCESS_UNIT");
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
  if (d.readUInt32LE(0) !== 0x00000100) throw new Error("CDR header");
  const sec = d.readInt32LE(4),
    nanosec = d.readUInt32LE(8),
    n = d.readUInt32LE(12);
  return {
    sec,
    nanosec,
    frame_id: d.subarray(16, 16 + n - 1).toString("utf8"),
  };
}

export function check(
  data,
  manifest = JSON.parse(readFileSync(join(CAP, "manifest.json"), "utf8")).files,
) {
  const errors = new Set();
  let f;
  try {
    f = readMcap(data);
  } catch (e) {
    if (e instanceof Truncated)
      return { outcome: "reject", errors: ["E_TRUNCATED"], facts: {} };
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
  const descriptor = manifest["foxglove-compressed-video.desc"];
  const hashes = {};
  for (const s of f.schemas.values()) {
    const digest = sha256(s.data);
    hashes[s.name] = digest;
    if (s.name === "foxglove.CompressedVideo") {
      if (digest !== descriptor || s.encoding !== "protobuf")
        errors.add("E_DESCRIPTOR_HASH");
    } else if (CUSTOM[s.name]) {
      if (digest !== manifest[CUSTOM[s.name]] || s.encoding !== "jsonschema")
        errors.add("E_SCHEMA_MISMATCH");
    }
  }
  facts.schema_sha256 = Object.fromEntries(
    Object.entries(hashes).sort(([a], [b]) => (a < b ? -1 : 1)),
  );
  const js = (t) =>
    (byTopic.get(t) ?? []).map((m) => JSON.parse(m.data.toString("utf8")));
  const clocks = js("/stateaction/clocks")[0]?.stream_clocks ?? {};
  const frames = js("/stateaction/frame_events");
  const ptsSeen = new Set(),
    acquired = new Map(),
    written = new Map(),
    state = new Map();
  const counts = { acquired: 0, submitted: 0, written: 0, dropped: 0 };
  for (const e of frames) {
    const sid = e.source_frame_id;
    if (
      (e.state === "acquired" || e.state === "written") &&
      clocks[e.stream_id] !== e.native_clock_id
    )
      errors.add("E_CLOCK_MISMATCH");
    if (
      (e.state === "acquired" || e.state === "written") &&
      !("encoder_pts_us" in e)
    )
      errors.add("E_MISSING_PTS");
    if (e.state === "acquired") {
      if ("encoder_pts_us" in e) {
        if (ptsSeen.has(e.encoder_pts_us)) errors.add("E_DUPLICATE_PTS");
        ptsSeen.add(e.encoder_pts_us);
      }
      acquired.set(sid, e);
    }
    if (e.state === "written") written.set(sid, e);
    counts[e.state]++;
    state.set(sid, e.state);
  }
  facts.frame_event_counts = counts;
  const video = byTopic.get(VIDEO) ?? [];
  const bySeq = new Map(
    [...written.values()].map((e) => [e.output_sequence, e]),
  );
  facts.video = video.map((m, i) => {
    const v = decodeVideo(m.data);
    const [auErrors, idr] = classifyAu(v.data);
    auErrors.forEach((x) => errors.add(x));
    if (i === 0 && !idr && !auErrors.length) errors.add("E_FIRST_NOT_IDR");
    const ts = v.sec * 1_000_000_000n + v.nanos;
    const ev = bySeq.get(m.sequence);
    if (v.frameId !== FRAME_ID || v.format !== "h264")
      errors.add("E_VIDEO_FIELDS");
    if (!ev) errors.add("E_MISSING_PTS");
    else if (
      ts.toString() !== ev.mapped_capture_time_ns ||
      Boolean(ev.is_idr) !== idr
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
  if (video.length !== counts.written) errors.add("E_MISSING_PTS");
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
  for (const e of frames) {
    if (e.state !== "acquired") continue;
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
  facts.cdr_poses = (byTopic.get("/tracking/pose") ?? []).map((m) => ({
    ...(({ sec, nanosec, frame_id }) => ({ sec, nanosec, frame_id }))(
      decodePose(m.data),
    ),
    log_time_ns: m.logTime.toString(),
  }));
  const close = js("/stateaction/close").at(-1);
  if (close) {
    const dropped = [...state.values()].filter((x) => x === "dropped").length;
    const expect = Object.fromEntries(
      Object.entries(counts).map(([k, v]) => [k, String(v)]),
    );
    expect.unresolved = String(acquired.size - written.size - dropped);
    const keys = ["acquired", "dropped", "submitted", "unresolved", "written"];
    if (
      keys.some((k) => close.frames[k] !== expect[k]) ||
      close.video_messages !== String(video.length)
    )
      errors.add("E_COUNT_MISMATCH");
    facts.close_outcome = close.outcome;
  } else errors.add("E_COUNT_MISMATCH");
  const list = [...errors].sort();
  return {
    outcome: list.length ? "reject" : "accept",
    errors: list,
    facts: list.length ? {} : facts,
  };
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
  let failed = 0;
  const names = readdirSync(gold)
    .filter((n) => n.endsWith(".mcap"))
    .map((n) => n.slice(0, -5))
    .sort();
  for (const name of names) {
    const actual = canonical(check(readFileSync(join(gold, name + ".mcap"))));
    const expected = readFileSync(
      join(gold, "expected", name + ".json"),
      "utf8",
    );
    if (actual !== expected) {
      failed++;
      console.error(
        `MISMATCH ${name}\n  actual:   ${actual.slice(0, 300)}\n  expected: ${expected.slice(0, 300)}`,
      );
    }
  }
  console.log(
    JSON.stringify({ runner: "typescript", cases: names.length, failed }),
  );
  process.exit(failed ? 1 : 0);
}
