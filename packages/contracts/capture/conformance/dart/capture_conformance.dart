// stateaction.capture.v1.1 golden MCAP conformance checker (Dart, dependency-free).
// Port of conformance/python/capture_conformance.py. Run: dart run capture_conformance.dart <capture-dir>
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'strict_schema.dart';

const videoTopic = '/camera/rgb/video';
const frameIdName = 'camera_optical_frame';
const custom = {
  'stateaction.capture.Profile.v1': 'Profile.schema.json',
  'stateaction.capture.Clocks.v1': 'Clocks.schema.json',
  'stateaction.capture.Inventory.v1': 'Inventory.schema.json',
  'stateaction.capture.FrameEvent.v1': 'FrameEvent.schema.json',
  'stateaction.capture.MotionEvent.v1': 'MotionEvent.schema.json',
  'stateaction.capture.SensorEvent.v1': 'SensorEvent.schema.json',
  'stateaction.capture.Close.v1': 'Close.schema.json',
};
// stateaction.capture.v1.2 (SA-68): selected by the schema record name of /stateaction/capture_profile.
// NEW files only; the v1.1 table above, manifest.json and every v1.1 golden stay frozen.
const profileV2 = 'stateaction.capture.Profile.v2';
const custom12 = {
  profileV2: 'Profile.v2.schema.json',
  'stateaction.capture.Close.v2': 'Close.v2.schema.json',
  'stateaction.capture.Calibration.v1': 'Calibration.schema.json',
  'stateaction.capture.DepthEvent.v1': 'DepthEvent.schema.json',
  'stateaction.capture.CameraMetadata.v1': 'CameraMetadata.schema.json',
};
final customV12Table = <String, String>{
  for (final e in custom.entries)
    if (!e.key.contains('Profile') && !e.key.contains('Close')) e.key: e.value,
  ...custom12,
};
const manifestV12 = 'manifest.v1.2.json';
const rawImageSchema = 'foxglove.RawImage';
const rawImageDesc = 'foxglove-raw-image.desc';
const jsonMessageMax =
    65536; // v1.2: per JSON evidence message, checked before parsing
const rawDataMax = 16777216;
const rawMessageMax = rawDataMax + 4096;
const rawDimMax = 4096;
const depthFrameId = 'depth_optical_frame';
const tolerance = 1e-9;
final magic = [0x89, 0x4d, 0x43, 0x41, 0x50, 0x30, 0x0d, 0x0a];

class Truncated implements Exception {}

class Malformed implements Exception {}

class DefinitionOrder implements Exception {}

class DefinitionConflict implements Exception {}

class Unsupported implements Exception {}

class CrcMismatch implements Exception {}

// ---- SHA-256 (FIPS 180-4)
String sha256Hex(List<int> data) {
  const k = <int>[
    0x428a2f98,
    0x71374491,
    0xb5c0fbcf,
    0xe9b5dba5,
    0x3956c25b,
    0x59f111f1,
    0x923f82a4,
    0xab1c5ed5,
    0xd807aa98,
    0x12835b01,
    0x243185be,
    0x550c7dc3,
    0x72be5d74,
    0x80deb1fe,
    0x9bdc06a7,
    0xc19bf174,
    0xe49b69c1,
    0xefbe4786,
    0x0fc19dc6,
    0x240ca1cc,
    0x2de92c6f,
    0x4a7484aa,
    0x5cb0a9dc,
    0x76f988da,
    0x983e5152,
    0xa831c66d,
    0xb00327c8,
    0xbf597fc7,
    0xc6e00bf3,
    0xd5a79147,
    0x06ca6351,
    0x14292967,
    0x27b70a85,
    0x2e1b2138,
    0x4d2c6dfc,
    0x53380d13,
    0x650a7354,
    0x766a0abb,
    0x81c2c92e,
    0x92722c85,
    0xa2bfe8a1,
    0xa81a664b,
    0xc24b8b70,
    0xc76c51a3,
    0xd192e819,
    0xd6990624,
    0xf40e3585,
    0x106aa070,
    0x19a4c116,
    0x1e376c08,
    0x2748774c,
    0x34b0bcb5,
    0x391c0cb3,
    0x4ed8aa4a,
    0x5b9cca4f,
    0x682e6ff3,
    0x748f82ee,
    0x78a5636f,
    0x84c87814,
    0x8cc70208,
    0x90befffa,
    0xa4506ceb,
    0xbef9a3f7,
    0xc67178f2,
  ];
  final h = <int>[
    0x6a09e667,
    0xbb67ae85,
    0x3c6ef372,
    0xa54ff53a,
    0x510e527f,
    0x9b05688c,
    0x1f83d9ab,
    0x5be0cd19,
  ];
  const m = 0xffffffff;
  int rotr(int x, int n) => ((x >> n) | (x << (32 - n))) & m;
  final bitLen = data.length * 8;
  final padded = <int>[...data, 0x80];
  while (padded.length % 64 != 56) {
    padded.add(0);
  }
  for (var i = 7; i >= 0; i--) {
    padded.add((bitLen >> (8 * i)) & 0xff);
  }
  final w = List<int>.filled(64, 0);
  for (var off = 0; off < padded.length; off += 64) {
    for (var i = 0; i < 16; i++) {
      w[i] =
          (padded[off + 4 * i] << 24) |
          (padded[off + 4 * i + 1] << 16) |
          (padded[off + 4 * i + 2] << 8) |
          padded[off + 4 * i + 3];
    }
    for (var i = 16; i < 64; i++) {
      final s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >> 3);
      final s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) & m;
    }
    var a = h[0],
        b = h[1],
        c = h[2],
        d = h[3],
        e = h[4],
        f = h[5],
        g = h[6],
        hh = h[7];
    for (var i = 0; i < 64; i++) {
      final t1 =
          (hh +
              (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) +
              ((e & f) ^ ((~e & m) & g)) +
              k[i] +
              w[i]) &
          m;
      final t2 =
          ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) +
              ((a & b) ^ (a & c) ^ (b & c))) &
          m;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) & m;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) & m;
    }
    h[0] = (h[0] + a) & m;
    h[1] = (h[1] + b) & m;
    h[2] = (h[2] + c) & m;
    h[3] = (h[3] + d) & m;
    h[4] = (h[4] + e) & m;
    h[5] = (h[5] + f) & m;
    h[6] = (h[6] + g) & m;
    h[7] = (h[7] + hh) & m;
  }
  return h.map((x) => x.toRadixString(16).padLeft(8, '0')).join();
}

// ---- MCAP
class Message {
  Message(this.channel, this.sequence, this.logTime, this.data, this.pos);
  final int channel, sequence, logTime, pos;
  final Uint8List data;
}

class Mcap {
  String? profile;
  final schemas = <int, ({String name, String encoding, Uint8List data})>{};
  final channels = <int, ({int schemaId, String topic, String encoding})>{};
  final messages = <Message>[];
}

String readStr(ByteData bd, Uint8List b, int off, List<int> next) {
  if (off + 4 > b.length) throw Truncated();
  final n = bd.getUint32(off, Endian.little);
  if (off + 4 + n > b.length) throw Truncated();
  next[0] = off + 4 + n;
  return decodeUtf8Exact(b.sublist(off + 4, off + 4 + n));
}

// Supported layout (see capture_conformance.py): Header first; only Schema/Channel/Message records; one
// DataEnd with a nonzero CRC-32 of every preceding byte; a Footer without summary; the closing magic.
// Definitions are checked in file order: a Channel's nonzero schema id and a Message's channel id must
// already be defined (E_DEFINITION_ORDER); a repeated Schema/Channel id must repeat the identical record
// body and Schema id 0 is reserved (E_DEFINITION_CONFLICT).
Mcap readMcap(Uint8List data) {
  final Mcap out;
  try {
    out = readMcapRecords(data);
  } on RangeError {
    throw Truncated();
  } on FormatException {
    throw Truncated();
  }
  return out;
}

