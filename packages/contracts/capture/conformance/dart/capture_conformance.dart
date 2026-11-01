// stateaction.capture.v1.1 golden MCAP conformance checker (Dart, dependency-free).
// Port of conformance/python/capture_conformance.py. Run: dart run capture_conformance.dart <capture-dir>
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

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
final magic = [0x89, 0x4d, 0x43, 0x41, 0x50, 0x30, 0x0d, 0x0a];

class Truncated implements Exception {}

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
  Message(this.channel, this.sequence, this.logTime, this.data);
  final int channel, sequence, logTime;
  final Uint8List data;
}

class Mcap {
  String? profile;
  final schemas = <int, ({String name, String encoding, Uint8List data})>{};
  final channels = <int, ({int schemaId, String topic})>{};
  final messages = <Message>[];
}

String readStr(ByteData bd, Uint8List b, int off, List<int> next) {
  if (off + 4 > b.length) throw Truncated();
  final n = bd.getUint32(off, Endian.little);
  if (off + 4 + n > b.length) throw Truncated();
  next[0] = off + 4 + n;
  return utf8.decode(b.sublist(off + 4, off + 4 + n));
}

Mcap readMcap(Uint8List data) {
  if (data.length < 8) throw Truncated();
  for (var i = 0; i < 8; i++) {
    if (data[i] != magic[i]) throw Truncated();
  }
  final out = Mcap();
  var pos = 8;
  final all = ByteData.sublistView(data);
  for (;;) {
    if (pos == data.length || pos + 9 > data.length) throw Truncated();
    final op = data[pos];
    final len = all.getUint64(pos + 1, Endian.little);
    final start = pos + 9;
    if (start + len > data.length) throw Truncated();
    final body = Uint8List.sublistView(data, start, start + len);
    final bd = ByteData.sublistView(body);
    pos = start + len;
    final nx = [0];
    if (op == 0x01) {
      out.profile = readStr(bd, body, 0, nx);
    } else if (op == 0x03) {
      final name = readStr(bd, body, 2, nx);
      final enc = readStr(bd, body, nx[0], nx);
      final n = bd.getUint32(nx[0], Endian.little);
      out.schemas[bd.getUint16(0, Endian.little)] = (
        name: name,
        encoding: enc,
        data: Uint8List.sublistView(body, nx[0] + 4, nx[0] + 4 + n),
      );
    } else if (op == 0x04) {
      out.channels[bd.getUint16(0, Endian.little)] = (
        schemaId: bd.getUint16(2, Endian.little),
        topic: readStr(bd, body, 4, nx),
      );
    } else if (op == 0x05) {
      out.messages.add(
        Message(
          bd.getUint16(0, Endian.little),
          bd.getUint32(2, Endian.little),
          bd.getUint64(6, Endian.little),
          Uint8List.sublistView(body, 22),
        ),
      );
    } else if (op == 0x02) {
      if (pos + 8 != data.length) throw Truncated();
      for (var i = 0; i < 8; i++) {
        if (data[pos + i] != magic[i]) throw Truncated();
      }
      return out;
    }
  }
}

// ---- Protobuf CompressedVideo
(int, int) varint(Uint8List b, int pos) {
  var shift = 0, value = 0;
  for (;;) {
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
        v.frameId = utf8.decode(chunk);
      } else if (field == 3) {
        v.data = chunk;
      } else if (field == 4) {
        v.format = utf8.decode(chunk);
      }
    } else if (wire == 0) {
      pos = varint(b, pos).$2;
    } else {
      throw StateError('wire type');
    }
  }
  return v;
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
  if (headers.any((h) => h == null) ||
      headers.where((h) => h![0] == 0).length != 1) {
    errors.add('E_PARTIAL_ACCESS_UNIT');
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
  if (bd.getUint32(0, Endian.little) != 0x00000100)
    throw StateError('CDR header');
  final n = bd.getUint32(12, Endian.little);
  return {
    'sec': bd.getInt32(4, Endian.little),
    'nanosec': bd.getUint32(8, Endian.little),
    'frame_id': utf8.decode(d.sublist(16, 16 + n - 1)),
  };
}

