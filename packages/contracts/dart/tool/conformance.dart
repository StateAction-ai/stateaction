// Run the shared SA-12 fixtures through the Dart adapter; exits non-zero on any mismatch.
import 'dart:convert';
import 'dart:io';

import 'package:stateaction_contracts/stateaction_contracts.dart';

final contracts = Directory.fromUri(Platform.script.resolve('../../'));
Uri _api(String path) => contracts.uri.resolve('api/$path');
Uri _fixture(String path) =>
    contracts.uri.resolve('conformance/fixtures/$path');
List<int> read(String path) => File.fromUri(_fixture(path)).readAsBytesSync();
Object? readJson(String path) => jsonDecode(utf8.decode(read(path)));
Map<String, Object?> _map(Object? value) => value! as Map<String, Object?>;

Object? pointerGet(Object? doc, String pointer) {
  var node = doc;
  for (final raw in pointer.split('/').skip(1)) {
    final part = raw.replaceAll('~1', '/').replaceAll('~0', '~');
    node = node is List<Object?> ? node[int.parse(part)] : _map(node)[part];
  }
  return node;
}

Object? _clone(Object? value) => jsonDecode(jsonEncode(value));

ValidationResult runCase(
  ContractRegistry registry,
  String contract,
  Map<String, Object?> input,
) {
  if (input.containsKey('document'))
    return registry.validateValue(contract, input['document']);
  if (input.containsKey('json')) {
    final text = input['json']! as String;
    // Encode UTF-16 code units directly so lone-surrogate cases reach the parser.
    return registry.validateBytes(contract, utf8.encode(text));
  }
  if (input.containsKey('base64')) {
    return registry.validateBytes(
      contract,
      base64.decode(input['base64']! as String),
    );
  }
  if (input.containsKey('file'))
    return registry.validateBytes(contract, read(input['file']! as String));
  if (input.containsKey('pad')) {
    final pad = _map(input['pad']);
    final bytes = read(pad['file']! as String);
    final total = pad['totalBytes']! as int;
    return registry.validateBytes(contract, [
      ...bytes,
      ...List.filled(total - bytes.length, 0x20),
    ]);
  }
  if (input.containsKey('repeat')) {
    final repeat = _map(input['repeat']);
    final doc = _clone(repeat['document']);
    final items =
        pointerGet(doc, repeat['pointer']! as String)! as List<Object?>;
    while (items.length < (repeat['count']! as int)) {
      items.add(_clone(items.first));
    }
    return registry.validateValue(contract, doc);
  }
  throw ArgumentError('Unknown fixture input ${input.keys}');
}

void main(List<String> args) {
  final catalog = _map(
    jsonDecode(File.fromUri(_api('catalog.v2.json')).readAsStringSync()),
  );
  final registry = ContractRegistry.load(
    catalog,
    (path) => _map(jsonDecode(File.fromUri(_api(path)).readAsStringSync())),
  );
  final failures = <String>[];
  final report = <String, String>{};
  var cases = 0;
  void check(bool ok, String label) {
    cases++;
    if (!ok) failures.add(label);
  }

  final fixtureFiles =
      Directory.fromUri(_fixture('contracts/'))
          .listSync()
          .whereType<File>()
          .map((f) => f.uri.pathSegments.last)
          .toList()
        ..sort();
  final ids = fixtureFiles
      .map((f) => f.replaceAll(RegExp(r'\.json$'), ''))
      .toList();
  check(
    ids.join(',') == registry.contractIds.join(','),
    'fixture files cover every contract',
  );

  for (final file in fixtureFiles) {
    final fixture = _map(readJson('contracts/$file'));
    final contract = fixture['contract']! as String;
    for (final raw in fixture['cases']! as List<Object?>) {
      final c = _map(raw);
      final label = '$contract / ${c['name']}';
      final expect = _map(c['expect']);
      final result = runCase(registry, contract, _map(c['input']));
      report[label] = result.valid ? 'valid' : result.code!;
      if (expect['valid'] == true) {
        check(result.valid, '$label: expected valid, got $result');
        continue;
      }
      check(
        !result.valid && result.code == expect['code'],
        '$label: expected ${expect['code']}, got $result',
      );
      final paths = result.errors.map((e) => e.path).toSet();
      for (final p in (expect['paths'] as List<Object?>? ?? const [])) {
        check(paths.contains(p), '$label: expected path $p in $paths');
      }
    }
  }

  final digests = _map(readJson('digests.v1.json'));
  for (final raw in digests['requestDigests']! as List<Object?>) {
    final c = _map(raw);
    final label = 'request digest / ${c['name']}';
    final text = c['json']! as String;
    if (c.containsKey('error')) {
      String? code;
      try {
        canonicalJsonText(text);
      } on NoncanonicalValueError catch (e) {
        code = e.code;
      } on MalformedJsonError catch (e) {
        code = e.code;
      }
      check(code == c['error'], '$label: expected ${c['error']}, got $code');
      continue;
    }
    check(canonicalJsonText(text) == c['canonical'], '$label: canonical text');
    check(requestSha256(decodeStrict(text)) == c['sha256'], '$label: digest');
    check(
      sha256Hex(utf8.encode(c['canonical']! as String)) == c['sha256'],
      '$label: golden digest',
    );
  }
  for (final raw in digests['idempotency']! as List<Object?>) {
    final c = _map(raw);
    final decision = classifyReplay(
      c['storedSha256']! as String,
      jsonDecode(c['json']! as String),
    );
    check(decision == c['expect'], 'idempotency / ${c['name']}: got $decision');
  }
  for (final raw in digests['manifestBytes']! as List<Object?>) {
    final c = _map(raw);
    final from = c['sha256From'] as Map<String, Object?>?;
    final declared = from == null
        ? c['sha256']! as String
        : pointerGet(
                readJson(from['file']! as String),
                from['pointer']! as String,
              )!
              as String;
    final outcome = verifyStoredBytes(read(c['file']! as String), declared);
    check(
      outcome == c['expect'],
      'manifest bytes / ${c['name']}: got $outcome',
    );
  }
  for (final raw in digests['sealedInventory']! as List<Object?>) {
    final c = _map(raw);
    final found = checkSealedInventory(
      _map(c['seal']),
      _map(readJson(c['declaration']! as String)),
    );
    final expect = _map(c['expect']);
    final ok = expect['valid'] == true
        ? found == null
        : found != null &&
              found.code == expect['code'] &&
              found.path == expect['path'];
    check(ok, 'sealed inventory / ${c['name']}: got $found');
  }
  try {
    registry.validateValue('http.nope.v1', const {});
    check(false, 'unknown contract must fail closed');
  } on ArgumentError {
    check(true, 'unknown contract fails closed');
  }

  if (args.isNotEmpty) {
    File(args.first).writeAsStringSync(
      '${const JsonEncoder.withIndent(' ').convert(report)}\n',
    );
  }
  if (failures.isNotEmpty) {
    stderr.writeln(failures.join('\n'));
    stderr.writeln(
      '${failures.length} of $cases Dart conformance checks failed',
    );
    exitCode = 1;
    return;
  }
  stdout.writeln(
    '$cases Dart conformance checks passed (${report.length} fixture cases)',
  );
}
