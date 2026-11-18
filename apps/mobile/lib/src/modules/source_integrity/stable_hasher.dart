import "file_identity.dart";
import "session_path.dart";
import "source_limits.dart";

enum InstabilityReason {
  grewDuringHash,
  shrankDuringHash,
  identityChanged,
  readFailed,
  empty,
  overCap,
}

/// The file changed (or could not be read) while being hashed. The file is
/// never claimed as sealed and is never deleted or repaired.
class SourceNotStable implements Exception {
  const SourceNotStable(this.reason, this.path, [this.detail]);
  final InstabilityReason reason;
  final String path;
  final String? detail;
  @override
  String toString() => "SourceNotStable(${reason.name}, $path, $detail)";
}

class HashCancelled implements Exception {
  const HashCancelled();
  @override
  String toString() => "HashCancelled";
}

class HashCancellation {
  bool _cancelled = false;
  final List<void Function()> _listeners = [];
  bool get isCancelled => _cancelled;

  /// Backends that hash off the Dart isolate (Android) subscribe to forward
  /// cancellation to the native worker.
  void addListener(void Function() listener) {
    if (_cancelled) {
      listener();
    } else {
      _listeners.add(listener);
    }
  }

  void removeListener(void Function() listener) => _listeners.remove(listener);

  void cancel() {
    if (_cancelled) return;
    _cancelled = true;
    for (final l in List.of(_listeners)) {
      l();
    }
  }
}

class HashedFile {
  const HashedFile({
    required this.sha256,
    required this.sizeBytes,
    required this.identity,
    required this.peakBufferBytes,
    required this.chunkCount,
  });
  final String sha256;
  final int sizeBytes;

  /// `fstat` identity of the opened descriptor, equal before and after the read.
  final FileIdentity identity;

  /// Largest single read buffer allocated: the hashing memory bound.
  final int peakBufferBytes;
  final int chunkCount;
}

/// Test seams honoured only by the in-process host backend; the Android
/// backend runs natively and ignores them. Each runs with real I/O.
class HashProbes {
  const HashProbes({
    this.beforeOpen,
    this.afterOpen,
    this.afterChunk,
    this.beforeFinalCheck,
  });
  final Future<void> Function()? beforeOpen;
  final Future<void> Function()? afterOpen;
  final Future<void> Function(int chunkIndex)? afterChunk;
  final Future<void> Function()? beforeFinalCheck;
}

/// One confined hash request. [canonicalRoot] is the session directory's
/// realpath; [relativePath] has already passed [SessionRoot.checkRelative].
class ConfinedHashRequest {
  const ConfinedHashRequest({
    required this.canonicalRoot,
    required this.relativePath,
    required this.chunkBytes,
    required this.maxBytes,
    this.cancel,
    this.probes,
    this.expectedFile,
    this.expectedDirectory,
  });
  final String canonicalRoot;
  final String relativePath;
  final int chunkBytes;
  final int maxBytes;
  final HashCancellation? cancel;
  final HashProbes? probes;
  final FileIdentity? expectedFile;
  final FileKey? expectedDirectory;
}

/// Opens the file securely under the session root, then hashes **that same
/// descriptor**, checking `fstat` identity and the descriptor's path binding
/// before, during and after the read. Implementations: `PosixFdHashBackend`
/// (Linux host reference, libc via FFI) and `AndroidChannelHashBackend`
/// (Kotlin `Os` on a worker thread). No backend means refusal, never a weaker
/// path-based fallback.
abstract class ConfinedHashBackend {
  Future<HashedFile> hash(ConfinedHashRequest request);
}

class StableFileHasher {
  StableFileHasher(
    this.backend, {
    this.chunkBytes = SourceLimits.defaultChunkBytes,
    this.maxBytes = SourceLimits.maxFileBytes,
  }) : assert(chunkBytes > 0);

  final ConfinedHashBackend backend;
  final int chunkBytes;
  final int maxBytes;

  Future<HashedFile> hash(
    SessionRoot root,
    String relativePath, {
    HashCancellation? cancel,
    HashProbes? probes,
    FileIdentity? expectedFile,
    FileKey? expectedDirectory,
  }) async {
    SessionRoot.checkRelative(relativePath);
    return await backend.hash(
      ConfinedHashRequest(
        canonicalRoot: root.canonicalRoot,
        relativePath: relativePath,
        chunkBytes: chunkBytes,
        maxBytes: maxBytes,
        cancel: cancel,
        probes: probes,
        expectedFile: expectedFile,
        expectedDirectory: expectedDirectory,
      ),
    );
  }
}
