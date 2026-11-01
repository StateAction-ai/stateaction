// Cross-field rules; same order, codes and paths as packages/contracts/src/rules.ts.

typedef Json = Map<String, Object?>;
typedef Violation = ({String code, String path});
typedef Rule = Violation? Function(Json doc);

const _partSize = 67108864;
const _outputRole = {
  'rgb_mp4': 'clip_mp4',
  'hand_arrays_npz': 'hand_arrays_npz',
  'hand_observations_json': 'hand_observations_json',
  'frame_map_json': 'frame_map_json',
  'thumbnail_jpeg': 'thumbnail_jpeg',
  'viewer_rrd': 'viewer_rrd',
};

/// Expected NPZ array shapes; 'F' is the clip frame_count.
const handArrayShapes = <List<Object>>[
  ['F', 2, 21, 2],
  ['F', 2, 21],
  ['F', 2, 21, 3],
  ['F', 2, 21],
  ['F', 2],
  ['F', 2],
  ['F'],
];

Violation _v(String code, String path) => (code: code, path: path);
List<Object?> _list(Object? value) => value! as List<Object?>;
Json _obj(Object? value) => value! as Json;
BigInt _big(Object? value) => BigInt.parse(value! as String);

/// JSON number equality (1 == 1.0); never true across types.
bool _same(Object? a, Object? b) {
  if (a is num && b is num) return a == b;
  return a == b;
}

Violation? _duplicate(List<Object?> items, String key, String base) {
  final seen = <Object?>[];
  for (var i = 0; i < items.length; i++) {
    final value = _obj(items[i])[key];
    if (seen.any((s) => _same(s, value))) {
      return _v('duplicate_identity', '$base/$i/$key');
    }
    seen.add(value);
  }
  return null;
}

Violation? _masks(List<Object?> points, List<Object?> mask, String path) {
  for (var j = 0; j < mask.length; j++) {
    if ((points[j] != null) != mask[j]) return _v('mask_mismatch', '$path/$j');
  }
  return null;
}

Violation? _recordingSource(Json doc) {
  final files = _list(doc['files']).map(_obj).toList();
  final dup = _duplicate(files, 'file_id', '/files');
  if (dup != null) return dup;
  int required(String role) =>
      files.where((f) => f['role'] == role && f['required'] == true).length;
  if (required('source_mcap') != 1 || required('recorder_metadata') < 1) {
    return _v('inventory_incomplete', '/files');
  }
  final domains = _list(doc['clock_domains']);
  final channels = _list(doc['channels']);
  for (var i = 0; i < channels.length; i++) {
    if (!domains.contains(_obj(channels[i])['clock_domain'])) {
      return _v('reference_mismatch', '/channels/$i/clock_domain');
    }
  }
  return null;
}

Violation? _frameMap(Json doc) {
  final rows = _list(doc['rows']).map(_obj).toList();
  if (!_same(rows.length, doc['frame_count']))
    return _v('dimension_mismatch', '/rows');
  final first = rows.first;
  for (var i = 0; i < rows.length; i++) {
    final row = rows[i];
    final p = '/rows/$i';
    if (!_same(row['frame_index'], i))
      return _v('ordering_violation', '$p/frame_index');
    if (row['clock_domain'] != first['clock_domain']) {
      return _v('clock_mismatch', '$p/clock_domain');
    }
    if (i > 0) {
      final prev = rows[i - 1];
      if (_big(row['timestamp_ns']) <= _big(prev['timestamp_ns'])) {
        return _v('ordering_violation', '$p/timestamp_ns');
      }
      if (_big(row['source_pts']) <= _big(prev['source_pts'])) {
        return _v('ordering_violation', '$p/source_pts');
      }
    }
    if (_big(row['clip_pts']) !=
        _big(row['source_pts']) - _big(first['source_pts'])) {
      return _v('clock_mismatch', '$p/clip_pts');
    }
    final raster = _obj(row['raster']);
    final crop = _obj(_obj(row['transform'])['crop']);
    num n(Json o, String k) => o[k]! as num;
    if (n(crop, 'x') + n(crop, 'width') > n(raster, 'width') ||
        n(crop, 'y') + n(crop, 'height') > n(raster, 'height')) {
      return _v('dimension_mismatch', '$p/transform/crop');
    }
  }
  return null;
}

