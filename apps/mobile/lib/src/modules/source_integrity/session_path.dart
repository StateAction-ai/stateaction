import "dart:io";

import "package:path/path.dart" as p;

class PathEscape implements Exception {
  const PathEscape(this.path, this.reason);
  final String path;
  final String reason;
  @override
  String toString() => "PathEscape($path: $reason)";
}

/// Confines source files to one recording-session directory: relative POSIX
/// paths only, no `..`, no symlink anywhere on the path, final target a
/// regular file whose canonical path stays under the canonical root.
class SessionRoot {
  SessionRoot._(this.canonicalRoot);
  final String canonicalRoot;

  static Future<SessionRoot> open(String rootPath) async {
    if (await FileSystemEntity.type(rootPath, followLinks: false) !=
        FileSystemEntityType.directory) {
      throw PathEscape(rootPath, "session root is not a real directory");
    }
    return SessionRoot._(await Directory(rootPath).resolveSymbolicLinks());
  }

  /// Lexical check only (no filesystem access): returns the path segments or
  /// throws [PathEscape]. The secure open itself is done by the hash backend
  /// on the opened descriptor, not by this check.
  static List<String> checkRelative(String relative) {
    if (relative.isEmpty ||
        p.isAbsolute(relative) ||
        relative.contains("\\") ||
        relative.contains("\u0000")) {
      throw PathEscape(relative, "not a safe relative path");
    }
    final parts = relative.split("/");
    if (parts.any((s) => s.isEmpty || s == "." || s == "..")) {
      throw PathEscape(relative, "empty, dot or dot-dot segment");
    }
    return parts;
  }

  /// Advisory pre-check returning the canonical absolute path of [relative]
  /// or throwing [PathEscape]. Not a security boundary (it is a path walk
  /// separate from any open); hashing uses fd-bound confinement instead.
  Future<String> resolve(String relative) async {
    final parts = checkRelative(relative);
    var cursor = canonicalRoot;
    for (final part in parts) {
      cursor = p.join(cursor, part);
      final type = await FileSystemEntity.type(cursor, followLinks: false);
      if (type == FileSystemEntityType.link) {
        throw PathEscape(relative, "symlink on path");
      }
      if (type == FileSystemEntityType.notFound) {
        throw PathEscape(relative, "missing");
      }
    }
    if (await FileSystemEntity.type(cursor, followLinks: false) !=
        FileSystemEntityType.file) {
      throw PathEscape(relative, "not a regular file");
    }
    final real = await File(cursor).resolveSymbolicLinks();
    if (!p.isWithin(canonicalRoot, real)) {
      throw PathEscape(relative, "escapes session root");
    }
    return real;
  }
}
