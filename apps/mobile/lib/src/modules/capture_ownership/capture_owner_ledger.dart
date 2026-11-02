import "dart:async";
import "dart:convert";
import "dart:io";

import "package:path/path.dart" as p;

/// Thrown when a write would change an existing owner. Owners are immutable.
class OwnerConflict implements Exception {
  const OwnerConflict(this.subject);
  final String subject;
  @override
  String toString() => "OwnerConflict($subject)";
}

/// Classification of a capture or upload source.
sealed class CaptureOwnership {
  const CaptureOwnership();
}

class OwnedBy extends CaptureOwnership {
  const OwnedBy(this.authUserId, {required this.provenance});
  final String authUserId;

  /// `capture_start` (stamped before Start) or `legacy_recovery` (explicitly
  /// claimed ownerless data).
  final String provenance;
}

/// No owner record: data recorded before ownership, by the auth-free build,
/// by a natively driven start, or after a crash between Start and binding.
/// Never auto-adopted or deleted; only explicit recovery binds it.
class Ownerless extends CaptureOwnership {
  const Ownerless();
}

/// A capture intent persisted before Start that never got its directory bound
/// (crash window). [probableOwner] is a recovery hint only.
class PendingIntent {
  const PendingIntent(this.intentId, this.probableOwner, this.createdAt);
  final String intentId;
  final String probableOwner;
  final DateTime createdAt;
}

/// App-private, write-ahead owner journal for captures and upload sources.
///
/// Stored as one JSON document outside the capture directories, replaced
/// atomically (write temp, flush, rename). Records are append/bind-only: no
/// API rewrites an owner, and logout/account switch never touch this file.
/// Losing the file fails closed: every capture becomes [Ownerless] and needs
/// explicit recovery rather than being adopted.
class CaptureOwnerLedger {
  CaptureOwnerLedger(this.file, {DateTime Function()? clock})
    : _clock = clock ?? DateTime.now;

  final File file;
  final DateTime Function() _clock;

  static const int schemaVersion = 1;

  final Map<String, Map<String, Object?>> _intents = {};
  final Map<String, Map<String, Object?>> _sessions = {};
  final Map<String, Map<String, Object?>> _uploads = {};
  bool _loaded = false;
  Future<void> _tail = Future<void>.value();
  int _intentCounter = 0;

  /// Serializes mutations so concurrent callers cannot interleave writes.
  Future<T> _locked<T>(Future<T> Function() body) {
    final completer = Completer<T>();
    _tail = _tail.then((_) async {
      try {
        completer.complete(await body());
      } catch (e, st) {
        completer.completeError(e, st);
      }
    });
    return completer.future;
  }

  Future<void> load() => _locked(_loadUnlocked);

  Future<void> _loadUnlocked() async {
    if (_loaded) return;
    _loaded = true;
    if (!await file.exists()) return;
    Object? decoded;
    try {
      decoded = jsonDecode(await file.readAsString());
    } on FormatException {
      decoded = null;
    }
    if (decoded is! Map || decoded["schemaVersion"] != schemaVersion) {
      // Unknown format: refuse to guess. Keep the original for inspection and
      // fail closed (every capture reads as ownerless).
      await file.rename(
        "${file.path}.unrecognized-${_clock().millisecondsSinceEpoch}",
      );
      return;
    }
    final Map<Object?, Object?> root = decoded;
    void copy(String key, Map<String, Map<String, Object?>> into) {
      final section = root[key];
      if (section is! Map) return;
      section.forEach((k, v) {
        if (k is String && v is Map) into[k] = Map<String, Object?>.from(v);
      });
    }

    copy("intents", _intents);
    copy("sessions", _sessions);
    copy("uploads", _uploads);
  }

  Future<void> _flush() async {
    await file.parent.create(recursive: true);
    final tmp = File("${file.path}.tmp");
    final raf = await tmp.open(mode: FileMode.write);
    try {
      await raf.writeString(
        jsonEncode({
          "schemaVersion": schemaVersion,
          "intents": _intents,
          "sessions": _sessions,
          "uploads": _uploads,
        }),
      );
      await raf.flush();
    } finally {
      await raf.close();
    }
    await tmp.rename(file.path);
  }