Violation? _handObservations(Json doc) {
  final frames = _list(doc['frames']).map(_obj).toList();
  if (!_same(frames.length, doc['frame_count']))
    return _v('dimension_mismatch', '/frames');
  for (var i = 0; i < frames.length; i++) {
    final p = '/frames/$i';
    if (!_same(frames[i]['frame_index'], i))
      return _v('ordering_violation', '$p/frame_index');
    final hands = _list(frames[i]['hands']).map(_obj).toList();
    final dup = _duplicate(hands, 'hand_index', '$p/hands');
    if (dup != null) return dup;
    for (var j = 0; j < hands.length; j++) {
      final h = '$p/hands/$j';
      final image = _masks(
        _list(hands[j]['image_landmarks_px']),
        _list(hands[j]['image_mask']),
        '$h/image_mask',
      );
      if (image != null) return image;
      final points = _obj(hands[j]['points_3d']);
      final joints = _masks(
        _list(points['joints']),
        _list(points['mask']),
        '$h/points_3d/mask',
      );
      if (joints != null) return joints;
    }
  }
  return null;
}

Violation? _processingResult(Json doc) {
  final outputs = _list(doc['outputs']).map(_obj).toList();
  final dup =
      _duplicate(outputs, 'file_id', '/outputs') ??
      _duplicate(outputs, 'relative_path', '/outputs');
  if (dup != null) return dup;
  for (var i = 0; i < outputs.length; i++) {
    if (outputs[i]['role'] == 'result_manifest') {
      return _v('reference_mismatch', '/outputs/$i/role');
    }
  }
  final roles = {for (final o in outputs) o['file_id']: o['role']};
  final clips = _list(doc['clips']).map(_obj).toList();
  final clipDup = _duplicate(clips, 'clip_id', '/clips');
  if (clipDup != null) return clipDup;
  for (var i = 0; i < clips.length; i++) {
    final clip = clips[i];
    final p = '/clips/$i';
    if (!_same(clip['clip_ordinal'], i))
      return _v('ordering_violation', '$p/clip_ordinal');
    final files = _obj(clip['files']);
    for (final entry in _outputRole.entries) {
      if (roles[files[entry.key]] != entry.value) {
        return _v('reference_mismatch', '$p/files/${entry.key}');
      }
    }
    final start = _big(clip['source_start_ns']);
    final end = _big(clip['source_end_ns']);
    if (end < start) return _v('clock_mismatch', '$p/source_end_ns');
    if (_big(clip['duration_ns']) != end - start)
      return _v('clock_mismatch', '$p/duration_ns');
    final arrays = _list(
      _obj(clip['hand_arrays'])['arrays'],
    ).map(_obj).toList();
    for (var k = 0; k < handArrayShapes.length; k++) {
      final shape = _list(arrays[k]['shape']);
      final expected = handArrayShapes[k];
      for (var d = 0; d < expected.length; d++) {
        final want = expected[d] == 'F' ? clip['frame_count'] : expected[d];
        if (!_same(shape[d], want)) {
          return _v('dimension_mismatch', '$p/hand_arrays/arrays/$k/shape');
        }
      }
    }
  }
  return null;
}

final Map<String, Rule> rules = {
  'unique_file_ids': (doc) =>
      _duplicate(_list(doc['files']), 'fileId', '/files'),
  'unique_part_numbers': (doc) =>
      _duplicate(_list(doc['receipts']), 'partNumber', '/receipts'),
  'upload_plan': (doc) {
    final size = _big(doc['sizeBytes']);
    final parts = (size + BigInt.from(_partSize - 1)) ~/ BigInt.from(_partSize);
    final count = doc['partCount']! as num;
    return BigInt.from(count) == parts && count == count.truncate()
        ? null
        : _v('part_plan_mismatch', '/partCount');
  },
  'heartbeat_progress': (doc) {
    final total = doc['totalFrames'];
    if (doc.containsKey('processedFrames') &&
        total != null &&
        _big(doc['processedFrames']) > _big(total)) {
      return _v('progress_mismatch', '/processedFrames');
    }
    return null;
  },
  'recording_source': _recordingSource,
  'frame_map': _frameMap,
  'hand_observations': _handObservations,
  'processing_result': _processingResult,
};