Mcap readMcapRecords(Uint8List data) {
  if (data.length < 8) throw Truncated();
  for (var i = 0; i < 8; i++) {
    if (data[i] != magic[i]) throw Truncated();
  }
  final out = Mcap();
  var pos = 8;
  final all = ByteData.sublistView(data);
  var dataEnd = false;
  final raw = {
    3: <int, Uint8List>{},
    4: <int, Uint8List>{},
  }; // id -> exact body
  void define(int op, int id, Uint8List body) {
    final prior = raw[op]![id];
    if (prior != null) {
      var same = prior.length == body.length;
      for (var i = 0; same && i < body.length; i++) {
        same = prior[i] == body[i];
      }
      if (!same) throw DefinitionConflict();
    }
    raw[op]![id] = body;
  }

  for (;;) {
    if (pos == data.length || pos + 9 > data.length) throw Truncated();
    final recordStart = pos;
    final op = data[pos];
    final len = all.getUint64(pos + 1, Endian.little);
    final start = pos + 9;
    if (len < 0 || len > data.length - start) throw Truncated();
    final body = Uint8List.sublistView(data, start, start + len);
    final bd = ByteData.sublistView(body);
    pos = start + len;
    final nx = [0];
    if ((op == 0x01) != (recordStart == 8)) throw Unsupported();
    if (dataEnd && op != 0x02) throw Unsupported();
    if (op == 0x01) {
      out.profile = readStr(bd, body, 0, nx);
    } else if (op == 0x03) {
      final name = readStr(bd, body, 2, nx);
      final enc = readStr(bd, body, nx[0], nx);
      final n = bd.getUint32(nx[0], Endian.little);
      if (nx[0] + 4 + n > body.length) throw Truncated();
      final sid = bd.getUint16(0, Endian.little);
      if (sid == 0) throw DefinitionConflict();
      define(3, sid, body);
      out.schemas[sid] = (
        name: name,
        encoding: enc,
        data: Uint8List.sublistView(body, nx[0] + 4, nx[0] + 4 + n),
      );
    } else if (op == 0x04) {
      final topic = readStr(bd, body, 4, nx);
      final encoding = readStr(bd, body, nx[0], nx);
      final cid = bd.getUint16(0, Endian.little);
      final schemaId = bd.getUint16(2, Endian.little);
      if (schemaId != 0 && !out.schemas.containsKey(schemaId)) {
        throw DefinitionOrder();
      }
      define(4, cid, body);
      out.channels[cid] = (
        schemaId: schemaId,
        topic: topic,
        encoding: encoding,
      );
    } else if (op == 0x05) {
      final message = Message(
        bd.getUint16(0, Endian.little),
        bd.getUint32(2, Endian.little),
        bd.getUint64(6, Endian.little),
        Uint8List.sublistView(body, 22),
        out.messages.length,
      );
      bd.getUint64(
        14,
        Endian.little,
      ); // publish_time: a short record is truncated in every reader
      if (!out.channels.containsKey(message.channel)) throw DefinitionOrder();
      out.messages.add(message);
    } else if (op == 0x0f) {
      final crc = bd.getUint32(0, Endian.little);
      dataEnd = true;
      if (crc == 0 || crc != crc32(data, 0, recordStart)) throw CrcMismatch();
    } else if (op == 0x02) {
      if (!dataEnd) throw Unsupported();
      if (bd.getUint64(0, Endian.little) != 0 ||
          bd.getUint64(8, Endian.little) != 0 ||
          bd.getUint32(16, Endian.little) != 0) {
        throw Unsupported();
      }
      if (pos + 8 != data.length) throw Truncated();
      for (var i = 0; i < 8; i++) {
        if (data[pos + i] != magic[i]) throw Truncated();
      }
      return out;
    } else {
      throw Unsupported();
    }
  }
}

// ---- Protobuf CompressedVideo
(int, int) varint(Uint8List b, int pos) {
  var shift = 0, value = 0;
  for (;;) {
    if (pos >= b.length || shift > 63) throw Malformed();
    final x = b[pos++];
    value |= (x & 0x7f) << shift;
    if (x & 0x80 == 0) return (value, pos);
    shift += 7;
  }
}

class Video {
  int sec = 0, nanos = 0;
  String frameId = '', format = '';
  Uint8List data = Uint8List(0);
}

Video decodeVideo(Uint8List b) {
  final v = Video();
  var pos = 0;
  while (pos < b.length) {
    final (key, p1) = varint(b, pos);
    pos = p1;
    final field = key >> 3, wire = key & 7;
    if (wire == 2) {
      final (n, p2) = varint(b, pos);
      if (n < 0 || p2 + n > b.length) throw Malformed();
      final chunk = Uint8List.sublistView(b, p2, p2 + n);
      pos = p2 + n;
      if (field == 1) {
        var p = 0;
        while (p < chunk.length) {
          final (k, q1) = varint(chunk, p);
          final (val, q2) = varint(chunk, q1);
          p = q2;
          if (k >> 3 == 1) {
            v.sec = val;
          } else {
            v.nanos = val;
          }
        }
      } else if (field == 2) {
        v.frameId = decodeUtf8Exact(chunk);
      } else if (field == 3) {
        v.data = chunk;
      } else if (field == 4) {
        v.format = decodeUtf8Exact(chunk);
      }
    } else if (wire == 0) {
      pos = varint(b, pos).$2;
    } else {
      throw Malformed();
    }
  }
  return v;
}

// ---- Protobuf foxglove.RawImage (v1.2)
// Varint for the RawImage decoder: every consumer rejects a value >= 2^63 (unknown field number, length
// beyond the buffer, seconds > int64 max, nanos >= 1e9), so such a varint is rejected where it is read.
(int, int) rawVarint(Uint8List b, int pos) {
  var shift = 0, value = 0;
  for (;;) {
    if (pos >= b.length || shift > 63) throw Malformed();
    final x = b[pos++];
    final low = x & 0x7f;
    if (shift == 63 && low != 0) throw Malformed();
    value |= low << shift;
    if (x & 0x80 == 0) return (value, pos);
    shift += 7;
  }
}

// field number -> (name, wire type); width/height/step are fixed32 (wire 5).
const rawFields = <int, (String, int)>{
  1: ('timestamp', 2),
  2: ('width', 5),
  3: ('height', 5),
  4: ('encoding', 2),
  5: ('step', 5),
  6: ('data', 2),
  7: ('frame_id', 2),
};

class RawImage {
  BigInt captureNs = BigInt.zero;
  String frameId = '', encoding = '';
  int width = 0, height = 0, step = 0;
  Uint8List data = Uint8List(0);
}

BigInt rawTimestamp(Uint8List chunk) {
  var sec = 0, nanos = 0;
  final seen = <int>{};
  var pos = 0;
  while (pos < chunk.length) {
    final (key, p1) = rawVarint(chunk, pos);
    final field = key >> 3, wire = key & 7;
    if (wire != 0 || (field != 1 && field != 2) || !seen.add(field)) {
      throw Malformed();
    }
    final (v, p2) = rawVarint(chunk, p1);
    pos = p2;
    if (field == 1) {
      sec = v;
    } else {
      nanos = v;
    }
  }
  if (sec < 0 || nanos >= 1000000000) throw Malformed();
  return BigInt.from(sec) * BigInt.from(1000000000) + BigInt.from(nanos);
}

/// Strict foxglove.RawImage decoder: only fields 1..7 with their exact wire types, no duplicates, lengths
/// checked against the buffer before slicing, dimensions and sizes bounded before use.
RawImage decodeRawImage(Uint8List buf) {
  if (buf.length > rawMessageMax) throw Malformed();
  final out = RawImage();
  final seen = <int>{};
  var pos = 0;
  while (pos < buf.length) {
    final (key, p1) = rawVarint(buf, pos);
    pos = p1;
    final field = key >> 3, wire = key & 7;
    final known = rawFields[field];
    if (known == null || known.$2 != wire || !seen.add(field)) {
      throw Malformed();
    }
    if (wire == 5) {
      if (buf.length - pos < 4) throw Malformed();
      final v = ByteData.sublistView(buf).getUint32(pos, Endian.little);
      pos += 4;
      switch (field) {
        case 2:
          out.width = v;
        case 3:
          out.height = v;
        default:
          out.step = v;
      }
      continue;
    }
    final (n, p2) = rawVarint(buf, pos);
    if (n > buf.length - p2) throw Malformed();
    final chunk = Uint8List.sublistView(buf, p2, p2 + n);
    pos = p2 + n;
    if (field == 1) {
      out.captureNs = rawTimestamp(chunk);
    } else if (field == 6) {
      if (n > rawDataMax) throw Malformed();
      out.data = chunk;
    } else if (field == 4) {
      out.encoding = decodeUtf8Exact(chunk);
    } else {
      out.frameId = decodeUtf8Exact(chunk);
    }
  }
  if (!seen.contains(1) ||
      out.width < 1 ||
      out.width > rawDimMax ||
      out.height < 1 ||
      out.height > rawDimMax) {
    throw Malformed();
  }
  return out;
}

// ---- Annex B
List<Uint8List>? nals(Uint8List d) {
  final starts = <(int, int)>[];
  var i = 0;
  while (i + 2 < d.length) {
    if (d[i] == 0 && d[i + 1] == 0 && d[i + 2] == 1) {
      starts.add((i, 3));
      i += 3;
    } else if (d[i] == 0 &&
        d[i + 1] == 0 &&
        i + 3 < d.length &&
        d[i + 2] == 0 &&
        d[i + 3] == 1) {
      starts.add((i, 4));
      i += 4;
    } else {
      i++;
    }
  }
  if (starts.isEmpty || starts[0].$1 != 0) return null;
  return [
    for (var n = 0; n < starts.length; n++)
      Uint8List.sublistView(
        d,
        starts[n].$1 + starts[n].$2,
        n + 1 < starts.length ? starts[n + 1].$1 : d.length,
      ),
  ];
}

List<int>? sliceHeader(Uint8List nal) {
  final raw = nal.sublist(1, nal.length < 12 ? nal.length : 12);
  final un = <int>[];
  var zeros = 0;
  for (final x in raw) {
    if (zeros >= 2 && x == 3) {
      zeros = 0;
      continue;
    }
    un.add(x);
    zeros = x == 0 ? zeros + 1 : 0;
  }
  final bits = un.map((x) => x.toRadixString(2).padLeft(8, '0')).join();
  final vals = <int>[];
  var p = 0;
  for (var n = 0; n < 2; n++) {
    var z = 0;
    while (p + z < bits.length && bits[p + z] == '0') {
      z++;
    }
    if (p + 2 * z + 1 > bits.length) return null;
    vals.add(int.parse(bits.substring(p + z, p + 2 * z + 1), radix: 2) - 1);
    p += 2 * z + 1;
  }
  return vals;
}