// ---- Checker
Map<String, Object?> check(Uint8List data, Map<String, dynamic> manifest) {
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
  final descriptor = manifest['foxglove-compressed-video.desc'] as String;
  final hashes = <String, String>{};
  for (final s in f.schemas.values) {
    final digest = sha256Hex(s.data);
    hashes[s.name] = digest;
    if (s.name == 'foxglove.CompressedVideo') {
      if (digest != descriptor || s.encoding != 'protobuf')
        errors.add('E_DESCRIPTOR_HASH');
    } else if (custom.containsKey(s.name)) {
      if (digest != manifest[custom[s.name]] || s.encoding != 'jsonschema')
        errors.add('E_SCHEMA_MISMATCH');
    }
  }
  facts['schema_sha256'] = hashes;
  List<Map<String, dynamic>> js(String t) => [
    for (final m in byTopic[t] ?? <Message>[])
      jsonDecode(utf8.decode(m.data)) as Map<String, dynamic>,
  ];
  final clockMsgs = js('/stateaction/clocks');
  final clocks = clockMsgs.isEmpty
      ? <String, dynamic>{}
      : (clockMsgs[0]['stream_clocks'] as Map<String, dynamic>? ?? {});
  final frames = js('/stateaction/frame_events');
  final ptsSeen = <String>{};
  final acquired = <String>{},
      written = <String, Map<String, dynamic>>{},
      state = <String, String>{};
  final counts = {'acquired': 0, 'submitted': 0, 'written': 0, 'dropped': 0};
  for (final e in frames) {
    final sid = e['source_frame_id'] as String;
    final st = e['state'] as String;
    if ((st == 'acquired' || st == 'written') &&
        clocks[e['stream_id']] != e['native_clock_id'])
      errors.add('E_CLOCK_MISMATCH');
    if ((st == 'acquired' || st == 'written') &&
        !e.containsKey('encoder_pts_us'))
      errors.add('E_MISSING_PTS');
    if (st == 'acquired') {
      if (e.containsKey('encoder_pts_us')) {
        if (!ptsSeen.add(e['encoder_pts_us'] as String))
          errors.add('E_DUPLICATE_PTS');
      }
      acquired.add(sid);
    }
    if (st == 'written') written[sid] = e;
    counts[st] = counts[st]! + 1;
    state[sid] = st;
  }
  facts['frame_event_counts'] = counts;
  final video = byTopic[videoTopic] ?? <Message>[];
  final bySeq = {
    for (final e in written.values) e['output_sequence'] as int: e,
  };
  final vf = <Map<String, Object?>>[];
  for (var i = 0; i < video.length; i++) {
    final m = video[i];
    final v = decodeVideo(m.data);
    final (auErrors, idr) = classifyAu(v.data);
    errors.addAll(auErrors);
    if (i == 0 && !idr && auErrors.isEmpty) errors.add('E_FIRST_NOT_IDR');
    final ts = v.sec * 1000000000 + v.nanos;
    final ev = bySeq[m.sequence];
    if (v.frameId != frameIdName || v.format != 'h264')
      errors.add('E_VIDEO_FIELDS');
    if (ev == null) {
      errors.add('E_MISSING_PTS');
    } else if (ts.toString() != ev['mapped_capture_time_ns'] ||
        (ev['is_idr'] == true) != idr) {
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
  if (video.length != counts['written']) errors.add('E_MISSING_PTS');
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
      if (clocks[topic.split('/').last] != e['native_clock_id'])
        errors.add('E_CLOCK_MISMATCH');
    }
  }
  facts['motion'] = motion;
  final sensors = js('/stateaction/sensor_events');
  final resetAt = <String, String?>{};
  for (final e in sensors) {
    if (e['source_kind'] == 'arcore_pose' &&
        e['tracking_state'] != 'tracking' &&
        e['pose_valid'] == true)
      errors.add('E_TRACKING_LOSS_UNMARKED');
    if (e['source_kind'] == 'calibration_reset')
      resetAt[e['supersedes_calibration_id'] as String] =
          e['association_source_frame_id'] as String?;
  }
  final cals = <String>{};
  for (final e in frames) {
    if (e['state'] != 'acquired') continue;
    cals.add(e['calibration_id'] as String);
    final at = resetAt[e['calibration_id']];
    if (at != null &&
        BigInt.parse(e['source_frame_id'] as String) >= BigInt.parse(at))
      errors.add('E_CALIBRATION_RESET_UNMARKED');
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
  facts['cdr_poses'] = [
    for (final m in byTopic['/tracking/pose'] ?? <Message>[])
      {...decodePose(m.data), 'log_time_ns': m.logTime.toString()},
  ];
  final closes = js('/stateaction/close');
  if (closes.isNotEmpty) {
    final close = closes.last;
    final dropped = state.values.where((x) => x == 'dropped').length;
    final expect = {for (final e in counts.entries) e.key: e.value.toString()};
    expect['unresolved'] = (acquired.length - written.length - dropped)
        .toString();
    final cf = close['frames'] as Map<String, dynamic>;
    if ([
          'acquired',
          'dropped',
          'submitted',
          'unresolved',
          'written',
        ].any((k) => cf[k] != expect[k]) ||
        close['video_messages'] != video.length.toString()) {
      errors.add('E_COUNT_MISMATCH');
    }
    facts['close_outcome'] = close['outcome'];
  } else {
    errors.add('E_COUNT_MISMATCH');
  }
  final list = errors.toList()..sort();
  return {
    'outcome': list.isEmpty ? 'accept' : 'reject',
    'errors': list,
    'facts': list.isEmpty ? facts : <String, Object?>{},
  };
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

void main(List<String> args) {
  final cap = Directory(args.isNotEmpty ? args[0] : '../..').absolute.path;
  final manifest =
      (jsonDecode(File('$cap/manifest.json').readAsStringSync())
              as Map<String, dynamic>)['files']
          as Map<String, dynamic>;
  final names =
      Directory('$cap/golden')
          .listSync()
          .whereType<File>()
          .map((f) => f.uri.pathSegments.last)
          .where((n) => n.endsWith('.mcap'))
          .map((n) => n.substring(0, n.length - 5))
          .toList()
        ..sort();
  var failed = 0;
  for (final name in names) {
    final actual = canonical(
      check(File('$cap/golden/$name.mcap').readAsBytesSync(), manifest),
    );
    final expected = File('$cap/golden/expected/$name.json').readAsStringSync();
    if (actual != expected) {
      failed++;
      stderr.writeln(
        'MISMATCH $name\n  actual:   ${actual.substring(0, actual.length < 300 ? actual.length : 300)}\n  expected: ${expected.substring(0, expected.length < 300 ? expected.length : 300)}',
      );
    }
  }
  print(
    jsonEncode({'runner': 'dart', 'cases': names.length, 'failed': failed}),
  );
  exit(failed == 0 ? 0 : 1);
}
