// Portable strict JSON-Schema subset interpreter (port of conformance/python/strict_schema.py).
// Fails closed on any keyword outside `supported`, non-local $ref, unanchored pattern or unknown type.
// validate() returns the sorted "<instance pointer>:<keyword>" violations, identical in every language.
import 'dart:convert';
import 'dart:typed_data';

class SchemaUnsupported implements Exception {
  SchemaUnsupported(this.message);
  final String message;
  @override
  String toString() => 'SchemaUnsupported: $message';
}

class MalformedJson implements Exception {}

const supported = {
  r'$schema', r'$id', r'$defs', r'$ref', 'title', 'description', 'type', //
  'const', 'enum', 'required', 'properties', 'additionalProperties',
  'propertyNames', 'minProperties', 'maxProperties', 'items', 'minItems',
  'maxItems', 'pattern', 'minLength', 'maxLength', 'minimum', 'maximum',
  'anyOf', 'allOf', 'if', 'then',
};
const types = {
  'object',
  'array',
  'string',
  'integer',
  'number',
  'boolean',
  'null',
};

/// Strict parse: invalid UTF-8, duplicate keys, NaN/Infinity and numbers overflowing a double are malformed.
Object? parseJson(Uint8List bytes) {
  final String text;
  try {
    text = utf8.decode(bytes);
  } on FormatException {
    throw MalformedJson();
  }
  final stack = <Set<String>?>[];
  var i = 0;
  while (i < text.length) {
    final c = text[i];
    if (c == '"') {
      var j = i + 1;
      while (j < text.length && text[j] != '"') {
        j += text[j] == r'\' ? 2 : 1;
      }
      final tok = text.substring(i, j + 1 > text.length ? text.length : j + 1);
      i = j + 1;
      var k = i;
      while (k < text.length && ' \t\n\r'.contains(text[k])) {
        k++;
      }
      if (k < text.length && text[k] == ':' && stack.isNotEmpty) {
        final top = stack.last;
        if (top != null) {
          final Object? key;
          try {
            key = jsonDecode(tok);
          } on FormatException {
            throw MalformedJson();
          }
          if (key is! String || !top.add(key)) throw MalformedJson();
        }
      }
      continue;
    }
    if (c == '{') {
      stack.add(<String>{});
    } else if (c == '[') {
      stack.add(null);
    } else if (c == '}' || c == ']') {
      if (stack.isNotEmpty) stack.removeLast();
    } else if (c == '-' || (c.codeUnitAt(0) >= 48 && c.codeUnitAt(0) <= 57)) {
      var j = i;
      while (j < text.length && '0123456789eE+-.'.contains(text[j])) {
        j++;
      }
      final n = double.tryParse(text.substring(i, j));
      if (n != null && !n.isFinite) throw MalformedJson();
      i = j;
      continue;
    }
    i++;
  }
  try {
    return jsonDecode(text);
  } on FormatException {
    throw MalformedJson();
  }
}

final _safe = RegExp(r'^[A-Za-z0-9._-]$');
String token(Object key) {
  if (key is int) return '$key';
  final out = StringBuffer();
  for (final b in utf8.encode(key as String)) {
    final ch = String.fromCharCode(b);
    out.write(
      b < 0x80 && _safe.hasMatch(ch)
          ? ch
          : '%${b.toRadixString(16).toUpperCase().padLeft(2, '0')}',
    );
  }
  return out.toString();
}

bool _isType(Object? v, String t) {
  switch (t) {
    case 'null':
      return v == null;
    case 'boolean':
      return v is bool;
    case 'string':
      return v is String;
    case 'array':
      return v is List;
    case 'object':
      return v is Map;
    case 'number':
      return v is num;
    case 'integer':
      return v is int ||
          (v is double && v.isFinite && v == v.truncateToDouble());
  }
  throw SchemaUnsupported(t);
}