(List<String>, bool) classifyAu(Uint8List d) {
  final units = nals(d);
  if (units == null) return (['E_NOT_ANNEXB'], false);
  final types = [for (final n in units) n[0] & 31];
  final slices = [
    for (final n in units)
      if ((n[0] & 31) == 1 || (n[0] & 31) == 5) n,
  ];
  if (slices.isEmpty) return (['E_CONFIG_ONLY'], false);
  final errors = <String>[];
  final headers = [for (final s in slices) sliceHeader(s)];
  final firsts = headers.where((h) => h != null && h[0] == 0).length;
  if (headers.any((h) => h == null) || firsts == 0) {
    errors.add('E_PARTIAL_ACCESS_UNIT');
  } else if (firsts > 1) {
    errors.add('E_MULTIPLE_ACCESS_UNITS');
  } else if (headers.any((h) => h![1] % 5 == 1)) {
    errors.add('E_B_FRAME');
  }
  final idr = types.contains(5);
  if (idr) {
    final firstImage = types.indexWhere((t) => t == 1 || t == 5);
    final before = types.sublist(0, firstImage);
    if (!before.contains(7) || !before.contains(8))
      errors.add('E_MISSING_PARAMETER_SETS');
  }
  return (errors, idr);
}

Map<String, Object?> decodePose(Uint8List d) {
  final bd = ByteData.sublistView(d);
  if (d.length < 16 || bd.getUint32(0, Endian.little) != 0x00000100) {
    throw Malformed();
  }
  final n = bd.getUint32(12, Endian.little);
  return {
    'sec': bd.getInt32(4, Endian.little),
    'nanosec': bd.getUint32(8, Endian.little),
    'frame_id': decodeUtf8Exact(d.sublist(16, 16 + n - 1)),
  };
}

// ---- Checker
const poseSchema = 'geometry_msgs/msg/PoseStamped';
const poseSchemaFile = 'geometry_msgs-PoseStamped.ros2msg';
const jsonEnc = ['jsonschema', 'json'];
// topic -> [schema name, schema encoding, message encoding]: the reviewed channel table.
const channelTable = <String, List<String>>{
  '/stateaction/capture_profile': [
    'stateaction.capture.Profile.v1',
    ...jsonEnc,
  ],
  '/stateaction/clocks': ['stateaction.capture.Clocks.v1', ...jsonEnc],
  '/stateaction/inventory': ['stateaction.capture.Inventory.v1', ...jsonEnc],
  '/stateaction/frame_events': [
    'stateaction.capture.FrameEvent.v1',
    ...jsonEnc,
  ],
  '/stateaction/imu/accel': ['stateaction.capture.MotionEvent.v1', ...jsonEnc],
  '/stateaction/imu/gyro': ['stateaction.capture.MotionEvent.v1', ...jsonEnc],
  '/stateaction/sensor_events': [
    'stateaction.capture.SensorEvent.v1',
    ...jsonEnc,
  ],
  '/stateaction/close': ['stateaction.capture.Close.v1', ...jsonEnc],
  videoTopic: ['foxglove.CompressedVideo', 'protobuf', 'protobuf'],
  '/tracking/pose': [poseSchema, 'ros2msg', 'cdr'],
};
const rawEnc = [rawImageSchema, 'protobuf', 'protobuf'];
// v1.2 table: v1.1 entries unchanged except Profile.v2 / Close.v2, plus the optional new channels.
final channelTable12 = <String, List<String>>{
  for (final e in channelTable.entries)
    if (e.key != '/stateaction/capture_profile' &&
        e.key != '/stateaction/close')
      e.key: e.value,
  '/stateaction/capture_profile': [profileV2, ...jsonEnc],
  '/stateaction/close': ['stateaction.capture.Close.v2', ...jsonEnc],
  '/stateaction/calibrations': [
    'stateaction.capture.Calibration.v1',
    ...jsonEnc,
  ],
  '/stateaction/depth_events': [
    'stateaction.capture.DepthEvent.v1',
    ...jsonEnc,
  ],
  '/stateaction/camera_metadata': [
    'stateaction.capture.CameraMetadata.v1',
    ...jsonEnc,
  ],
  '/camera/depth_raw/image': rawEnc,
  '/camera/depth_raw/confidence': rawEnc,
  '/camera/depth_dense/image': rawEnc,
};
const depthImageTopics = [
  '/camera/depth_raw/image',
  '/camera/depth_raw/confidence',
  '/camera/depth_dense/image',
];
const identityKeys = [
  'recording_id',
  'stream_id',
  'native_timestamp_ns',
  'native_clock_id',
  'mapped_capture_time_ns',
  'clock_mapping_revision',
  'calibration_id',
  'encoder_pts_us',
  'encoder_time_base',
  'native_timestamps',
];
bool isDecimal(Object? v) =>
    v is String && RegExp(r'^(0|[1-9][0-9]*)$').hasMatch(v);
// Identity comparison uses deep JSON equality (1 == 1.0), exactly like the Python reference.
bool same(Object? a, Object? b) => jsonEqual(a, b);

final _schemas = <String, Schema>{};
String captureDir = '../..';
// The reviewed contract schema (never the file's embedded copy, which is only hash-compared).
Schema contractSchema(String name) => _schemas.putIfAbsent(
  name,
  () => Schema(
    jsonDecode(
          File(
            '$captureDir/${{...custom, ...custom12}[name]}',
          ).readAsStringSync(),
        )
        as Map<String, dynamic>,
  ),
);
const singletonTopics = [
  '/stateaction/capture_profile',
  '/stateaction/clocks',
  '/stateaction/inventory',
  '/stateaction/close',
];

Map<String, Object?> rejectWith(Set<String> errors) => {
  'outcome': 'reject',
  'errors': (errors.toList()..sort()),
  'facts': <String, Object?>{},
};

// Revision dispatch: the schema record name of any /stateaction/capture_profile channel.
bool usesV12(Mcap f) => f.channels.values.any(
  (ch) =>
      ch.topic == '/stateaction/capture_profile' &&
      f.schemas[ch.schemaId]?.name == profileV2,
);

