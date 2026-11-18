import "dart:async";
import "dart:convert";
import "dart:io";

import "package:crypto/crypto.dart";
import "package:stateaction_contracts/stateaction_contracts.dart";

/// The account/backend a call is made for. Journals are bound to the owner and
/// backend origin frozen at registration; a different current user or origin
/// can never read, advance or rebind them.
class OwnerContext {
  const OwnerContext(this.ownerUserId, this.backendOrigin);
  final String ownerUserId;
  final String backendOrigin;
}

class OwnerMismatch implements Exception {
  const OwnerMismatch();
  @override
  String toString() => "OwnerMismatch";
}

class JournalCorrupt implements Exception {
  const JournalCorrupt(this.reason);
  final String reason;
  @override
  String toString() => "JournalCorrupt($reason)";
}

/// Content for an already-sealed identity changed. Sticky: the journal never
/// advances again; the original files are left untouched.
class SourceConflict implements Exception {
  const SourceConflict(this.subject);
  final String subject;
  @override
  String toString() => "SourceConflict($subject)";
}

class IllegalTransition implements Exception {
  const IllegalTransition(this.from, this.to);
  final String from;
  final String to;
  @override
  String toString() => "IllegalTransition($from -> $to)";
}

/// Linear progress states. Anything else is an annotating event.
const sourceStates = [
  "pending_registration",
  "registered",
  "closed",
  "hashed",
  "manifest_built",
  "seal_ready",
];

Object? _deepCopy(Object? v) => jsonDecode(jsonEncode(v));

Object? _freeze(Object? v) {
  if (v is Map) {
    return Map<String, Object?>.unmodifiable({
      for (final e in v.entries) e.key as String: _freeze(e.value),
    });
  }
  if (v is List) return List<Object?>.unmodifiable(v.map(_freeze));
  return v;
}

String _canon(Object? v) => canonicalJson(v);

class _Entry {
  _Entry(this.seq, this.kind, this.name, this.data, this.line, this.hash);
  final int seq;
  final String kind;
  final String name;

  /// Deeply unmodifiable.
  final Map<String, Object?> data;

  /// The exact persisted line (no newline); the chain hashes these bytes.
  final String line;
  final String hash;
}

class _Parsed {
  _Parsed(this.entries, this.keepLength, this.torn);
  final List<_Entry> entries;
  final int keepLength;
  final bool torn;
}

/// Append-only, hash-chained, fsynced JSONL journal for one recording.
///
/// Line i = JSON {seq, prev, kind, name, data}; `prev` is the SHA-256 of the
/// persisted bytes of line i-1 (zeros for the first). A torn final line is
/// ignored on load (the append never completed); damage anywhere else fails
/// closed. Nothing is ever rewritten, and the journal never deletes or alters
/// a source file.
///
/// Every state-changing call is one transaction on a per-path queue:
/// validation, state check and append happen under the same turn, so
/// concurrent callers (even through separate instances) serialize. Inputs are
/// deep-copied when called; every value handed out is deeply unmodifiable.
class SourceJournal {
  SourceJournal._(this.file, this._entries, this._persisted);

  final File file;
  List<_Entry> _entries;
  int _persisted;

  static final Map<String, Future<void>> _queues = {};
  static final String _zero = "0" * 64;

  Future<T> _tx<T>(Future<T> Function() body) => _txPath(file, () async {
    await _sync();
    return body();
  });

  static Future<T> _txPath<T>(File f, Future<T> Function() body) {
    final key = f.absolute.path;
    final prior = _queues[key] ?? Future<void>.value();
    final c = Completer<T>();
    final next = prior.then((_) async {
      try {
        c.complete(await body());
      } catch (e, st) {
        c.completeError(e, st);
      }
    });
    _queues[key] = next;
    next.whenComplete(() {
      if (identical(_queues[key], next)) _queues.remove(key);
    });
    return c.future;
  }

  static Future<SourceJournal> create(
    File file, {
    required OwnerContext frozen,
    required String clientRecordingId,
    required String sessionDirName,
    required Map<String, Object?> createRequest,
    required String captureConfigSha256,
  }) {
    final request = _deepCopy(createRequest)! as Map<String, Object?>;
    return _txPath(file, () async {
      if (await file.exists()) {
        final existing = await _openNow(file);
        existing._checkOwner(frozen);
        final first = existing._entries.first.data;
        if (first["clientRecordingId"] != clientRecordingId) {
          throw const SourceConflict("journal/clientRecordingId");
        }
        if (first["sessionDir"] != sessionDirName) {
          throw const SourceConflict("journal/sessionDir");
        }
        if (first["captureConfigSha256"] != captureConfigSha256) {
          throw const SourceConflict("journal/captureConfigSha256");
        }
        if (_canon(first["createRequest"]) != _canon(request)) {
          throw const SourceConflict("journal/createRequest");
        }
        return existing;
      }
      await file.parent.create(recursive: true);
      final j = SourceJournal._(file, [], 0);
      await j._appendNow("state", "pending_registration", {
        "owner": frozen.ownerUserId,
        "backendOrigin": frozen.backendOrigin,
        "clientRecordingId": clientRecordingId,
        "sessionDir": sessionDirName,
        "createRequest": request,
        "captureConfigSha256": captureConfigSha256,
      });
      return j;
    });
  }