bool jsonEqual(Object? a, Object? b) {
  if (a is bool || b is bool) return a is bool && b is bool && a == b;
  if (a is num && b is num) return a == b;
  if (a == null || b == null) return a == null && b == null;
  if (a is String || b is String) return a is String && b is String && a == b;
  if (a is List && b is List) {
    if (a.length != b.length) return false;
    for (var i = 0; i < a.length; i++) {
      if (!jsonEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (a is Map && b is Map) {
    if (a.length != b.length) return false;
    for (final k in a.keys) {
      if (!b.containsKey(k) || !jsonEqual(a[k], b[k])) return false;
    }
    return true;
  }
  return false;
}

bool _isCount(Object? v) => v is int && v >= 0;

class Schema {
  Schema(this.root) {
    _check(root, '#');
  }

  final Map<String, dynamic> root;
  final _patterns = <String, RegExp>{};

  void _check(Object? s, String where) {
    Never fail(String m) => throw SchemaUnsupported('$where: $m');
    if (s is! Map<String, dynamic>) fail('schema must be an object');
    for (final k in s.keys) {
      if (!supported.contains(k)) fail('unsupported keyword $k');
      if (k == r'$defs' && where != '#') fail(r'$defs only at the root');
    }
    if (s.containsKey(r'$defs')) {
      for (final e in (s[r'$defs'] as Map<String, dynamic>).entries) {
        _check(e.value, '$where/\$defs/${e.key}');
      }
    }
    if (s.containsKey(r'$ref')) {
      final r = s[r'$ref'];
      final defs = root[r'$defs'];
      if (r is! String ||
          !r.startsWith(r'#/$defs/') ||
          defs is! Map ||
          !defs.containsKey(r.substring(8))) {
        fail(r'unresolvable or non-local $ref');
      }
    }
    if (s.containsKey('type')) {
      final t = s['type'];
      final ts = t is List ? t : [t];
      if (ts.isEmpty || ts.any((x) => !types.contains(x))) fail('type');
    }
    if (s.containsKey('enum') && !(s['enum'] is List && s['enum'].isNotEmpty)) {
      fail('enum must be a non-empty array');
    }
    if (s.containsKey('required') &&
        !(s['required'] is List &&
            (s['required'] as List).every((x) => x is String))) {
      fail('required must be a string array');
    }
    if (s.containsKey('pattern')) {
      final p = s['pattern'];
      if (p is! String ||
          !p.startsWith('^') ||
          !p.endsWith(r'$') ||
          p.codeUnits.any((u) => u > 0x7f)) {
        fail(r'pattern must be an anchored ASCII ^...$ expression');
      }
      _patterns[p] = RegExp(p);
    }
    for (final k in [
      'minProperties',
      'maxProperties',
      'minItems',
      'maxItems',
      'minLength',
      'maxLength',
    ]) {
      if (s.containsKey(k) && !_isCount(s[k])) {
        fail('$k must be a non-negative integer');
      }
    }
    for (final k in ['minimum', 'maximum']) {
      if (s.containsKey(k) && s[k] is! num) fail('$k must be a number');
    }
    if (s.containsKey('properties')) {
      final props = s['properties'];
      if (props is! Map<String, dynamic>) fail('properties must be an object');
      for (final e in props.entries) {
        _check(e.value, '$where/properties/${e.key}');
      }
    }
    if (s.containsKey('additionalProperties') &&
        s['additionalProperties'] != false) {
      _check(s['additionalProperties'], '$where/additionalProperties');
    }
    for (final k in ['propertyNames', 'items', 'if', 'then']) {
      if (s.containsKey(k)) _check(s[k], '$where/$k');
    }
    if (s.containsKey('then') && !s.containsKey('if')) fail('then without if');
    for (final k in ['anyOf', 'allOf']) {
      if (s.containsKey(k)) {
        final list = s[k];
        if (list is! List || list.isEmpty) fail('$k must be a non-empty array');
        for (var i = 0; i < list.length; i++) {
          _check(list[i], '$where/$k/$i');
        }
      }
    }
  }

  List<String> validate(Object? instance) {
    final out = <String>{};
    _v(root, instance, '', out);
    return out.toList()..sort();
  }

  bool _valid(Map<String, dynamic> s, Object? v) {
    final out = <String>{};
    _v(s, v, '', out);
    return out.isEmpty;
  }

  void _v(Map<String, dynamic> s, Object? v, String path, Set<String> out) {
    void err(String kw) => out.add('$path:$kw');
    if (s.containsKey(r'$ref')) {
      final name = (s[r'$ref'] as String).substring(8);
      _v(root[r'$defs'][name] as Map<String, dynamic>, v, path, out);
    }
    if (s.containsKey('type')) {
      final t = s['type'];
      final ts = t is List ? t : [t];
      if (!ts.any((x) => _isType(v, x as String))) err('type');
    }
    if (s.containsKey('const') && !jsonEqual(v, s['const'])) err('const');
    if (s.containsKey('enum') &&
        !(s['enum'] as List).any((e) => jsonEqual(v, e))) {
      err('enum');
    }
    if (v is String) {
      final n = v.runes.length;
      if (s.containsKey('minLength') && n < (s['minLength'] as int)) {
        err('minLength');
      }
      if (s.containsKey('maxLength') && n > (s['maxLength'] as int)) {
        err('maxLength');
      }
      if (s.containsKey('pattern')) {
        final m = _patterns[s['pattern']]!.firstMatch(v);
        if (m == null || m.start != 0 || m.end != v.length) err('pattern');
      }
    }
    if (v is num) {
      if (s.containsKey('minimum') && v < (s['minimum'] as num)) err('minimum');
      if (s.containsKey('maximum') && v > (s['maximum'] as num)) err('maximum');
    }
    if (v is List) {
      if (s.containsKey('minItems') && v.length < (s['minItems'] as int)) {
        err('minItems');
      }
      if (s.containsKey('maxItems') && v.length > (s['maxItems'] as int)) {
        err('maxItems');
      }
      if (s.containsKey('items')) {
        for (var i = 0; i < v.length; i++) {
          _v(s['items'] as Map<String, dynamic>, v[i], '$path/$i', out);
        }
      }
    }
    if (v is Map) {
      if (s.containsKey('required') &&
          (s['required'] as List).any((k) => !v.containsKey(k))) {
        err('required');
      }
      if (s.containsKey('minProperties') &&
          v.length < (s['minProperties'] as int)) {
        err('minProperties');
      }
      if (s.containsKey('maxProperties') &&
          v.length > (s['maxProperties'] as int)) {
        err('maxProperties');
      }
      final props = (s['properties'] as Map<String, dynamic>?) ?? const {};
      for (final k in v.keys) {
        if (props.containsKey(k)) {
          _v(props[k] as Map<String, dynamic>, v[k], '$path/${token(k)}', out);
        }
      }
      if (s.containsKey('additionalProperties')) {
        final extra = [
          for (final k in v.keys)
            if (!props.containsKey(k)) k,
        ];
        final ap = s['additionalProperties'];
        if (ap == false) {
          if (extra.isNotEmpty) err('additionalProperties');
        } else {
          for (final k in extra) {
            _v(ap as Map<String, dynamic>, v[k], '$path/${token(k)}', out);
          }
        }
      }
      if (s.containsKey('propertyNames')) {
        for (final k in v.keys) {
          _v(s['propertyNames'] as Map<String, dynamic>, k, path, out);
        }
      }
    }
    if (s.containsKey('allOf')) {
      for (final sub in s['allOf'] as List) {
        _v(sub as Map<String, dynamic>, v, path, out);
      }
    }
    if (s.containsKey('anyOf') &&
        !(s['anyOf'] as List).any(
          (sub) => _valid(sub as Map<String, dynamic>, v),
        )) {
      err('anyOf');
    }
    if (s.containsKey('if') &&
        s.containsKey('then') &&
        _valid(s['if'] as Map<String, dynamic>, v)) {
      _v(s['then'] as Map<String, dynamic>, v, path, out);
    }
  }
}

final _crcTable = List<int>.generate(256, (n) {
  var c = n;
  for (var k = 0; k < 8; k++) {
    c = (c & 1) != 0 ? 0xEDB88320 ^ (c >> 1) : c >> 1;
  }
  return c;
});

/// CRC-32 (IEEE 802.3, as zlib.crc32 and the MCAP specification).
int crc32(Uint8List data, [int start = 0, int? end]) {
  var c = 0xFFFFFFFF;
  for (var i = start; i < (end ?? data.length); i++) {
    c = _crcTable[(c ^ data[i]) & 0xFF] ^ (c >> 8);
  }
  return c ^ 0xFFFFFFFF;
}