// maxRevision 'v1.1' reproduces a frozen v1.1 reader: every v1.2 file is rejected.
Map<String, Object?> check(
  Uint8List data,
  Map<String, dynamic>? explicitManifest, {
  String maxRevision = 'v1.2',
}) {
  final errors = <String>{};
  final Mcap f;
  try {
    f = readMcap(data);
  } on Truncated {
    return {
      'outcome': 'reject',
      'errors': ['E_TRUNCATED'],
      'facts': <String, Object?>{},
    };
  } on Unsupported {
    return {
      'outcome': 'reject',
      'errors': ['E_UNSUPPORTED_LAYOUT'],
      'facts': <String, Object?>{},
    };
  } on CrcMismatch {
    return {
      'outcome': 'reject',
      'errors': ['E_DATA_CRC'],
      'facts': <String, Object?>{},
    };
  } on DefinitionOrder {
    return {
      'outcome': 'reject',
      'errors': ['E_DEFINITION_ORDER'],
      'facts': <String, Object?>{},
    };
  } on DefinitionConflict {
    return {
      'outcome': 'reject',
      'errors': ['E_DEFINITION_CONFLICT'],
      'facts': <String, Object?>{},
    };
  }
  if (f.profile != '') errors.add('E_PROFILE_NOT_EMPTY');
  final byTopic = <String, List<Message>>{};
  for (final m in f.messages) {
    byTopic.putIfAbsent(f.channels[m.channel]!.topic, () => []).add(m);
  }
  final names = {for (final s in f.schemas.values) s.name};
  final facts = <String, Object?>{
    'channel_counts': {for (final e in byTopic.entries) e.key: e.value.length},
  };
  if (names.contains('sensor_msgs/msg/CompressedImage') &&
      !names.contains('foxglove.CompressedVideo')) {
    final img = byTopic['/camera/rgb/image/compressed'] ?? [];
    facts['legacy_images'] = img.length;
    facts['legacy_log_times_ns'] = [for (final m in img) m.logTime.toString()];
    return {
      'outcome': 'legacy_jpeg',
      'errors': ['E_LEGACY_JPEG'],
      'facts': facts,
    };
  }
  final rev12 = maxRevision != 'v1.1' && usesV12(f);
  final channels = rev12 ? channelTable12 : channelTable;
  final customTable = rev12 ? customV12Table : custom;
  final manifest =
      explicitManifest ??
      (jsonDecode(
                File(
                  '$captureDir/${rev12 ? manifestV12 : 'manifest.json'}',
                ).readAsStringSync(),
              )
              as Map<String, dynamic>)['files']
          as Map<String, dynamic>;
  // Exact per-channel encodings and reviewed schema identity.
  for (final ch in f.channels.values) {
    final schema = f.schemas[ch.schemaId];
    final want = channels[ch.topic];
    if (schema == null ||
        want == null ||
        schema.name != want[0] ||
        schema.encoding != want[1] ||
        ch.encoding != want[2]) {
      errors.add('E_CHANNEL_ENCODING');
    } else if (schema.name == poseSchema &&
        sha256Hex(schema.data) != manifest[poseSchemaFile]) {
      errors.add('E_CHANNEL_ENCODING');
    }
  }
  final descriptor = manifest['foxglove-compressed-video.desc'] as String;
  final hashes = <String, String>{};
  for (final s in f.schemas.values) {
    final digest = sha256Hex(s.data);
    hashes[s.name] = digest;
    if (s.name == 'foxglove.CompressedVideo') {
      if (digest != descriptor) errors.add('E_DESCRIPTOR_HASH');
    } else if (rev12 && s.name == rawImageSchema) {
      if (digest != manifest[rawImageDesc]) errors.add('E_DESCRIPTOR_HASH');
    } else if (customTable.containsKey(s.name)) {
      if (digest != manifest[customTable[s.name]]) {
        errors.add('E_SCHEMA_MISMATCH');
      }
    }
  }
  facts['schema_sha256'] = hashes;
  // Decode every message once; an undecodable message is a defined reject.
  final decoded = <String, List<Object?>>{};
  try {
    for (final entry in byTopic.entries) {
      final want = channels[entry.key];
      if (want == null) continue;
      if (want[2] == 'json') {
        if (rev12 && entry.value.any((m) => m.data.length > jsonMessageMax)) {
          throw Malformed();
        }
        decoded[entry.key] = [for (final m in entry.value) parseJson(m.data)];
      } else if (want[2] == 'protobuf') {
        decoded[entry.key] = [
          for (final m in entry.value)
            entry.key == videoTopic
                ? decodeVideo(m.data)
                : decodeRawImage(m.data),
        ];
      } else {
        decoded[entry.key] = [for (final m in entry.value) decodePose(m.data)];
      }
    }
  } on Malformed {
    errors.add('E_MALFORMED_MESSAGE');
    return rejectWith(errors);
  } on MalformedJson {
    errors.add('E_MALFORMED_MESSAGE');
    return rejectWith(errors);
  } on FormatException {
    errors.add('E_MALFORMED_MESSAGE');
    return rejectWith(errors);
  } on RangeError {
    errors.add('E_MALFORMED_MESSAGE');
    return rejectWith(errors);
  } on TypeError {
    errors.add('E_MALFORMED_MESSAGE');
    return rejectWith(errors);
  }
  // Strict schema gate: violations are reported exactly and stop evaluation.
  final violations = <String>[];
  for (final topic in decoded.keys.toList()..sort()) {
    final want = channels[topic]!;
    if (want[2] != 'json') continue;
    final validator = contractSchema(want[0]);
    final values = decoded[topic]!;
    for (var i = 0; i < values.length; i++) {
      for (final v in validator.validate(values[i])) {
        violations.add('$topic[$i]$v');
      }
    }
  }
  if (violations.isNotEmpty) {
    errors.add('E_SCHEMA_MALFORMED');
    return {
      'outcome': 'reject',
      'errors': (errors.toList()..sort()),
      'facts': {'schema_violations': violations..sort()},
    };
  }
  if (singletonTopics.any((t) => (decoded[t] ?? []).length != 1)) {
    errors.add('E_CHANNEL_CARDINALITY');
  }
  final recordingIds = <Object?>{
    for (final e in decoded.entries)
      if (channels[e.key]![2] == 'json')
        for (final x in e.value) (x as Map)['recording_id'],
  };
  if (recordingIds.length > 1) errors.add('E_RECORDING_ID');
  List<Map<String, dynamic>> js(String t) => [
    for (final m in decoded[t] ?? <Object?>[]) m as Map<String, dynamic>,
  ];
  final clockMsgs = js('/stateaction/clocks');
  final clocks = clockMsgs.isEmpty
      ? <String, dynamic>{}
      : (clockMsgs[0]['stream_clocks'] as Map<String, dynamic>? ?? {});
  final inventoryMsgs = js('/stateaction/inventory');
  final knownCalibrations = <Object?>{
    if (inventoryMsgs.isNotEmpty && inventoryMsgs[0]['calibrations'] is List)
      for (final c in inventoryMsgs[0]['calibrations'] as List)
        if (c is Map) c['calibration_id'],
  };
  final frames = js('/stateaction/frame_events');
  final ptsSeen = <String>{};
  final acquired = <String, Map<String, dynamic>>{},
      written = <String, Map<String, dynamic>>{},
      state = <String, String>{},
      submitted = <String>{},
      dropReasons = <String, int>{};
  final counts = {'acquired': 0, 'submitted': 0, 'written': 0, 'dropped': 0};
  for (final e in frames) {
    final sid = e['source_frame_id'] as String;
    final st = e['state'] as String;
    // Lifecycle: acquired once, then at most one submit and exactly one terminal outcome;
    // every later event repeats the acquired identity (clock, PTS, calibration, time base).
    if (st == 'acquired') {
      if (acquired.containsKey(sid)) errors.add('E_FRAME_IDENTITY');
    } else if (!acquired.containsKey(sid) ||
        ['written', 'dropped'].contains(state[sid]) ||
        (st == 'submitted' && submitted.contains(sid))) {
      errors.add('E_FRAME_IDENTITY');
    } else {
      final original = acquired[sid]!;
      if (identityKeys.any((k) => !same(e[k], original[k]))) {
        errors.add('E_FRAME_IDENTITY');
      }
    }
    if ((st == 'acquired' || st == 'written') &&
        clocks[e['stream_id']] != e['native_clock_id']) {
      errors.add('E_CLOCK_MISMATCH');
    }
    if (st == 'acquired') {
      if (!ptsSeen.add(e['encoder_pts_us'] as String)) {
        errors.add('E_DUPLICATE_PTS');
      }
      if (!knownCalibrations.contains(e['calibration_id'])) {
        errors.add('E_CALIBRATION_UNKNOWN');
      }
      acquired.putIfAbsent(sid, () => e);
    }
    if (st == 'submitted') submitted.add(sid);
    if (st == 'written') written.putIfAbsent(sid, () => e);
    if (st == 'dropped') {
      final r = e['reason'] as String;
      dropReasons[r] = (dropReasons[r] ?? 0) + 1;
    }
    counts[st] = counts[st]! + 1;
    if (acquired.containsKey(sid)) state[sid] = st;
  }
  facts['frame_event_counts'] = counts;
  final video = byTopic[videoTopic] ?? <Message>[];
  final videoDecoded = [
    for (final v in decoded[videoTopic] ?? <Object>[]) v as Video,
  ];
  final writtenSeqs = [
    for (final e in written.values) e['output_sequence'] as int,
  ];
  final videoSeqs = [for (final m in video) m.sequence];
  if (writtenSeqs.toSet().length != writtenSeqs.length ||
      videoSeqs.toSet().length != videoSeqs.length ||
      !writtenSeqs.toSet().containsAll(videoSeqs) ||
      !videoSeqs.toSet().containsAll(writtenSeqs)) {
    errors.add('E_SEQUENCE');
  }
  final bySeq = {
    for (final e in written.values) e['output_sequence'] as int: e,
  };
  final vf = <Map<String, Object?>>[];
  for (var i = 0; i < video.length; i++) {
    final m = video[i];
    final v = videoDecoded[i];
    final (auErrors, idr) = classifyAu(v.data);
    errors.addAll(auErrors);
    if (i == 0 && !idr && auErrors.isEmpty) errors.add('E_FIRST_NOT_IDR');
    final ts = v.sec * 1000000000 + v.nanos;
    final ev = bySeq[m.sequence];
    if (v.frameId != frameIdName || v.format != 'h264') {
      errors.add('E_VIDEO_FIELDS');
    }
    if (ev != null &&
        (ts.toString() != ev['mapped_capture_time_ns'] ||
            (ev['is_idr'] == true) != idr)) {
      errors.add('E_VIDEO_TIMESTAMP_MISMATCH');
    }
    vf.add({
      'sequence': m.sequence,
      'capture_time_ns': ts.toString(),
      'log_time_ns': m.logTime.toString(),
      'frame_id': v.frameId,
      'format': v.format,
      'bytes': v.data.length,
      'idr': idr,
      'sha256': sha256Hex(v.data),
      'source_frame_id': ev?['source_frame_id'],
      'encoder_pts_us': ev?['encoder_pts_us'],
    });
  }
  facts['video'] = vf;
  final motion = <String, Object?>{};
  for (final topic in ['/stateaction/imu/accel', '/stateaction/imu/gyro']) {
    final evs = js(topic);
    motion[topic] = [
      for (final e in evs)
        {
          'event_id': e['event_id'],
          'native_timestamp_ns': e['native_timestamp_ns'],
          'mapped_capture_time_ns': e['mapped_capture_time_ns'],
        },
    ];
    for (final e in evs) {
      if (clocks[topic.split('/').last] != e['native_clock_id']) {
        errors.add('E_CLOCK_MISMATCH');
      }
    }
  }
  facts['motion'] = motion;
  final sensors = js('/stateaction/sensor_events');
  final resetAt = <String, String?>{};
  for (final e in sensors) {
    if (e['source_kind'] == 'arcore_pose' &&
        e['tracking_state'] != 'tracking' &&
        e['pose_valid'] == true) {
      errors.add('E_TRACKING_LOSS_UNMARKED');
    }
    if (e['source_kind'] == 'calibration_reset') {
      resetAt[e['supersedes_calibration_id'] as String] =
          e['association_source_frame_id'] as String?;
    }
  }
  final cals = <String>{};
  for (final e in acquired.values) {
    cals.add(e['calibration_id'] as String);
    final at = resetAt[e['calibration_id']];
    if (at != null &&
        BigInt.parse(e['source_frame_id'] as String) >= BigInt.parse(at)) {
      errors.add('E_CALIBRATION_RESET_UNMARKED');
    }
  }
  facts['sensor_events'] = [
    for (final e in sensors)
      {
        'event_id': e['event_id'],
        'source_kind': e['source_kind'],
        'native_timestamp_ns': e['native_timestamp_ns'],
        'tracking_state': e['tracking_state'],
      },
  ];
  facts['calibrations_used'] = cals.toList()..sort();
  final poseMessages = byTopic['/tracking/pose'] ?? <Message>[];
  final poses = decoded['/tracking/pose'] ?? <Object>[];
  facts['cdr_poses'] = [
    for (var i = 0; i < poses.length; i++)
      {
        ...(poses[i] as Map<String, Object?>),
        'log_time_ns': poseMessages[i].logTime.toString(),
      },
  ];
  final closes = js('/stateaction/close');
  Map<String, dynamic>? lastClose;
  int? unresolvedAll;
  if (closes.isNotEmpty) {
    final close = closes.last;
    lastClose = close;
    final dropped = state.values.where((x) => x == 'dropped').length;
    final unresolved = acquired.length - written.length - dropped;
    unresolvedAll = unresolved;
    final expect = {for (final e in counts.entries) e.key: e.value.toString()};
    expect['unresolved'] = unresolved.toString();
    final expectMotion = {
      'accel': js('/stateaction/imu/accel').length.toString(),
      'gyro': js('/stateaction/imu/gyro').length.toString(),
    };
    final expectDrops = [
      for (final e in dropReasons.entries)
        {'reason': e.key, 'count': e.value.toString()},
    ]..sort((a, b) => (a['reason']!).compareTo(b['reason']!));
    final closeDropsSorted = [
      ...(close['drops'] as List).cast<Map>(),
    ]..sort((a, b) => (a['reason'] as String).compareTo(b['reason'] as String));
    if (!same(close['frames'], expect) ||
        close['video_messages'] != video.length.toString() ||
        !same(close['motion_events'], expectMotion) ||
        close['sensor_events'] != sensors.length.toString() ||
        !same(closeDropsSorted, expectDrops)) {
      errors.add('E_COUNT_MISMATCH');
    }
    final outcome = close['outcome'];
    if (outcome == 'completed' && unresolved != 0) {
      errors.add('E_OUTCOME_MISMATCH');
    } else if (outcome == 'failed' && close['failure_reason'] == null) {
      errors.add('E_OUTCOME_MISMATCH');
    }
    facts['close_outcome'] = outcome;
    facts['unresolved_frames'] = unresolved;
  }
  if (rev12) {
    checkV12(
      errors,
      facts,
      byTopic,
      decoded,
      acquired,
      lastClose,
      unresolvedAll,
    );
  }
  final list = errors.toList()..sort();
  return {
    'outcome': list.isEmpty ? 'accept' : 'reject',
    'errors': list,
    'facts': list.isEmpty ? facts : <String, Object?>{},
  };
}