  static Future<SourceJournal> open(File file) =>
      _txPath(file, () => _openNow(file));

  static Future<SourceJournal> _openNow(File file) async {
    final parsed = _parse(await file.readAsString());
    await _truncateTorn(file, parsed);
    return SourceJournal._(file, parsed.entries, parsed.keepLength);
  }

  static _Parsed _parse(String text) {
    final lines = const LineSplitter().convert(text);
    final entries = <_Entry>[];
    var prev = _zero;
    var torn = false;
    for (var i = 0; i < lines.length; i++) {
      final isLast = i == lines.length - 1;
      Object? decoded;
      try {
        decoded = jsonDecode(lines[i]);
      } on FormatException {
        if (isLast && !text.endsWith("\n")) {
          torn = true;
          break;
        }
        throw JournalCorrupt("line $i unreadable");
      }
      if (decoded is! Map<String, Object?>) {
        throw JournalCorrupt("line $i not an object");
      }
      if (decoded["seq"] != i || decoded["prev"] != prev) {
        throw JournalCorrupt("line $i breaks the chain");
      }
      if (isLast && !text.endsWith("\n")) {
        torn = true; // complete JSON but unflushed newline
        break;
      }
      final hash = sha256.convert(utf8.encode(lines[i])).toString();
      entries.add(
        _Entry(
          i,
          decoded["kind"]! as String,
          decoded["name"]! as String,
          _freeze(decoded["data"])! as Map<String, Object?>,
          lines[i],
          hash,
        ),
      );
      prev = hash;
    }
    if (entries.isEmpty) throw const JournalCorrupt("empty journal");
    final keep = torn
        ? utf8.encode(text.substring(0, text.lastIndexOf("\n") + 1)).length
        : utf8.encode(text).length;
    return _Parsed(entries, keep, torn);
  }

  static Future<void> _truncateTorn(File file, _Parsed parsed) async {
    if (!parsed.torn) return;
    // Drop only the torn, never-acknowledged tail so the next append starts
    // on a fresh line.
    final raf = await file.open(mode: FileMode.append);
    try {
      await raf.truncate(parsed.keepLength);
      await raf.flush();
    } finally {
      await raf.close();
    }
  }

  /// Picks up appends/tears made outside this instance (another instance for
  /// the same file, or a failed earlier append).
  Future<void> _sync() async {
    if (await file.length() == _persisted) return;
    final parsed = _parse(await file.readAsString());
    await _truncateTorn(file, parsed);
    _entries = parsed.entries;
    _persisted = parsed.keepLength;
  }

  Map<String, Object?> get _first => _entries.first.data;

  String get owner => _first["owner"]! as String;
  String get backendOrigin => _first["backendOrigin"]! as String;
  String get clientRecordingId => _first["clientRecordingId"]! as String;
  String get sessionDirName => _first["sessionDir"]! as String;
  String get captureConfigSha256 => _first["captureConfigSha256"]! as String;
  Map<String, Object?> get createRequest =>
      _first["createRequest"]! as Map<String, Object?>;

  bool visibleTo(OwnerContext ctx) =>
      ctx.ownerUserId == owner && ctx.backendOrigin == backendOrigin;

  void _checkOwner(OwnerContext ctx) {
    if (!visibleTo(ctx)) throw const OwnerMismatch();
  }

  bool get hasConflict => _entries.any((e) => e.name == "conflict");

  String get state {
    var s = sourceStates.first;
    for (final e in _entries) {
      if (e.kind == "state") s = e.name;
    }
    return s;
  }

  /// Data of the (latest) progress record for [name], or null (unmodifiable).
  Map<String, Object?>? stateData(String name) {
    for (final e in _entries.reversed) {
      if (e.kind == "state" && e.name == name) return e.data;
    }
    return null;
  }

  /// Recorded per-file hash facts, keyed by fileId (unmodifiable).
  Map<String, Map<String, Object?>> get hashedFiles => Map.unmodifiable({
    for (final e in _entries)
      if (e.name == "file_hashed") e.data["fileId"]! as String: e.data,
  });

  int get entryCount => _entries.length;

  Future<void> _appendNow(
    String kind,
    String name,
    Map<String, Object?> data,
  ) async {
    final prev = _entries.isEmpty ? _zero : _entries.last.hash;
    final line = jsonEncode({
      "seq": _entries.length,
      "prev": prev,
      "kind": kind,
      "name": name,
      "data": data,
    });
    final raf = await file.open(mode: FileMode.append);
    try {
      await raf.writeString("$line\n");
      await raf.flush();
    } finally {
      await raf.close();
    }
    _persisted += utf8.encode(line).length + 1;
    _entries = [
      ..._entries,
      _Entry(
        _entries.length,
        kind,
        name,
        _freeze(jsonDecode(line)["data"])! as Map<String, Object?>,
        line,
        sha256.convert(utf8.encode(line)).toString(),
      ),
    ];
  }

