import 'dart:convert';

import 'package:crypto/crypto.dart';

const maxSafeInteger = 9007199254740991;

class NoncanonicalValueError extends ArgumentError {
  NoncanonicalValueError(String message) : super(message);
  final String code = 'noncanonical_value';
}

class MalformedJsonError extends FormatException {
  const MalformedJsonError(super.message);
  String get code => 'malformed_json';
}

/// True when [value] has no unpaired UTF-16 surrogate.
bool isWellFormed(String value) {
  final units = value.codeUnits;
  for (var i = 0; i < units.length; i++) {
    final unit = units[i];
    if (unit >= 0xd800 && unit <= 0xdbff) {
      if (i + 1 >= units.length ||
          units[i + 1] < 0xdc00 ||
          units[i + 1] > 0xdfff) {
        return false;
      }
      i++;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

const _short = {
  0x22: r'\"',
  0x5c: r'\\',
  0x08: r'\b',
  0x0c: r'\f',
  0x0a: r'\n',
  0x0d: r'\r',
  0x09: r'\t',
};

String _string(String value) {
  if (!isWellFormed(value)) {
    throw NoncanonicalValueError('String contains a lone surrogate');
  }
  final out = StringBuffer('"');
  for (final rune in value.runes) {
    final short = _short[rune];
    if (short != null) {
      out.write(short);
    } else if (rune < 0x20) {
      out.write('\\u${rune.toRadixString(16).padLeft(4, '0')}');
    } else {
      out.writeCharCode(rune);
    }
  }
  out.write('"');
  return out.toString();
}

/// sa-cjson-v1 encoding (see packages/contracts/README.md).
String canonicalJson(Object? value) {
  if (value == null) return 'null';
  if (value is bool) return value ? 'true' : 'false';
  if (value is double) {
    if (!value.isFinite || value != value.truncateToDouble()) {
      throw NoncanonicalValueError('Only safe integers are canonical');
    }
    if (value.abs() > maxSafeInteger) {
      throw NoncanonicalValueError('Integer outside the safe range');
    }
    return canonicalJson(value.toInt());
  }
  if (value is int) {
    if (value > maxSafeInteger || value < -maxSafeInteger) {
      throw NoncanonicalValueError('Integer outside the safe range');
    }
    return value.toString();
  }
  if (value is String) return _string(value);
  if (value is List<Object?>) return '[${value.map(canonicalJson).join(',')}]';
  if (value is Map<String, Object?>) {
    final keys = value.keys.toList()..sort(); // UTF-16 code unit order
    return '{${keys.map((k) => '${_string(k)}:${canonicalJson(value[k])}').join(',')}}';
  }
  throw NoncanonicalValueError('Unsupported value type ${value.runtimeType}');
}

Object? decodeStrict(String text) {
  try {
    return jsonDecode(text);
  } on FormatException catch (error) {
    throw MalformedJsonError(error.message);
  }
}

String canonicalJsonText(String text) => canonicalJson(decodeStrict(text));

String sha256Hex(List<int> bytes) => sha256.convert(bytes).toString();

String requestSha256(Object? value) =>
    sha256Hex(utf8.encode(canonicalJson(value)));

/// 'replay' or 'idempotency_conflict'.
String classifyReplay(String storedSha256, Object? request) =>
    requestSha256(request) == storedSha256 ? 'replay' : 'idempotency_conflict';

/// Manifests are hashed over exact stored bytes: 'match' or 'digest_mismatch'.
String verifyStoredBytes(List<int> bytes, String declaredSha256) =>
    sha256Hex(bytes) == declaredSha256 ? 'match' : 'digest_mismatch';