// ---- v1.2 rules (SA-68)
int asInt(Object? v) => (v as num).toInt();

bool isF32(num x) {
  final d = x.toDouble();
  return (Float32List(1)..[0] = d)[0] == d;
}

bool closeTo(num actual, double expected) =>
    (actual - expected).abs() <=
    tolerance * (expected.abs() > 1 ? expected.abs() : 1);

List<double> matmul3(List<num> a, List<num> b) => [
  for (var i = 0; i < 3; i++)
    for (var j = 0; j < 3; j++)
      a[3 * i].toDouble() * b[j].toDouble() +
          a[3 * i + 1].toDouble() * b[3 + j].toDouble() +
          a[3 * i + 2].toDouble() * b[6 + j].toDouble(),
];

bool kForm(List<num> k) =>
    k[0] > 0 &&
    k[4] > 0 &&
    k[1] == 0 &&
    k[3] == 0 &&
    k[6] == 0 &&
    k[7] == 0 &&
    k[8] == 1;

List<num> nums(Object? v) => (v as List).cast<num>();

/// Saved-raster calibration rules (axis-aligned identity/crop/resize only).
bool calibrationValuesOk(Map<String, dynamic> c, Map<String, dynamic> encoder) {
  final k = nums(c['K']), p = nums(c['P']);
  final src = c['source'] as Map<String, dynamic>;
  final t = c['source_to_saved'] as Map<String, dynamic>;
  final crop = t['crop'] as Map<String, dynamic>;
  final srcK = nums(src['K']);
  if (!(kForm(k) && kForm(srcK))) return false;
  final wantP = [k[0], k[1], k[2], 0, k[3], k[4], k[5], 0, k[6], k[7], k[8], 0];
  for (var i = 0; i < 12; i++) {
    if (p[i] != wantP[i]) return false;
  }
  if ((asInt(crop['left'])) + (asInt(crop['width'])) > (asInt(src['width'])) ||
      (asInt(crop['top'])) + (asInt(crop['height'])) > (asInt(src['height'])) ||
      c['saved_width'] != t['scaled_width'] ||
      c['saved_height'] != t['scaled_height']) {
    return false;
  }
  if (src['value_type'] == 'float32' && !srcK.every(isF32)) return false;
  final sx = (asInt(t['scaled_width'])) / (asInt(crop['width']));
  final sy = (asInt(t['scaled_height'])) / (asInt(crop['height']));
  final m = [
    sx,
    0.0,
    (0.5 - (asInt(crop['left']))) * sx - 0.5,
    0.0,
    sy,
    (0.5 - (asInt(crop['top']))) * sy - 0.5,
    0.0,
    0.0,
    1.0,
  ];
  final matrix = nums(t['matrix']);
  for (var i = 0; i < 9; i++) {
    if (!closeTo(matrix[i], m[i])) return false;
  }
  final prod = matmul3(matrix, srcK);
  for (var i = 0; i < 9; i++) {
    if (!closeTo(k[i], prod[i])) return false;
  }
  return !((encoder.containsKey('width') &&
          encoder['width'] != c['saved_width']) ||
      (encoder.containsKey('height') &&
          encoder['height'] != c['saved_height']));
}

/// Native plane layout beside the stored (tight) layout; products stay far below 2**63.
bool planeOk(Map<String, dynamic> p, int sample) {
  final crop = p['crop'] as Map<String, dynamic>?;
  final nw = asInt(p['native_width']), nh = asInt(p['native_height']);
  if (crop != null &&
      ((asInt(crop['x'])) + (asInt(crop['width'])) > nw ||
          (asInt(crop['y'])) + (asInt(crop['height'])) > nh)) {
    return false;
  }
  final rw = crop != null ? asInt(crop['width']) : nw;
  final rh = crop != null ? asInt(crop['height']) : nh;
  final pixel = asInt(p['native_pixel_stride_bytes']);
  return p['stored_width'] == rw &&
      p['stored_height'] == rh &&
      pixel >= sample &&
      (asInt(p['native_row_stride_bytes'])) >= (nw - 1) * pixel + sample;
}

Map<String, dynamic>? inventoryEntry(
  Map<String, dynamic> inventory,
  String sensorId,
  Set<String> errors,
) {
  final entries = [
    for (final s in (inventory['sensors'] as List? ?? const []))
      if ((s as Map)['sensor_id'] == sensorId) s as Map<String, dynamic>,
  ];
  if (entries.length > 1) errors.add('E_COUNT_MISMATCH');
  return entries.length == 1 ? entries[0] : null;
}

void inventoryCount(
  Map<String, dynamic> inventory,
  String sensorId,
  int n,
  Set<String> errors,
) {
  final entry = inventoryEntry(inventory, sensorId, errors);
  if (n > 0) {
    if (entry == null ||
        entry['supported'] != 'yes' ||
        entry['enabled'] != 'yes' ||
        entry['observed'] != 'yes' ||
        entry['observed_count'] != n.toString()) {
      errors.add('E_COUNT_MISMATCH');
    }
  } else if (entry != null &&
      (entry['observed'] == 'yes' ||
          (entry['observed_count'] != null &&
              entry['observed_count'] != '0'))) {
    errors.add('E_COUNT_MISMATCH');
  }
}

class StreamState {
  final ids = <String>{};
  (int, BigInt)? last;
  final pairs = <String>{};
  int events = 0, confidence = 0;
}