  Future<SourceConflict> _conflictNow(
    String subject,
    Object? recorded,
    Object? observed,
  ) async {
    if (!hasConflict) {
      await _appendNow("event", "conflict", {
        "subject": subject,
        "recorded": recorded,
        "observed": observed,
      });
    }
    return SourceConflict(subject);
  }

  /// Advances exactly one step (or repeats the current state with identical
  /// data, which is a no-op). A replay with different data records a sticky
  /// conflict and throws.
  Future<void> advance(OwnerContext ctx, String to, Map<String, Object?> data) {
    final snap = _deepCopy(data)! as Map<String, Object?>;
    return _tx(() async {
      _checkOwner(ctx);
      if (hasConflict) throw const SourceConflict("journal");
      final from = state;
      final ti = sourceStates.indexOf(to);
      final fi = sourceStates.indexOf(from);
      if (ti <= fi) {
        final recorded = stateData(to);
        if (_canon(recorded) == _canon(snap)) return;
        throw await _conflictNow("state/$to", recorded, snap);
      }
      if (ti != fi + 1) throw IllegalTransition(from, to);
      await _appendNow("state", to, snap);
    });
  }

  /// Records a file's size/digest the first time; an identical repeat is a
  /// no-op; anything else records a sticky conflict and throws.
  Future<void> recordFileHashed(OwnerContext ctx, Map<String, Object?> fact) {
    final snap = _deepCopy(fact)! as Map<String, Object?>;
    return _tx(() async {
      _checkOwner(ctx);
      if (hasConflict) throw const SourceConflict("journal");
      final id = snap["fileId"]! as String;
      final prior = hashedFiles[id];
      if (prior == null) return _appendNow("event", "file_hashed", snap);
      const keys = ["sha256", "sizeBytes", "relativePath", "role", "required"];
      Map<String, Object?> pick(Map<String, Object?> m) => {
        for (final k in keys) k: m[k],
      };
      if (_canon(pick(prior)) == _canon(pick(snap))) return;
      throw await _conflictNow("file/$id", pick(prior), pick(snap));
    });
  }

  /// Server file reservations keyed by the local (planning) file id
  /// (unmodifiable). A reservation binds one server-chosen file id to the
  /// exact local role/size/digest it was requested for.
  Map<String, Map<String, Object?>> get reservations => Map.unmodifiable({
    for (final e in _entries)
      if (e.name == "file_reserved") e.data["localFileId"]! as String: e.data,
  });

  /// Records the server file id returned for a reservation the first time; an
  /// identical repeat is a no-op. A different id, role, size, digest or
  /// client upload id for the same local file, or one server id reused for
  /// two local files, records a sticky conflict and throws.
  Future<void> recordReservation(OwnerContext ctx, Map<String, Object?> fact) {
    final snap = _deepCopy(fact)! as Map<String, Object?>;
    return _tx(() async {
      _checkOwner(ctx);
      if (hasConflict) throw const SourceConflict("journal");
      final local = snap["localFileId"]! as String;
      const keys = [
        "serverFileId",
        "clientUploadId",
        "role",
        "sizeBytes",
        "sha256",
      ];
      Map<String, Object?> pick(Map<String, Object?> m) => {
        for (final k in keys) k: m[k],
      };
      final all = reservations;
      final prior = all[local];
      if (prior != null) {
        if (_canon(pick(prior)) == _canon(pick(snap))) return;
        throw await _conflictNow("reservation/$local", pick(prior), pick(snap));
      }
      for (final other in all.entries) {
        if (other.value["serverFileId"] == snap["serverFileId"]) {
          throw await _conflictNow(
            "reservation/serverFileId",
            pick(other.value),
            pick(snap),
          );
        }
      }
      return _appendNow("event", "file_reserved", snap);
    });
  }

  /// Durable sticky conflict for a frozen fact the caller found to differ.
  /// Returns the exception to throw.
  Future<SourceConflict> recordConflict(
    OwnerContext ctx,
    String subject, {
    Object? recorded,
    Object? observed,
  }) {
    final r = _deepCopy(recorded);
    final o = _deepCopy(observed);
    return _tx(() async {
      _checkOwner(ctx);
      return _conflictNow(subject, r, o);
    });
  }

  /// Annotates why a source is not upload-ready. Never advances state.
  Future<void> recordBlocked(OwnerContext ctx, String reason) {
    return _tx(() async {
      _checkOwner(ctx);
      await _appendNow("event", "blocked", {"reason": reason});
    });
  }

  String? get lastBlockedReason {
    for (final e in _entries.reversed) {
      if (e.name == "blocked") return e.data["reason"] as String?;
    }
    return null;
  }
}
