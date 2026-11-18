/// Explicit transport and inventory caps (published contract values).
class SourceLimits {
  const SourceLimits._();

  /// `common.v1#/$defs/fileSizeBytes`: 1..100 GiB per file.
  static const int maxFileBytes = 107374182400;

  /// Two-hour recording cap. A capture longer than this is refused as a
  /// complete source (it stays recoverable and blocked).
  static const Duration maxRecordingDuration = Duration(hours: 2);

  /// `recording-seal.v1` / `recording-source.v1` file-count bound
  /// (the manifest itself is one of the seal entries).
  static const int maxSealFiles = 2000;

  /// `recording-source.v1` maxBytes.
  static const int maxManifestBytes = 1048576;

  /// Default streaming read size; hashing memory is bounded by this.
  static const int defaultChunkBytes = 1 << 20;

  /// Absolute chunk cap enforced by the native channel
  /// (`SourceHashArgs.MAX_CHUNK_BYTES`): the Kotlin worker allocates one
  /// heap buffer of the requested size, so the request is bounded up front.
  static const int maxChunkBytes = 16 << 20;
}