void checkV12(
  Set<String> errors,
  Map<String, Object?> facts,
  Map<String, List<Message>> byTopic,
  Map<String, List<Object?>> decoded,
  Map<String, Map<String, dynamic>> acquired,
  Map<String, dynamic>? close,
  int? unresolved,
) {
  List<Map<String, dynamic>> js(String t) => [
    for (final m in decoded[t] ?? <Object?>[]) m as Map<String, dynamic>,
  ];
  List<Message> raw(String t) => byTopic[t] ?? <Message>[];
  final profile = js('/stateaction/capture_profile').firstOrNull ?? {};
  final clocksMsg = js('/stateaction/clocks').firstOrNull ?? {};
  final clocks = (clocksMsg['stream_clocks'] as Map<String, dynamic>?) ?? {};
  final transport = clocksMsg['recorder_transport'] as Map<String, dynamic>?;
  final inventory = js('/stateaction/inventory').firstOrNull ?? {};
  final frameEvents = js('/stateaction/frame_events');
  facts['wire_contract_revision'] = 'stateaction.capture.v1.2';

  // ---- mesh / point cloud: declaration only
  for (final sensorId in ['mesh', 'point_cloud']) {
    final entry = inventoryEntry(inventory, sensorId, errors);
    if (entry != null &&
        (entry['observed'] == 'yes' ||
            entry['enabled'] == 'yes' ||
            (entry['observed_count'] != null &&
                entry['observed_count'] != '0'))) {
      errors.add('E_UNSUPPORTED_STREAM');
    }
  }

  // ---- calibrations
  final invCals = [
    for (final c in (inventory['calibrations'] as List? ?? const []))
      c as Map<String, dynamic>,
  ];
  final ids = [for (final c in invCals) c['calibration_id'] as String];
  if (ids.toSet().length != ids.length) errors.add('E_CALIBRATION_VALUES');
  final invById = {for (final c in invCals) c['calibration_id'] as String: c};
  final calMsgs = js('/stateaction/calibrations');
  final calRaw = raw('/stateaction/calibrations');
  final frameRaw = raw('/stateaction/frame_events');
  final calPos = <String, int>{};
  final calFacts = <Map<String, Object?>>[];
  final encoder = (profile['encoder'] as Map<String, dynamic>?) ?? {};
  for (var idx = 0; idx < calMsgs.length; idx++) {
    final c = calMsgs[idx];
    final m = calRaw[idx];
    final cid = c['calibration_id'] as String;
    final inv = invById[cid];
    if (inv == null) {
      errors.add('E_CALIBRATION_UNKNOWN');
      continue;
    }
    if (calPos.containsKey(cid) ||
        inv['state'] != 'yes' ||
        inv['stream_id'] != c['stream_id']) {
      errors.add('E_CALIBRATION_VALUES');
    }
    calPos.putIfAbsent(cid, () => m.pos);
    if (!calibrationValuesOk(c, encoder)) errors.add('E_CALIBRATION_VALUES');
    final fi = frameEvents.indexWhere((e) => e['calibration_id'] == cid);
    final firsts = [
      for (final e in frameEvents)
        if (e['calibration_id'] == cid && e['state'] == 'acquired') e,
    ];
    if (fi < 0 ||
        firsts.isEmpty ||
        m.pos > frameRaw[fi].pos ||
        c['first_source_frame_id'] != firsts[0]['source_frame_id'] ||
        c['first_native_timestamp_ns'] != firsts[0]['native_timestamp_ns'] ||
        c['native_clock_id'] != firsts[0]['native_clock_id']) {
      errors.add('E_CALIBRATION_ASSOCIATION');
    }
    calFacts.add({
      'calibration_id': cid,
      'stream_id': c['stream_id'],
      'saved_width': c['saved_width'],
      'saved_height': c['saved_height'],
      'first_source_frame_id': c['first_source_frame_id'],
    });
  }
  for (final inv in invCals) {
    if (inv['state'] == 'yes' && !calPos.containsKey(inv['calibration_id'])) {
      errors.add('E_CALIBRATION_VALUES');
    }
  }
  facts['calibrations'] = calFacts;

  // ---- camera metadata
  final meta = js('/stateaction/camera_metadata');
  final seenMeta = <String>{};
  for (final e in meta) {
    final id = e['source_frame_id'] as String;
    final frame = acquired[id];
    if (frame == null ||
        seenMeta.contains(id) ||
        (e['native_timestamp_ns'] != null &&
            e['native_timestamp_ns'] != frame['native_timestamp_ns'])) {
      errors.add('E_CAMERA_METADATA');
    }
    seenMeta.add(id);
  }
  inventoryCount(inventory, 'camera_metadata', meta.length, errors);
  facts['camera_metadata_count'] = meta.length;

  // ---- depth
  final events = js('/stateaction/depth_events');
  final images = <String, Map<int, List<(Message, RawImage)>>>{
    for (final t in depthImageTopics) t: {},
  };
  for (final t in depthImageTopics) {
    final vs = decoded[t] ?? <Object?>[];
    final ms = raw(t);
    for (var i = 0; i < ms.length; i++) {
      images[t]!.putIfAbsent(ms[i].sequence, () => []).add((
        ms[i],
        vs[i] as RawImage,
      ));
    }
  }
  final used = <String>{};
  (Message, RawImage)? take(String topic, int sequence) {
    final got = images[topic]?[sequence] ?? [];
    if (got.length != 1 || used.contains('$topic|$sequence')) {
      errors.add('E_DEPTH_EVIDENCE');
      return null;
    }
    used.add('$topic|$sequence');
    return got[0];
  }

  final offset = transport != null
      ? BigInt.parse(transport['epoch_anchor_ns'] as String) -
            BigInt.parse(transport['native_anchor_ns'] as String)
      : BigInt.zero;
  final perStream = <String, StreamState>{};
  final depthFacts = <Map<String, Object?>>[];
  for (final e in events) {
    final stream = e['stream_id'] as String;
    final st = perStream.putIfAbsent(stream, StreamState.new);
    st.events++;
    if (!st.ids.add(e['event_id'] as String)) errors.add('E_DEPTH_EVIDENCE');
    final ts = BigInt.parse(e['native_timestamp_ns'] as String);
    final epoch = asInt(e['clock_epoch']);
    // clocks and the capture-timeline basis
    if (clocks[stream] != e['native_clock_id']) errors.add('E_CLOCK_MISMATCH');
    final basis = e['capture_time_basis'] as String;
    final captureNs = BigInt.parse(e['capture_time_ns'] as String);
    if (transport == null ||
        e['clock_mapping_revision'] != transport['revision']) {
      errors.add('E_CLOCK_MISMATCH');
    } else if (basis == 'transport_mapping') {
      if (e['native_clock_id'] != transport['clock_id'] ||
          e['receipt_native_timestamp_ns'] != null ||
          captureNs != ts + offset) {
        errors.add('E_CLOCK_MISMATCH');
      }
    } else if (e['receipt_native_timestamp_ns'] == null ||
        captureNs !=
            BigInt.parse(e['receipt_native_timestamp_ns'] as String) + offset) {
      errors.add('E_CLOCK_MISMATCH');
    }
    // cadence: native timestamps are preserved verbatim; repeats and resets are explicit
    final last = st.last;
    final rel = e['timestamp_relation'] as String;
    final bool valid;
    if (last == null) {
      valid = rel == 'first';
    } else if (epoch == last.$1) {
      valid =
          (rel == 'advanced' && ts > last.$2) ||
          (rel == 'repeated' && ts == last.$2);
    } else {
      valid = rel == 'clock_reset' && epoch > last.$1;
    }
    if (!valid) errors.add('E_DEPTH_CADENCE');
    final prov = e['estimate_provenance'] as String;
    if ((rel == 'repeated' && prov == 'new_estimate') ||
        (rel != 'repeated' && prov == 'api_repeat')) {
      errors.add('E_DEPTH_CADENCE');
    }
    st.last = (epoch, ts);
    st.pairs.add('$epoch|$ts');
    // associations (exact evidence only)
    final acq = e['acquisition_source_frame_id'] as String?;
    final mea = e['measurement_source_frame_id'] as String?;
    if (acq != null && !acquired.containsKey(acq)) {
      errors.add('E_DEPTH_ASSOCIATION');
    }
    if (mea != null &&
        (!acquired.containsKey(mea) ||
            acquired[mea]!['native_clock_id'] != e['native_clock_id'] ||
            acquired[mea]!['native_timestamp_ns'] !=
                e['native_timestamp_ns'])) {
      errors.add('E_DEPTH_ASSOCIATION');
    }
    final cal = e['calibration_id'] as String?;
    if (cal != null &&
        (!invById.containsKey(cal) || invById[cal]!['stream_id'] != stream)) {
      errors.add('E_CALIBRATION_UNKNOWN');
    }
    // image evidence
    final d = e['depth'] as Map<String, dynamic>;
    final got = take(
      d['output_channel'] as String,
      asInt(d['output_sequence']),
    );
    String? depthSha;
    if (!planeOk(d, 2)) {
      errors.add('E_DEPTH_EVIDENCE');
    } else if (got != null) {
      final v = got.$2;
      final ok =
          v.width == d['stored_width'] &&
          v.height == d['stored_height'] &&
          v.encoding == '16UC1' &&
          v.frameId == depthFrameId &&
          v.step == (asInt(d['stored_width'])) * 2 &&
          v.data.length == v.step * v.height &&
          v.captureNs.toString() == e['capture_time_ns'];
      if (!ok) errors.add('E_DEPTH_EVIDENCE');
      depthSha = sha256Hex(v.data);
    }
    final conf = e['confidence'] as Map<String, dynamic>;
    final separate = conf['state'] == 'separate_image';
    String? confSha;
    int? confBytes;
    if (separate) {
      st.confidence++;
      final cgot = take(
        conf['output_channel'] as String,
        asInt(conf['output_sequence']),
      );
      final sameLayout =
          [
            'native_width',
            'native_height',
            'stored_width',
            'stored_height',
          ].every((k) => conf[k] == d[k]) &&
          same(conf['crop'], d['crop']);
      final stamp = conf['native_timestamp'] as Map<String, dynamic>;
      if (!planeOk(conf, 1) || !sameLayout) errors.add('E_DEPTH_EVIDENCE');
      if (stamp['state'] == 'reported' &&
          stamp['native_clock_id'] != clocks['depth_raw_confidence']) {
        errors.add('E_CLOCK_MISMATCH');
      }
      if (cgot != null) {
        final v = cgot.$2;
        final ok =
            v.width == conf['stored_width'] &&
            v.height == conf['stored_height'] &&
            v.encoding == 'mono8' &&
            v.frameId == depthFrameId &&
            v.step == conf['stored_width'] &&
            v.data.length == v.step * v.height &&
            v.captureNs.toString() == e['capture_time_ns'];
        if (!ok) errors.add('E_DEPTH_EVIDENCE');
        confSha = sha256Hex(v.data);
        confBytes = v.data.length;
      }
    }
    final stamp = conf['native_timestamp'] as Map<String, dynamic>?;
    depthFacts.add({
      'stream_id': stream,
      'event_id': e['event_id'],
      'native_timestamp_ns': e['native_timestamp_ns'],
      'native_clock_id': e['native_clock_id'],
      'clock_epoch': epoch,
      'timestamp_relation': rel,
      'estimate_provenance': prov,
      'capture_time_basis': basis,
      'capture_time_ns': e['capture_time_ns'],
      'sequence': d['output_sequence'],
      'stored_width': d['stored_width'],
      'stored_height': d['stored_height'],
      'native_width': d['native_width'],
      'native_height': d['native_height'],
      'cropped': d['crop'] != null,
      'depth_bytes':
          (asInt(d['stored_width'])) * (asInt(d['stored_height'])) * 2,
      'depth_sha256': depthSha,
      'confidence_state': conf['state'],
      'confidence_bytes': confBytes,
      'confidence_sha256': confSha,
      'confidence_timestamp_state': separate ? stamp!['state'] : null,
      'confidence_native_timestamp_ns': separate
          ? stamp!['native_timestamp_ns']
          : null,
    });
  }
  // orphans and duplicate sequences
  for (final t in depthImageTopics) {
    for (final entry in images[t]!.entries) {
      if (entry.value.length != 1 || !used.contains('$t|${entry.key}')) {
        errors.add('E_DEPTH_EVIDENCE');
      }
    }
  }
  facts['depth'] = depthFacts;
  facts['depth_streams'] = {
    for (final e in perStream.entries)
      e.key: {
        'events': e.value.events,
        'distinct_native_timestamps': e.value.pairs.length,
      },
  };
  for (final stream in ['depth_raw', 'depth_dense']) {
    inventoryCount(inventory, stream, perStream[stream]?.events ?? 0, errors);
  }

  // ---- Close.v2
  if (close == null) return;
  for (final stream in ['depth_raw', 'depth_dense']) {
    final st = perStream[stream];
    final entry = <String, String>{
      'events': (st?.events ?? 0).toString(),
      'distinct_native_timestamps': (st?.pairs.length ?? 0).toString(),
      if (stream == 'depth_raw')
        'confidence_images': (st?.confidence ?? 0).toString(),
    };
    final c =
        (close['depth'] as Map<String, dynamic>)[stream]
            as Map<String, dynamic>;
    if (entry.entries.any((x) => c[x.key] != x.value)) {
      errors.add('E_COUNT_MISMATCH');
    }
    final repeated = events.any(
      (e) => e['stream_id'] == stream && e['timestamp_relation'] == 'repeated',
    );
    if ((c['retention_policy'] == 'native_updates_only' && repeated) ||
        (c['retention_policy'] == 'all_returned_images' &&
            c['skipped_repeats'] != '0')) {
      errors.add('E_DEPTH_CADENCE');
    }
  }
  if (close['calibrations'] != calMsgs.length.toString() ||
      close['camera_metadata'] != meta.length.toString()) {
    errors.add('E_COUNT_MISMATCH');
  }
  final outcome = close['outcome'];
  final reason = close['stop_reason'];
  final drain = close['encoder_drain'];
  final frames = close['frames'] as Map<String, dynamic>;
  final bad =
      (outcome == 'completed' &&
          (drain != 'eos_reached' ||
              !['user_requested', 'duration_limit'].contains(reason))) ||
      ((['writer_error', 'encoder_error'].contains(reason) ||
              drain == 'encoder_failed') &&
          outcome != 'failed') ||
      ([
            'low_storage_reserve',
            'thermal_critical',
            'session_interrupted',
            'camera_lost',
            'app_terminating',
          ].contains(reason) &&
          !['aborted', 'failed'].contains(outcome)) ||
      (drain == 'deadline_exceeded' && outcome == 'completed') ||
      (drain == 'not_started' &&
          (frames['written'] != '0' || close['video_messages'] != '0')) ||
      (outcome == 'unknown' && reason != 'unknown');
  if (bad) errors.add('E_OUTCOME_MISMATCH');
  facts['close_stop_reason'] = reason;
  facts['encoder_drain'] = drain;
  facts['auto_admissible'] =
      outcome == 'completed' && unresolved == 0 && drain == 'eos_reached';
}

