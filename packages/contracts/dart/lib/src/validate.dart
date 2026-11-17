import 'dart:convert';

import 'package:json_schema/json_schema.dart';

import 'canonical.dart';
import 'rules.dart';

class ContractError {
  const ContractError(this.path, this.message);
  final String path;
  final String message;
  @override
  String toString() => '$path: $message';
}

class ValidationResult {
  const ValidationResult.ok(this.value)
    : valid = true,
      code = null,
      errors = const [];
  ValidationResult.fail(String this.code, [String path = '', String? message])
    : valid = false,
      value = null,
      errors = [ContractError(path, message ?? code)];
  const ValidationResult.schema(this.errors)
    : valid = false,
      code = 'schema_violation',
      value = null;
  final bool valid;
  final String? code;
  final List<ContractError> errors;
  final Object? value;
  @override
  String toString() => valid ? 'valid' : '$code $errors';
}

class ContractViolation implements Exception {
  ContractViolation(this.contract, this.result);
  final String contract;
  final ValidationResult result;
  @override
  String toString() => '$contract: ${result.code}';
}

class _Entry {
  _Entry(this.json, this.schema, this.rules);
  final Map<String, Object?> json;
  final JsonSchema schema;
  final List<Rule> rules;
}

/// Validators built from the current catalog (api/catalog.v8.json, an exact
/// superset of the immutable catalog.v7.json, catalog.v6.json, catalog.v5.json, catalog.v4.json, catalog.v3.json, catalog.v2.json and catalog.v1.json) and the
/// schema documents it lists.
/// [readSchema] receives catalog-relative paths (for example `http/x.v1.schema.json`).
class ContractRegistry {
  ContractRegistry._(this._entries, this._maxDepth);

  factory ContractRegistry.load(
    Map<String, Object?> catalog,
    Map<String, Object?> Function(String path) readSchema,
  ) {
    final contracts = catalog['contracts']! as Map<String, Object?>;
    final paths = [
      catalog['common']! as String,
      for (final c in contracts.values)
        (c! as Map<String, Object?>)['schema']! as String,
    ];
    final byId = <String, Map<String, Object?>>{};
    final byPath = <String, Map<String, Object?>>{};
    for (final path in paths) {
      final doc = readSchema(path);
      byId[doc[r'$id']! as String] = doc;
      byPath[path] = doc;
    }
    final provider = RefProvider.sync((String ref) {
      final found = byId[ref.split('#').first];
      if (found == null)
        throw ArgumentError('Unresolvable schema reference $ref');
      return found;
    });
    final entries = <String, _Entry>{};
    for (final MapEntry(:key, :value) in contracts.entries) {
      final json = value! as Map<String, Object?>;
      final ruleNames = (json['rules']! as List<Object?>).cast<String>();
      final unknown = ruleNames.where((r) => !rules.containsKey(r));
      if (unknown.isNotEmpty)
        throw ArgumentError('Unknown rules $unknown for $key');
      final schema = JsonSchema.create(
        byPath[json['schema']]!,
        schemaVersion: SchemaVersion.draft2020_12,
        refProvider: provider,
      );
      entries[key] = _Entry(json, schema, [
        for (final r in ruleNames) rules[r]!,
      ]);
    }
    return ContractRegistry._(entries, catalog['maxDepth']! as int);
  }

  final Map<String, _Entry> _entries;
  final int _maxDepth;

  List<String> get contractIds => _entries.keys.toList()..sort();

  _Entry _entry(String contract) =>
      _entries[contract] ?? (throw ArgumentError('Unknown contract $contract'));

  bool _wellFormed(Object? value, int depth) {
    if (value == null || value is bool || value is int) return true;
    if (value is double) return value.isFinite;
    if (value is String) return isWellFormed(value);
    if (depth >= _maxDepth) return false;
    if (value is List<Object?>)
      return value.every((x) => _wellFormed(x, depth + 1));
    if (value is Map<String, Object?>) {
      return value.entries.every(
        (e) => isWellFormed(e.key) && _wellFormed(e.value, depth + 1),
      );
    }
    return false;
  }

  static bool _accepted(Object? found, List<Object?> accepted) => accepted.any(
    (a) =>
        (a is String && found is String && a == found) ||
        (a is num && found is num && a == found),
  );

  ValidationResult validateValue(String contract, Object? value) {
    final entry = _entry(contract);
    if (!_wellFormed(value, 0)) return ValidationResult.fail('malformed_json');
    final version = entry.json['version'];
    if (version is Map<String, Object?> &&
        version['field'] is String &&
        value is Map<String, Object?>) {
      final field = version['field']! as String;
      if (value.containsKey(field) &&
          !_accepted(value[field], version['accepted']! as List<Object?>)) {
        return ValidationResult.fail('unsupported_version', '/$field');
      }
    }
    final report = entry.schema.validate(value);
    if (!report.isValid) {
      return ValidationResult.schema([
        for (final e in report.errors) ContractError(e.instancePath, e.message),
      ]);
    }
    for (final rule in entry.rules) {
      final violation = rule(value! as Map<String, Object?>);
      if (violation != null)
        return ValidationResult.fail(violation.code, violation.path);
    }
    return ValidationResult.ok(value);
  }

  ValidationResult validateBytes(String contract, List<int> bytes) {
    final entry = _entry(contract);
    if (bytes.length > (entry.json['maxBytes']! as int)) {
      return ValidationResult.fail('document_too_large');
    }
    if (bytes.length >= 3 &&
        bytes[0] == 0xef &&
        bytes[1] == 0xbb &&
        bytes[2] == 0xbf) {
      return ValidationResult.fail('malformed_json', '', 'byte order mark');
    }
    final Object? value;
    try {
      value = decodeStrict(utf8.decode(bytes));
    } on FormatException {
      return ValidationResult.fail('malformed_json');
    }
    return validateValue(contract, value);
  }

  T parse<T>(String contract, Object? value) {
    final result = validateValue(contract, value);
    if (!result.valid) throw ContractViolation(contract, result);
    return result.value as T;
  }
}
