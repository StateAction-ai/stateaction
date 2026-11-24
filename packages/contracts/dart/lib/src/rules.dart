// Cross-field rules; same order, codes and paths as packages/contracts/src/rules.ts.

import 'dart:convert';

import 'package:crypto/crypto.dart';

import 'canonical.dart';

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
  ['F', 2], // hand_detected
  ['F', 2], // handedness_score
  ['F', 2], // handedness: int8 0 left, 1 right, -1 none
  ['F'], // frame_index
];

const _active = {'preflight', 'recording', 'finalizing'};
const _finalOutcomes = {'completed', 'interrupted'};
const _recoverable = {'finalizing', 'recovery_required'};

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

/// RFC 3339 UTC (schema-validated) to a fixed-width key with 9 fraction digits.
String _instant(Object? value) {
  final text = value! as String;
  final fraction = text.length > 20 ? text.substring(20, text.length - 1) : '';
  return text.substring(0, 19) + fraction.padRight(9, '0');
}

int _count(List<Json> items, String role, [bool? required]) => items
    .where(
      (f) =>
          f['role'] == role && (required == null || f['required'] == required),
    )
    .length;

/// Cross-document check: the sealed inventory (http.recording-seal.v1) holds
/// exactly the declaration's files (artifacts.recording-source.v1) plus one
/// source_manifest entry. Both must already be contract-valid; paths point into
/// the declaration.
Violation? checkSealedInventory(Json seal, Json declaration) {
  final sealed = _list(
    seal['files'],
  ).map(_obj).where((f) => f['role'] != 'source_manifest').toList();
  final declared = _list(declaration['files']).map(_obj).toList();
  if (declared.length != sealed.length) {
    return _v('inventory_incomplete', '/files');
  }
  for (var i = 0; i < declared.length; i++) {
    final file = declared[i];
    final match = sealed.where((f) => f['fileId'] == file['file_id']);
    if (match.isEmpty) return _v('inventory_incomplete', '/files/$i/file_id');
    for (final (snake, camel) in const [
      ('role', 'role'),
      ('size_bytes', 'sizeBytes'),
      ('sha256', 'sha256'),
      ('required', 'required'),
    ]) {
      if (match.first[camel] != file[snake]) {
        return _v('reference_mismatch', '/files/$i/$snake');
      }
    }
  }
  return null;
}

Violation? _captureSnapshot(Json doc, String base) {
  final c = _obj(doc['counters']);
  BigInt n(String key) => _big(c[key]);
  if (n('videoFramesSubmitted') > n('videoFramesAcquired')) {
    return _v('progress_mismatch', '$base/counters/videoFramesSubmitted');
  }
  if (n('videoFramesWritten') > n('videoFramesSubmitted')) {
    return _v('progress_mismatch', '$base/counters/videoFramesWritten');
  }
  if (n('videoFramesWritten') +
          n('videoFramesDropped') +
          n('videoFramesUnresolved') >
      n('videoFramesAcquired')) {
    return _v('progress_mismatch', '$base/counters/videoFramesAcquired');
  }
  final state = doc['state'];
  final container = doc['containerState'];
  final outcome = doc['captureOutcome'];
  final (bool containerOk, bool outcomeOk) = _active.contains(state)
      ? (container == null, outcome == null)
      : state == 'finalized'
      ? (container == 'closed', _finalOutcomes.contains(outcome))
      : state == 'recovery_required'
      ? (container == 'unclosed', outcome == null)
      : (container != null, outcome == 'failed'); // quarantined
  if (!containerOk) return _v('outcome_mismatch', '$base/containerState');
  if (!outcomeOk) return _v('outcome_mismatch', '$base/captureOutcome');
  if (state == 'finalized') {
    // A clean finalized take has no unresolved frames and every acquired
    // frame is accounted for as written or dropped.
    if (n('videoFramesUnresolved') != BigInt.zero) {
      return _v('progress_mismatch', '$base/counters/videoFramesUnresolved');
    }
    if (n('videoFramesWritten') + n('videoFramesDropped') !=
        n('videoFramesAcquired')) {
      return _v('progress_mismatch', '$base/counters/videoFramesAcquired');
    }
  }
  return null;
}