// ---- Encoder buffer sequences (MediaCodec flags: CODEC_CONFIG=2, END_OF_STREAM=4, PARTIAL_FRAME=8)
final startCode = Uint8List.fromList([0, 0, 0, 1]);

Uint8List concat(List<List<int>> parts) =>
    Uint8List.fromList([for (final p in parts) ...p]);

Uint8List encoderBufferData(
  Map<String, dynamic> buf,
  Map<String, List<Uint8List>> sources,
) {
  if (buf['nals'] == null) return Uint8List(0);
  final range = (buf['nals'] as List).cast<int>();
  var data = concat([
    for (final n in sources[buf['source']]!.sublist(range[0], range[1])) ...[
      startCode,
      n,
    ],
  ]);
  if (buf['bytes'] != null) {
    final slice = (buf['bytes'] as List).cast<int>();
    data = Uint8List.sublistView(data, slice[0], slice[1]);
  }
  return data;
}

Map<String, Object?> assembleEncoderBuffers(
  List<dynamic> buffers,
  Map<String, List<Uint8List>> sources,
) {
  final errors = <String>{};
  final aus = <Map<String, Object?>>[];
  var config = Uint8List(0);
  ({String pts, Uint8List data})? pending;
  var finished = false;
  for (final raw in buffers) {
    final buf = raw as Map<String, dynamic>;
    final flags = buf['flags'] as int;
    final data = encoderBufferData(buf, sources);
    if (flags & 2 != 0) {
      if (pending != null) {
        errors.add('E_INCOMPLETE_AU');
        finished = true;
        break;
      }
      config = data;
      continue;
    }
    if (flags & 4 != 0 && data.isEmpty) {
      if (pending != null) errors.add('E_INCOMPLETE_AU');
      finished = true;
      break;
    }
    final pts = buf['pts_us'];
    if (!isDecimal(pts)) {
      errors.add('E_PTS_INVALID');
      finished = true;
      break;
    }
    if (pending != null && pending.pts != pts) {
      errors.add('E_PARTIAL_PTS_MISMATCH');
      finished = true;
      break;
    }
    var acc = concat([if (pending != null) pending.data, data]);
    if (flags & 8 != 0) {
      pending = (pts: pts as String, data: acc);
      continue;
    }
    pending = null;
    final units = nals(acc);
    if (units != null && units.any((n) => (n[0] & 31) == 5)) {
      final types = [for (final n in units) n[0] & 31];
      final before = types.sublist(
        0,
        types.indexWhere((t) => t == 1 || t == 5),
      );
      if ((!before.contains(7) || !before.contains(8)) && config.isNotEmpty) {
        acc = concat([config, acc]);
      }
    }
    final (auErrors, idr) = classifyAu(acc);
    if (auErrors.isNotEmpty) {
      errors.addAll(auErrors);
      finished = true;
      break;
    }
    aus.add({
      'pts_us': pts,
      'idr': idr,
      'bytes': acc.length,
      'sha256': sha256Hex(acc),
    });
  }
  if (!finished && pending != null) errors.add('E_INCOMPLETE_AU');
  if (errors.isNotEmpty) {
    return {
      'outcome': 'reject',
      'errors': (errors.toList()..sort()),
      'aus': <Object?>[],
    };
  }
  return {'outcome': 'accept', 'errors': <String>[], 'aus': aus};
}

