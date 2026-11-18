import "dart:io";

import "package:flutter/foundation.dart";
import "package:path/path.dart" as p;

/// Marks recording sessions whose upload is owned by the native owner-bound
/// pipeline. Once a source journal exists for a session, the legacy Dart
/// queue (windowed/adaptive uploader, local cleanup) must neither start an
/// upload for it nor delete its directory, journal or manifest.
abstract final class NativeSourceGuard {
  static Directory? _journalDir;

  /// True once the owner-bound native uploader is fully enabled (both gates).
  /// From then on the legacy Dart pipeline never creates upload rows for, or
  /// sweeps, AR recordings: the native pipeline owns every capture.
  static bool nativeEnabled = false;

  /// Bumped when a capture finished and the take list should be re-read.
  static final ValueNotifier<int> takesChanged = ValueNotifier<int>(0);

  static void configure(Directory journalDir) {
    _journalDir = journalDir;
    nativeEnabled = true;
  }

  static void reset() {
    _journalDir = null;
    nativeEnabled = false;
  }

  /// A user-visible reason the explicit "Delete recording" action must not
  /// remove this session, or null when the legacy path may proceed. Fails
  /// closed and has NO release path: a transport that reached the server is not
  /// SHA verification, and even verified files do not establish the original
  /// owner's plus explicit staff cloud-copy confirmation that local cleanup
  /// requires (SA-23, not implemented). Originals, journal and manifest of a
  /// natively owned session therefore stay untouched in every upload state.
  static String? deleteBlockReason(String sessionDirName) {
    // Deletion-specific guard: with native mode on, EVERY AR capture is
    // protected, including a just-recorded take that has no upload journal yet
    // (the journal appears only when Upload is tapped). Uploader routing keeps
    // its strict journal-based ownership ([ownsSession]).
    final protectedCapture =
        nativeEnabled && sessionDirName.startsWith("session_");
    if (!protectedCapture && !ownsSession(sessionDirName)) return null;
    return "This recording belongs to your upload and stays on this device "
        "until a confirmed cloud copy exists.";
  }

  static bool ownsSession(String sessionDirName) {
    final dir = _journalDir;
    if (dir == null || sessionDirName.isEmpty) return false;
    return File(p.join(dir.path, "$sessionDirName.source.jsonl")).existsSync();
  }

  /// A path under `ar_sessions/<session>/...` or a session directory itself.
  static bool ownsPath(String filepath) {
    final parts = p.split(p.normalize(filepath));
    final at = parts.lastIndexOf("ar_sessions");
    if (at >= 0 && at + 1 < parts.length) return ownsSession(parts[at + 1]);
    final base = p.basename(filepath);
    return base.startsWith("session_") && ownsSession(base);
  }
}