Violation? _claimGrant(Json doc) {
  final inputs = _list(doc['inputs']).map(_obj).toList();
  final dup = _duplicate(inputs, 'fileId', '/inputs');
  if (dup != null) return dup;
  if (_count(inputs, 'source_manifest') != 1 ||
      _count(inputs, 'source_mcap') != 1) {
    return _v('inventory_incomplete', '/inputs');
  }
  final m = inputs.indexWhere((f) => f['role'] == 'source_manifest');
  if (inputs[m]['sha256'] != _obj(doc['digests'])['sourceManifestSha256']) {
    return _v('reference_mismatch', '/inputs/$m/sha256');
  }
  if (_instant(
        doc['startDeadline'],
      ).compareTo(_instant(doc['executionDeadline'])) >
      0) {
    return _v('ordering_violation', '/executionDeadline');
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
  // The declaration is the source_manifest file; it never lists itself.
  for (var i = 0; i < files.length; i++) {
    if (files[i]['role'] == 'source_manifest') {
      return _v('reference_mismatch', '/files/$i/role');
    }
  }
  if (_count(files, 'source_mcap') != 1 ||
      _count(files, 'source_mcap', true) != 1 ||
      _count(files, 'recorder_metadata', true) < 1) {
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
  final dup = _duplicate(rows, 'source_frame_id', '/rows');
  if (dup != null) return dup;
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
      _duplicate(
        _list(doc['verified_sources']),
        'file_id',
        '/verified_sources',
      ) ??
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
  final claimed = <Object?>{};
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
    // Each output file belongs to exactly one clip.
    for (final key in _outputRole.keys) {
      if (!claimed.add(files[key])) {
        return _v('duplicate_identity', '$p/files/$key');
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

final Map<String, Rule> _baseRules = {
  'unique_file_ids': (doc) =>
      _duplicate(_list(doc['files']), 'fileId', '/files'),
  'sealed_inventory': (doc) {
    final files = _list(doc['files']).map(_obj).toList();
    return _count(files, 'source_manifest') != 1 ||
            _count(files, 'source_manifest', true) != 1 ||
            _count(files, 'source_mcap') != 1 ||
            _count(files, 'source_mcap', true) != 1 ||
            _count(files, 'recorder_metadata', true) < 1
        ? _v('inventory_incomplete', '/files')
        : null;
  },
  'claim_grant': _claimGrant,
  'result_candidate': (doc) {
    final summary = _obj(doc['summary']);
    return (summary['outcome'] == 'succeeded') != (summary['errorCode'] == null)
        ? _v('outcome_mismatch', '/summary/errorCode')
        : null;
  },
  'capture_snapshot': (doc) => _captureSnapshot(doc, ''),
  'capture_recoverable': (doc) {
    final captures = _list(doc['captures']).map(_obj).toList();
    final dup = _duplicate(captures, 'clientRecordingId', '/captures');
    if (dup != null) return dup;
    for (var i = 0; i < captures.length; i++) {
      final found = _captureSnapshot(captures[i], '/captures/$i');
      if (found != null) return found;
      if (!_recoverable.contains(captures[i]['state'])) {
        return _v('outcome_mismatch', '/captures/$i/state');
      }
    }
    return null;
  },
  'capture_capabilities': (doc) {
    final accepted = doc['outcome'] == 'accepted';
    if (accepted != (doc['acceptedProfile'] != null)) {
      return _v('outcome_mismatch', '/acceptedProfile');
    }
    if (accepted != _list(doc['unsupportedReasons']).isEmpty) {
      return _v('outcome_mismatch', '/unsupportedReasons');
    }
    return null;
  },
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

// ---------------------------------------------------------------- SA-87 stage contracts

const _stageRoles = <String, List<String>>{
  'segment': ['segments_json', 'diagnostic_blob'],
  'caption': ['captions_json', 'diagnostic_blob'],
  'hand_pose': [
    'clip_mp4',
    'hand_arrays_npz',
    'hand_observations_json',
    'frame_map_json',
    'thumbnail_jpeg',
    'viewer_rrd',
    'hand_presence_json',
    'recording_mp4',
    'diagnostic_blob',
  ],
};
const _primaryRoles = <String, List<String>>{
  'segment': ['segments_json'],
  'caption': ['captions_json'],
  'hand_pose': ['hand_presence_json', 'recording_mp4'],
};
const _codedStates = {'failed', 'cancelled', 'not_run'};
const _stageOrder = ['segment', 'caption', 'hand_pose'];

/// uuid5(NAMESPACE_URL, "https://stateaction.ai/schemas/artifacts/segments.v1.json").
const segmentIdNamespace = 'a505457d-7470-5704-b995-1b3d1e3638df';

/// RFC 9562 UUIDv5 of a UTF-8 name.
String uuid5(String namespace, String name) {
  final ns = <int>[
    for (var i = 0; i < 32; i += 2)
      int.parse(namespace.replaceAll('-', '').substring(i, i + 2), radix: 16),
  ];
  final hash = sha1.convert([...ns, ...utf8.encode(name)]).bytes.toList();
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  final hex = [
    for (final b in hash.take(16)) b.toRadixString(16).padLeft(2, '0'),
  ].join();
  return '${hex.substring(0, 8)}-${hex.substring(8, 12)}-'
      '${hex.substring(12, 16)}-${hex.substring(16, 20)}-${hex.substring(20)}';
}

String _segmentId(
  Object? sourceManifestSha256,
  String moduleRef,
  Object? paramsSha256,
  Object? startFrameId,
  Object? endFrameId,
) => uuid5(
  segmentIdNamespace,
  [
    sourceManifestSha256,
    moduleRef,
    paramsSha256,
    startFrameId,
    endFrameId ?? 'end',
  ].join('|'),
);

bool _isEnd(Json ref) => ref['source_frame_id'] == null;
bool _before(Json a, Json b) {
  if (_isEnd(b)) return !_isEnd(a);
  if (_isEnd(a)) return false;
  return _big(a['source_frame_id']) < _big(b['source_frame_id']) &&
      _big(a['timestamp_ns']) < _big(b['timestamp_ns']);
}

bool _atOrBefore(Json a, Json b) {
  if (_isEnd(b)) return true;
  if (_isEnd(a)) return false;
  return _big(a['source_frame_id']) <= _big(b['source_frame_id']) &&
      _big(a['timestamp_ns']) <= _big(b['timestamp_ns']);
}

bool _sameRef(Json a, Json b) =>
    a['source_frame_id'] == b['source_frame_id'] &&
    a['timestamp_ns'] == b['timestamp_ns'];

String _ref(Object? id, Object? version) => '$id@${(version! as num).toInt()}';

/// text split on commas, each step trimmed of spaces and tabs, empty steps dropped.
List<String> captionSteps(String text) => [
  for (final step in text.split(','))
    if (step.replaceAll(RegExp(r'^[ \t]+|[ \t]+$'), '').isNotEmpty)
      step.replaceAll(RegExp(r'^[ \t]+|[ \t]+$'), ''),
];

Json _moduleIndex(Json manifest) => {
  for (final m in _list(manifest['modules']).map(_obj))
    _ref(m['moduleId'], m['version']): m,
};

Violation? _producerRule(Json modules, Json doc, String stage) {
  final p = _obj(doc['producer']);
  if (p['stage'] != stage) return _v('reference_mismatch', '/producer/stage');
  if ((doc['schema']! as String).endsWith('.v2')) {
    return p['module_id'] == 'imported_$stage' && _same(p['module_version'], 1)
        ? null
        : _v('reference_mismatch', '/producer/module_id');
  }
  final module = modules[_ref(p['module_id'], p['module_version'])];
  if (module == null || _obj(module)['stage'] != stage) {
    return _v('reference_mismatch', '/producer/module_id');
  }
  final m = _obj(module);
  final provenance = _obj(m['provenance']);
  if (provenance['modelName'] != p['model_name']) {
    return _v('reference_mismatch', '/producer/model_name');
  }
  if (provenance['engine'] != _obj(p['engine'])['name']) {
    return _v('reference_mismatch', '/producer/engine/name');
  }
  final gpu = _obj(p['gpu']);
  for (final field in _list(provenance['requires'])) {
    final (value, path) = field == 'observed_gpu'
        ? (gpu['observed_type'], '/producer/gpu/observed_type')
        : (p[field], '/producer/$field');
    if (value == null && (field == 'observed_gpu' || p.containsKey(field))) {
      return _v('reference_mismatch', path);
    }
  }
  if (!_list(_obj(m['gpu'])['supported']).contains(gpu['requested_type'])) {
    return _v('reference_mismatch', '/producer/gpu/requested_type');
  }
  return null;
}

Violation? _recipeRule(Json modules, Json doc, String base) {
  final stages = _list(doc['stages']).map(_obj).toList();
  if (stages[1]['enabled'] == true && stages[0]['enabled'] != true) {
    return _v('reference_mismatch', '$base/stages/1/enabled');
  }
  for (var i = 0; i < stages.length; i++) {
    final stage = stages[i];
    final module = modules[stage['module']];
    if (module == null || _obj(module)['stage'] != stage['stage']) {
      return _v('reference_mismatch', '$base/stages/$i/module');
    }
    if (!_list(
      _obj(_obj(module)['gpu'])['supported'],
    ).contains(_obj(stage['resources'])['gpu'])) {
      return _v('reference_mismatch', '$base/stages/$i/resources/gpu');
    }
  }
  return null;
}

Violation? _stageReceiptRule(Json doc, String base) {
  if ((doc['status'] == 'succeeded') != (doc['errorCode'] == null)) {
    return _v('outcome_mismatch', '$base/errorCode');
  }
  final outputs = _list(doc['outputs']).map(_obj).toList();
  final dup = _duplicate(outputs, 'fileId', '$base/outputs');
  if (dup != null) return dup;
  final allowed = _stageRoles[doc['stage']]!;
  for (var i = 0; i < outputs.length; i++) {
    if (!allowed.contains(outputs[i]['role'])) {
      return _v('reference_mismatch', '$base/outputs/$i/role');
    }
  }
  if (doc['status'] == 'succeeded' && doc['stage'] != 'hand_pose') {
    for (final role in _primaryRoles[doc['stage']]!) {
      if (outputs.where((o) => o['role'] == role).length != 1) {
        return _v('inventory_incomplete', '$base/outputs');
      }
    }
  }
  if (_instant(doc['finishedAt']).compareTo(_instant(doc['startedAt'])) < 0) {
    return _v('ordering_violation', '$base/finishedAt');
  }
  return null;
}

Violation? _segments(Json modules, Json doc) {
  final found = _producerRule(modules, doc, 'segment');
  if (found != null) return found;
  final windows = _obj(doc['windows']);
  final failed = _list(windows['failed']).map(_obj).toList();
  final spans = _list(windows['failed_core_spans']).map(_obj).toList();
  if (!_same((windows['ok']! as num) + failed.length, windows['total'])) {
    return _v('progress_mismatch', '/windows/ok');
  }
  final dup = _duplicate(failed, 'window_index', '/windows/failed');
  if (dup != null) return dup;
  for (var i = 0; i < spans.length; i++) {
    final span = spans[i];
    final p = '/windows/failed_core_spans/$i';
    if (!_before(_obj(span['start']), _obj(span['end']))) {
      return _v('ordering_violation', '$p/end');
    }
    if (i > 0 && !_atOrBefore(_obj(spans[i - 1]['end']), _obj(span['start']))) {
      return _v('ordering_violation', '$p/start');
    }
  }
  final covered = <int>{};
  for (var i = 0; i < failed.length; i++) {
    final start = _obj(failed[i]['core_start']);
    final end = _obj(failed[i]['core_end']);
    if (!_before(start, end)) {
      return _v('ordering_violation', '/windows/failed/$i/core_end');
    }
    final k = spans.indexWhere(
      (span) =>
          _atOrBefore(_obj(span['start']), start) &&
          _atOrBefore(end, _obj(span['end'])),
    );
    // A failed window must lie inside a recorded failed core span.
    if (k < 0) return _v('reference_mismatch', '/windows/failed/$i');
    covered.add(k);
  }
  for (var i = 0; i < spans.length; i++) {
    if (!covered.contains(i)) {
      return _v('reference_mismatch', '/windows/failed_core_spans/$i');
    }
  }
  final rows = _list(doc['rows']).map(_obj).toList();
  final p0 = _obj(doc['producer']);
  final moduleRef = _ref(p0['module_id'], p0['module_version']);
  final seen = <Object?>{};
  for (var i = 0; i < rows.length; i++) {
    final row = rows[i];
    final p = '/rows/$i';
    if (!_same(row['ordinal'], i))
      return _v('ordering_violation', '$p/ordinal');
    if (!seen.add(row['segment_id'])) {
      return _v('duplicate_identity', '$p/segment_id');
    }
    final start = _obj(row['start']);
    final end = _obj(row['end']);
    if (!_before(start, end)) return _v('ordering_violation', '$p/end');
    final boundary = doc['schema'] == 'stateaction.segments.v2'
        ? 'start'
        : 'end';
    if (i > 0 && !_atOrBefore(_obj(rows[i - 1][boundary]), start)) {
      return _v('ordering_violation', '$p/start');
    }
    final expected = _segmentId(
      doc['source_manifest_sha256'],
      moduleRef,
      p0['params_sha256'],
      start['source_frame_id'],
      end['source_frame_id'],
    );
    if (row['segment_id'] != expected) {
      return _v('reference_mismatch', '$p/segment_id');
    }
  }
  // Failed windows are rows too: failed_window rows equal the failed core spans, in order.
  var k = 0;
  for (var i = 0; i < rows.length; i++) {
    final row = rows[i];
    if (row['status'] != 'failed_window') continue;
    if (k >= spans.length ||
        !_sameRef(_obj(spans[k]['start']), _obj(row['start'])) ||
        !_sameRef(_obj(spans[k]['end']), _obj(row['end']))) {
      return _v('reference_mismatch', '/rows/$i/status');
    }
    k++;
  }
  if (k < spans.length) {
    return _v('reference_mismatch', '/windows/failed_core_spans/$k');
  }
  return null;
}

Violation? _captions(Json modules, Json doc) {
  final found = _producerRule(modules, doc, 'caption');
  if (found != null) return found;
  final rows = _list(doc['rows']).map(_obj).toList();
  final dup = _duplicate(rows, 'segment_id', '/rows');
  if (dup != null) return dup;
  for (var i = 0; i < rows.length; i++) {
    final row = rows[i];
    if (row['status'] != 'complete') continue;
    final steps = _list(_obj(row['derived'])['steps']);
    final expected = captionSteps(row['text']! as String);
    var same = steps.length == expected.length;
    for (var j = 0; same && j < steps.length; j++) {
      same = steps[j] == expected[j];
    }
    if (!same) return _v('reference_mismatch', '/rows/$i/derived/steps');
  }
  return null;
}

Violation? _handPresence(Json modules, Json doc) {
  final found = _producerRule(modules, doc, 'hand_pose');
  if (found != null) return found;
  final lanes = _obj(doc['lanes']);
  for (final side in const ['left', 'right']) {
    final base = '/lanes/$side';
    final spans = _list(lanes[side]).map(_obj).toList();
    num frames = 0;
    for (var i = 0; i < spans.length; i++) {
      final span = spans[i];
      final p = '$base/$i';
      if (!_before(_obj(span['start']), _obj(span['end']))) {
        return _v('ordering_violation', '$p/end');
      }
      if (i > 0) {
        final prev = spans[i - 1];
        if (!_sameRef(_obj(prev['end']), _obj(span['start']))) {
          return _v('ordering_violation', '$p/start');
        }
        if (prev['state'] == span['state']) {
          return _v('ordering_violation', '$p/state');
        }
      }
      frames += span['frames']! as num;
    }
    final last = spans.length - 1;
    if (!_isEnd(_obj(spans[last]['end']))) {
      return _v('dimension_mismatch', '$base/$last/end');
    }
    if (!_same(frames, doc['frame_count'])) {
      return _v('dimension_mismatch', base);
    }
  }
  return null;
}

Violation? _moduleManifest(Json doc) {
  final modules = _list(doc['modules']).map(_obj).toList();
  final seen = <String>{};
  for (var i = 0; i < modules.length; i++) {
    final module = modules[i];
    final p = '/modules/$i';
    if (!seen.add(_ref(module['moduleId'], module['version']))) {
      return _v('duplicate_identity', '$p/version');
    }
    final gpu = _obj(module['gpu']);
    if (!_list(gpu['supported']).contains(gpu['minimum'])) {
      return _v('reference_mismatch', '$p/gpu/minimum');
    }
    final allowed = _stageRoles[module['stage']]!;
    final outputs = _list(module['outputs']);
    for (var j = 0; j < outputs.length; j++) {
      if (!allowed.contains(outputs[j])) {
        return _v('reference_mismatch', '$p/outputs/$j');
      }
    }
  }
  return null;
}

Violation? _processingResultNodes(Json doc) {
  final outputs = _list(doc['outputs']).map(_obj).toList();
  final roles = {for (final o in outputs) o['file_id']: o['role']! as String};
  final claimed = <Object?>{};
  final nodes = _list(doc['nodes']).map(_obj).toList();
  for (var i = 0; i < nodes.length; i++) {
    final node = nodes[i];
    final p = '/nodes/$i';
    if ((node['status'] == 'succeeded') != (node['error_code'] == null)) {
      return _v('outcome_mismatch', '$p/error_code');
    }
    final files = _list(node['outputs']);
    if (node['status'] == 'not_run' && files.isNotEmpty) {
      return _v('outcome_mismatch', '$p/outputs');
    }
    final allowed = _stageRoles[node['stage']]!;
    final nodeRoles = <String>[];
    for (var j = 0; j < files.length; j++) {
      final role = roles[files[j]];
      if (role == null || !allowed.contains(role)) {
        return _v('reference_mismatch', '$p/outputs/$j');
      }
      if (!claimed.add(files[j])) {
        return _v('duplicate_identity', '$p/outputs/$j');
      }
      nodeRoles.add(role);
    }
    if (node['status'] == 'succeeded') {
      for (final role in _primaryRoles[node['stage']]!) {
        if (nodeRoles.where((r) => r == role).length != 1) {
          return _v('inventory_incomplete', '$p/outputs');
        }
      }
    }
  }
  for (var k = 0; k < outputs.length; k++) {
    if (!claimed.contains(outputs[k]['file_id'])) {
      return _v('reference_mismatch', '/outputs/$k/file_id');
    }
  }
  return null;
}

Violation? _stageRunAction(Json doc) {
  if (doc['action'] != 'record_stage_run') return null;
  final state = doc['state']! as String;
  if (doc.containsKey('errorCode') != _codedStates.contains(state)) {
    return _v('outcome_mismatch', '/errorCode');
  }
  final terminal = state == 'succeeded' || state == 'failed';
  if (doc.containsKey('receipt') ? !terminal : state == 'succeeded') {
    return _v('outcome_mismatch', '/receipt');
  }
  if (!doc.containsKey('receipt')) return null;
  final receipt = _obj(doc['receipt']);
  if (receipt['stage'] != doc['stage']) {
    return _v('reference_mismatch', '/receipt/stage');
  }
  if (receipt['module'] != doc['module']) {
    return _v('reference_mismatch', '/receipt/module');
  }
  if (receipt['status'] != state) {
    return _v('outcome_mismatch', '/receipt/status');
  }
  return _stageReceiptRule(receipt, '/receipt');
}

Violation? _dagRun(Json doc) {
  final stages = _list(doc['stages']).map(_obj).toList();
  for (var i = 0; i < stages.length; i++) {
    final node = stages[i];
    final p = '/stages/$i';
    if (i >= _stageOrder.length || node['stage'] != _stageOrder[i]) {
      return _v('ordering_violation', '$p/stage');
    }
    final state = node['state']! as String;
    if (node['enabled'] != true && state != 'not_run') {
      return _v('outcome_mismatch', '$p/state');
    }
    if (_codedStates.contains(state) != (node['errorCode'] != null)) {
      return _v('outcome_mismatch', '$p/errorCode');
    }
    if (state == 'succeeded' && node['receiptSha256'] == null) {
      return _v('outcome_mismatch', '$p/receiptSha256');
    }
    if (node['startedAt'] != null &&
        node['finishedAt'] != null &&
        _instant(node['finishedAt']).compareTo(_instant(node['startedAt'])) <
            0) {
      return _v('ordering_violation', '$p/finishedAt');
    }
  }
  return null;
}

Violation? _recordingAnnotations(Json modules, Json doc) {
  // Artifact parts may retain producer job IDs. The DAG always names this job.
  const parts = [
    ('segments', 'job_id', 'recording_id'),
    ('captions', 'job_id', 'recording_id'),
    ('hand_presence', 'job_id', 'recording_id'),
    ('dag_run', 'jobId', 'recordingId'),
  ];
  for (final (key, jobKey, recordingKey) in parts) {
    final part = doc[key];
    final producers = doc['producer_jobs'];
    final hasProducer = producers != null && key != 'dag_run';
    final expectedJob = hasProducer ? _obj(producers)[key] : doc['job_id'];
    if (part == null) {
      if (hasProducer && expectedJob != null) {
        return _v('reference_mismatch', '/producer_jobs/$key');
      }
      continue;
    }
    if (_obj(part)[jobKey] != expectedJob) {
      return _v('reference_mismatch', '/$key/$jobKey');
    }
    if (_obj(part)[recordingKey] != doc['recording_id']) {
      return _v('reference_mismatch', '/$key/$recordingKey');
    }
  }
  // Each embedded part keeps its own cross-field rules.
  for (final (key, _, _) in parts) {
    final part = doc[key];
    if (part == null) continue;
    final found = switch (key) {
      'segments' => _segments(modules, _obj(part)),
      'captions' => _captions(modules, _obj(part)),
      'hand_presence' => _handPresence(modules, _obj(part)),
      _ => _dagRun(_obj(part)),
    };
    if (found != null) return _v(found.code, '/$key${found.path}');
  }
  if (doc['segments'] != null && doc['captions'] != null) {
    final ids = _list(
      _obj(doc['segments'])['rows'],
    ).map((row) => _obj(row)['segment_id']).toSet();
    final rows = _list(_obj(doc['captions'])['rows']);
    for (var i = 0; i < rows.length; i++) {
      if (!ids.contains(_obj(rows[i])['segment_id'])) {
        return _v('reference_mismatch', '/captions/rows/$i/segment_id');
      }
    }
  }
  return null;
}

/// Rules that resolve modules in the committed api/modules.json.
const moduleRules = {
  'segments',
  'captions',
  'hand_presence',
  'recording_annotations',
  'recipe',
  'task_input_recipe',
};

/// All rules; [modulesManifest] is the committed api/modules.json.
Map<String, Rule> buildRules(Json modulesManifest) {
  final modules = _moduleIndex(modulesManifest);
  return {
    ..._baseRules,
    'segments': (doc) => _segments(modules, doc),
    'captions': (doc) => _captions(modules, doc),
    'hand_presence': (doc) => _handPresence(modules, doc),
    'recipe': (doc) => _recipeRule(modules, doc, ''),
    'module_manifest': _moduleManifest,
    'task_input_recipe': (doc) {
      if (doc['kind'] != 'process_recording') return null;
      final found = _recipeRule(modules, _obj(doc['recipe']), '/recipe');
      if (found != null) return found;
      return requestSha256(doc['recipe']) == doc['recipeSha256']
          ? null
          : _v('reference_mismatch', '/recipeSha256');
    },
    'processing_result_nodes': _processingResultNodes,
    'heartbeat_stage': (doc) =>
        (doc['phase'] == 'segmenting' && doc['stage'] != 'segment') ||
            (doc['phase'] == 'captioning' && doc['stage'] != 'caption')
        ? _v('reference_mismatch', '/phase')
        : null,
    'stage_receipt': (doc) => _stageReceiptRule(doc, ''),
    'stage_run_action': _stageRunAction,
    'dag_run': _dagRun,
    'recording_annotations': (doc) => _recordingAnnotations(modules, doc),
  };
}