  /// Persists the owner of a capture about to start. Must complete before
  /// the native recorder is asked to Start.
  Future<String> beginCapture(String ownerAuthUserId) => _locked(() async {
    await _loadUnlocked();
    if (ownerAuthUserId.isEmpty) throw ArgumentError("empty owner");
    final now = _clock();
    final id = "i${now.microsecondsSinceEpoch}-${_intentCounter++}";
    _intents[id] = {
      "owner": ownerAuthUserId,
      "createdAt": now.toUtc().toIso8601String(),
      "state": "pending",
    };
    await _flush();
    return id;
  });

  /// Binds the native output directory to the intent's owner.
  Future<void> bindCapture(String intentId, String sessionDirName) =>
      _locked(() async {
        await _loadUnlocked();
        final intent = _intents[intentId];
        if (intent == null || intent["state"] != "pending") {
          throw StateError("unknown or settled capture intent");
        }
        final owner = intent["owner"] as String;
        final existing = _sessions[sessionDirName];
        if (existing != null && existing["owner"] != owner) {
          throw OwnerConflict(sessionDirName);
        }
        _sessions[sessionDirName] ??= {
          "owner": owner,
          "stampedAt": _clock().toUtc().toIso8601String(),
          "intentId": intentId,
          "provenance": "capture_start",
        };
        intent["state"] = "bound";
        intent["sessionDir"] = sessionDirName;
        await _flush();
      });

  Future<void> abortCapture(String intentId) => _locked(() async {
    await _loadUnlocked();
    final intent = _intents[intentId];
    if (intent == null || intent["state"] != "pending") return;
    intent["state"] = "aborted";
    await _flush();
  });

  /// Explicit, user-confirmed recovery of ownerless data by a verified owner.
  /// Refuses data that already has an owner.
  Future<void> recoverOwnerless(
    String sessionDirName,
    String ownerAuthUserId,
  ) => _locked(() async {
    await _loadUnlocked();
    final existing = _sessions[sessionDirName];
    if (existing != null) {
      if (existing["owner"] == ownerAuthUserId) return;
      throw OwnerConflict(sessionDirName);
    }
    _sessions[sessionDirName] = {
      "owner": ownerAuthUserId,
      "stampedAt": _clock().toUtc().toIso8601String(),
      "provenance": "legacy_recovery",
    };
    await _flush();
  });

  /// Stamps a non-capture upload source (e.g. a picked video) at enqueue time.
  Future<void> stampUploadSource(String filepath, String ownerAuthUserId) =>
      _locked(() async {
        await _loadUnlocked();
        final key = p.normalize(filepath);
        final existing = _uploads[key];
        if (existing != null) {
          if (existing["owner"] == ownerAuthUserId) return;
          throw OwnerConflict(key);
        }
        _uploads[key] = {
          "owner": ownerAuthUserId,
          "stampedAt": _clock().toUtc().toIso8601String(),
        };
        await _flush();
      });

  /// Requires [load] first. Synchronous for list filtering and queue checks.
  CaptureOwnership ownerOfSession(String sessionDirName) {
    final record = _sessions[sessionDirName];
    if (record == null) return const Ownerless();
    return OwnedBy(
      record["owner"] as String,
      provenance: record["provenance"] as String? ?? "capture_start",
    );
  }

  /// Owner of an upload source path: an explicit stamp, else the capture
  /// session directory under `ar_sessions/` that contains it.
  CaptureOwnership ownerOfPath(String filepath) {
    final key = p.normalize(filepath);
    final stamp = _uploads[key];
    if (stamp != null) {
      return OwnedBy(stamp["owner"] as String, provenance: "upload_source");
    }
    final parts = p.split(key);
    final at = parts.lastIndexOf("ar_sessions");
    if (at >= 0 && at + 1 < parts.length) {
      return ownerOfSession(parts[at + 1]);
    }
    return const Ownerless();
  }

  List<PendingIntent> pendingIntents() => [
    for (final e in _intents.entries)
      if (e.value["state"] == "pending")
        PendingIntent(
          e.key,
          e.value["owner"] as String,
          DateTime.parse(e.value["createdAt"] as String),
        ),
  ];
}