String canonical(Object? v) {
  String enc(Object? x) {
    if (x is Map) {
      final keys = x.keys.cast<String>().toList()..sort();
      return '{${keys.map((k) => '${jsonEncode(k)}:${enc(x[k])}').join(',')}}';
    }
    if (x is List) return '[${x.map(enc).join(',')}]';
    return jsonEncode(x);
  }

  return '${enc(v)}\n';
}

// Direct foxglove.RawImage build recipe (see fixtures/raw_image_cases.v1.2.json).
List<int> pbVarint(int n) {
  final out = <int>[];
  var v = n;
  while (v >= 0x80) {
    out.add((v & 0x7f) | 0x80);
    v >>= 7;
  }
  out.add(v);
  return out;
}

List<int> pbField(int n, List<int> payload) => [
  ...pbVarint((n << 3) | 2),
  ...pbVarint(payload.length),
  ...payload,
];

List<int> u32(int n) =>
    (ByteData(4)..setUint32(0, n, Endian.little)).buffer.asUint8List();

Uint8List buildRaw(Map<String, dynamic> r) {
  final frameId = r.containsKey('frame_id_len')
      ? 'x' * (r['frame_id_len'] as int)
      : 'depth_optical_frame';
  final stamp = [0x08, ...pbVarint(1800000000), 0x10, ...pbVarint(7)];
  return Uint8List.fromList([
    ...pbField(1, stamp),
    0x15,
    ...u32(r['width'] as int),
    0x1d,
    ...u32(r['height'] as int),
    ...pbField(4, utf8.encode(r['encoding'] as String)),
    0x2d,
    ...u32(r['step'] as int),
    ...pbField(6, List<int>.filled(r['data_len'] as int, r['fill'] as int)),
    ...pbField(7, utf8.encode(frameId)),
  ]);
}

void main(List<String> args) {
  final cap = Directory(args.isNotEmpty ? args[0] : '../..').absolute.path;
  captureDir = cap;
  var failed = 0;
  void fail(String message) {
    failed++;
    stderr.writeln(message);
  }

  String clip(String s) => s.substring(0, s.length < 300 ? s.length : 300);
  final counts = <String, int>{};
  // One golden corpus directory: byte hash, byte-exact expected result, declared verdict, declared schema
  // violations, and the frozen v1.1 reader (max_revision v1.1) verdict.
  void runCorpus(String label, String dir, bool frozenReader) {
    final declared =
        jsonDecode(File('$dir/cases.json').readAsStringSync())
            as Map<String, dynamic>;
    final names =
        Directory(dir)
            .listSync()
            .whereType<File>()
            .map((f) => f.uri.pathSegments.last)
            .where((n) => n.endsWith('.mcap'))
            .map((n) => n.substring(0, n.length - 5))
            .toList()
          ..sort();
    if (canonical(names) != canonical(declared.keys.toList()..sort())) {
      fail('$label: *.mcap and cases.json disagree');
    }
    for (final name in names) {
      final bytes = File('$dir/$name.mcap').readAsBytesSync();
      final want = declared[name] as Map<String, dynamic>?;
      if (want != null &&
          want['sha256'] != null &&
          sha256Hex(bytes) != want['sha256']) {
        fail('$label DRIFT $name');
      }
      final result = check(bytes, null);
      final actual = canonical(result);
      final expected = File('$dir/expected/$name.json').readAsStringSync();
      if (actual != expected) {
        fail(
          'MISMATCH $label/$name\n  actual:   ${clip(actual)}\n  expected: ${clip(expected)}',
        );
      }
      // The independently declared outcome and error codes are the oracle for rejections.
      if (want != null &&
          (result['outcome'] != want['expect'] ||
              canonical(result['errors']) !=
                  canonical(want['expected_errors']))) {
        fail(
          'DECLARED $label/$name: got ${result['outcome']} ${result['errors']}; declared ${want['expect']} ${want['expected_errors']}',
        );
      }
      // Declared schema violations (without message index) must match exactly.
      final facts = result['facts'] as Map<String, Object?>;
      final stripped = [
        for (final v in (facts['schema_violations'] as List?) ?? const [])
          (v as String).replaceFirst(RegExp(r'\[[0-9]+\]'), ''),
      ]..sort();
      if (want != null &&
          canonical(stripped) !=
              canonical(want['expected_violations'] ?? const [])) {
        fail('VIOLATIONS $label/$name: $stripped');
      }
      // max_revision=v1.1 reproduces the frozen reader: v1.1 files are unchanged, v1.2 files carry the
      // declared frozen-reader verdict.
      final old = check(bytes, null, maxRevision: 'v1.1');
      if (frozenReader) {
        final summary = {'errors': old['errors'], 'outcome': old['outcome']};
        if (canonical(summary) != canonical(want!['v1_1_reader'])) {
          fail('FROZEN READER $label/$name: ${canonical(summary)}');
        }
      } else if (canonical(old) != actual) {
        fail('FROZEN READER $label/$name differs from default reader');
      }
    }
    counts[label] = names.length;
  }

  runCorpus('v1.1', '$cap/golden', false);
  runCorpus('v1.2', '$cap/golden/v1.2', true);
  // Direct strict-schema interpreter cases and fail-closed schema loading.
  Map<String, dynamic> runSchemaCases(
    String file,
    String Function(String) qualify,
  ) {
    final doc =
        jsonDecode(File('$cap/fixtures/$file').readAsStringSync())
            as Map<String, dynamic>;
    for (final c in (doc['cases'] as List).cast<Map<String, dynamic>>()) {
      final text = c['json'] as String;
      final raw = text == '__INVALID_UTF8__'
          ? Uint8List.fromList([0xff, 0xfe])
          : Uint8List.fromList(utf8.encode(text));
      Object? got;
      try {
        got = contractSchema(
          qualify(c['schema'] as String),
        ).validate(parseJson(raw));
      } on MalformedJson {
        got = 'malformed';
      }
      if (canonical(got) != canonical(c['expect'])) {
        fail('SCHEMA CASE $file ${c['name']}: ${canonical(got)}');
      }
    }
    return doc;
  }

  final schemaCases = runSchemaCases(
    'schema_cases.json',
    (n) => 'stateaction.capture.$n.v1',
  );
  final schemaCases12 = runSchemaCases('schema_cases.v1.2.json', (n) => n);
  final unsupported = (schemaCases['unsupported_schemas'] as List)
      .cast<Map<String, dynamic>>();
  for (final u in unsupported) {
    try {
      Schema(u['schema'] as Map<String, dynamic>);
      fail('UNSUPPORTED SCHEMA ACCEPTED ${u['name']}');
    } on SchemaUnsupported {
      // fail closed
    }
  }
  // Direct bounded RawImage decoder cases (including the 16 MiB cap recipes).
  final rawCases =
      jsonDecode(
            File('$cap/fixtures/raw_image_cases.v1.2.json').readAsStringSync(),
          )
          as Map<String, dynamic>;
  if (rawCases['data_cap_bytes'] != rawDataMax ||
      rawCases['message_cap_bytes'] != rawMessageMax) {
    fail('RawImage caps differ from the fixture');
  }
  final rawList = (rawCases['cases'] as List).cast<Map<String, dynamic>>();
  for (final c in rawList) {
    final data = c.containsKey('hex')
        ? Uint8List.fromList([
            for (var i = 0; i < (c['hex'] as String).length; i += 2)
              int.parse((c['hex'] as String).substring(i, i + 2), radix: 16),
          ])
        : buildRaw(c['build'] as Map<String, dynamic>);
    var verdict = 'ok';
    try {
      decodeRawImage(data);
    } on Malformed {
      verdict = 'malformed';
    } on FormatException {
      verdict = 'malformed';
    }
    if (verdict != c['expect']) fail('RAW IMAGE ${c['name']}: $verdict');
  }
  final fixture =
      jsonDecode(File('$cap/fixtures/encoder_buffers.json').readAsStringSync())
          as Map<String, dynamic>;
  final sources = {
    for (final e in (fixture['sources'] as Map<String, dynamic>).entries)
      e.key: nals(File('$cap/${e.value}').readAsBytesSync())!,
  };
  final fixtureCases = fixture['cases'] as Map<String, dynamic>;
  for (final e in fixtureCases.entries) {
    final c = e.value as Map<String, dynamic>;
    final got = assembleEncoderBuffers(c['buffers'] as List, sources);
    if (canonical(got) != canonical(c['expect'])) {
      fail('ENCODER BUFFERS ${e.key}: ${canonical(got)}');
    }
  }
  print(
    jsonEncode({
      'runner': 'dart',
      'cases': counts['v1.1'],
      'v12_cases': counts['v1.2'],
      'encoder_buffer_cases': fixtureCases.length,
      'schema_cases': (schemaCases['cases'] as List).length,
      'v12_schema_cases': (schemaCases12['cases'] as List).length,
      'raw_image_cases': rawList.length,
      'unsupported_schemas': unsupported.length,
      'failed': failed,
    }),
  );
  exit(failed == 0 ? 0 : 1);
}
