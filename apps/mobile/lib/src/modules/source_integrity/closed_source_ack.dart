import "package:path/path.dart" as p;

import "file_identity.dart";
import "source_limits.dart";

class SourceFileSpec {
  const SourceFileSpec({
    required this.role,
    required this.relativePath,
    this.required = true,
  });

  /// `source_mcap`, `recorder_metadata` or `calibration`.
  final String role;

  /// Path relative to the recording-session directory.
  final String relativePath;
  final bool required;
}

/// The native recorder said the capture is not a complete source.
class NotUploadReady implements Exception {
  const NotUploadReady(this.code);
  final String code;
  @override
  String toString() => "NotUploadReady($code)";
}

/// Private native journal evidence. The Stop response echoes the same value.
class NativeSourceIdentity {
  NativeSourceIdentity._(this.finalizationToken, this.directory, this.files);

  final String finalizationToken;
  final FileKey directory;
  final Map<String, FileIdentity> files;

  factory NativeSourceIdentity._parse(Object raw, String token, int fileCount) {
    if (raw is! Map ||
        raw["finalizationToken"] != token ||
        raw["directory"] is! Map ||
        raw["files"] is! Map) {
      throw const NotUploadReady("native_close_identity_invalid");
    }
    final files = raw["files"] as Map;
    if (files.length != fileCount) {
      throw const NotUploadReady("native_close_identity_invalid");
    }
    try {
      return NativeSourceIdentity._(
        token,
        FileKey.fromJson(raw["directory"] as Map),
        Map.unmodifiable({
          for (final entry in files.entries)
            entry.key as String: FileIdentity.fromJson(entry.value as Map),
        }),
      );
    } on Object {
      throw const NotUploadReady("native_close_identity_invalid");
    }
  }

  Map<String, Object?> toJson() => {
    "finalizationToken": finalizationToken,
    "directory": directory.toJson(),
    "files": {
      for (final entry in files.entries) entry.key: entry.value.toJson(),
    },
  };
}

/// Final closure evidence for one recording: the finished recorder's stop /
/// finite-EOS-drain / footer-close acknowledgement plus the required final
/// files it produced. An early marker or a path list alone cannot construct a
/// passing value: every field below must hold.
///
/// [fromNativeStop] accepts only the completed SA-56 native response. The
/// uploader must additionally bind it to its owner ledger and session root.
class ClosedSourceAck {
  /// Bind the actual SA-56 native stop response to the source sealer. Missing,
  /// partial, timed-out and early-metadata responses cannot become an ack.
  factory ClosedSourceAck.fromNativeStop(Map<String, Object?> result) {
    Never refuse(String code) => throw NotUploadReady(code);
    if (result["success"] != true ||
        result["containerState"] != "closed" ||
        result["captureOutcome"] != "completed" ||
        result["recoveryState"] != "none") {
      refuse("native_stop_not_complete");
    }
    final value = result["sourceClosure"];
    if (value is! Map) refuse("native_closure_missing");
    if (value.keys.any((key) => key is! String)) {
      refuse("native_closure_inventory");
    }
    final data = Map<String, Object?>.from(value);
    final token = data["finalizationToken"];
    final recordingId = data["recordingId"];
    final outputDirectory = result["outputDirectory"];
    final uuid = RegExp(
      r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
    );
    if (data["schema"] != "stateaction.native_source_close.v1" ||
        token is! String ||
        !uuid.hasMatch(token) ||
        recordingId is! String ||
        !uuid.hasMatch(recordingId) ||
        token != result["finalizationToken"] ||
        data["recordingId"] != result["recordingId"]) {
      refuse("native_closure_identity");
    }
    if (outputDirectory is! String) {
      refuse("native_session_directory_invalid");
    }
    final micros = data["durationMicros"];
    final duration =
        micros is String && RegExp(r"^[1-9][0-9]{0,12}$").hasMatch(micros)
        ? int.tryParse(micros)
        : null;
    final files = data["files"];
    final clocks = data["clockDomains"];
    final channels = data["channels"];
    final counts = data["counts"];
    final rawIdentity = result["sourceIdentity"];
    if (duration == null ||
        files is! List ||
        clocks is! List ||
        channels is! List ||
        counts is! Map ||
        files.length > SourceLimits.maxSealFiles - 1 ||
        clocks.isEmpty ||
        clocks.length > 16 ||
        channels.isEmpty ||
        channels.length > 64 ||
        counts.length != 3 ||
        !counts.keys.toSet().containsAll({
          "video_frames",
          "dropped_video_frames",
          "motion_events",
        })) {
      refuse("native_closure_inventory");
    }
    try {
      final ack = ClosedSourceAck(
        nativeRecordingId: recordingId,
        finalizationToken: token,
        nativeOutputDirectory: outputDirectory,
        nativeSourceIdentity: rawIdentity == null
            ? null
            : NativeSourceIdentity._parse(rawIdentity, token, files.length),
        outcome: data["outcome"] as String,
        closeStatus: data["closeStatus"] as String,
        eosDrained: data["eosDrained"] == true,
        footerClosed: data["footerClosed"] == true,
        unresolvedFrames: data["unresolvedFrames"] as int,
        duration: Duration(microseconds: duration),
        files: [
          for (final file in files)
            SourceFileSpec(
              role: (file as Map)["role"] as String,
              relativePath: file["relativePath"] as String,
              required: file["required"] == true,
            ),
        ],
        clockDomains: List<String>.from(clocks),
        channels: [
          for (final channel in channels)
            Map<String, Object?>.from(channel as Map),
        ],
        counts: Map<String, String>.from(counts),
      );
      ack.assertAdmissible();
      return ack;
    } on NotUploadReady {
      rethrow;
    } on Object {
      refuse("native_closure_inventory");
    }
  }

  const ClosedSourceAck({
    this.nativeRecordingId,
    this.finalizationToken,
    this.nativeOutputDirectory,
    this.nativeSourceIdentity,
    required this.outcome,
    required this.closeStatus,
    required this.eosDrained,
    required this.footerClosed,
    required this.unresolvedFrames,
    required this.duration,
    required this.files,
    required this.clockDomains,
    required this.channels,
    required this.counts,
  });

  /// Native identities retained for the uploader's session/ledger binding.
  /// They are separate from the catalog/server recording id.
  final String? nativeRecordingId;
  final String? finalizationToken;
  final String? nativeOutputDirectory;
  final NativeSourceIdentity? nativeSourceIdentity;

  static bool _isNativeSourceDirectory(String path) =>
      p.isAbsolute(path) && !path.contains("\u0000");

  /// `stateaction.capture.Close.v1` outcome; only `completed` is complete.
  final String outcome;

  /// `closed_clean` or `closed_after_recovery` (recording-source close_status).
  final String closeStatus;
  final bool eosDrained;
  final bool footerClosed;
  final int unresolvedFrames;
  final Duration duration;
  final List<SourceFileSpec> files;
  final List<String> clockDomains;
  final List<Map<String, Object?>> channels;
  final Map<String, String> counts;

  /// Throws [NotUploadReady] with a stable code unless this is a complete,
  /// bounded, fully inventoried closure.
  void assertAdmissible() {
    if (outcome != "completed") throw NotUploadReady("outcome_$outcome");
    if (!eosDrained) throw const NotUploadReady("eos_not_drained");
    if (!footerClosed) throw const NotUploadReady("footer_not_closed");
    if (unresolvedFrames != 0) throw const NotUploadReady("unresolved_frames");
    if (closeStatus != "closed_clean" &&
        closeStatus != "closed_after_recovery") {
      throw const NotUploadReady("close_status_invalid");
    }
    if (duration > SourceLimits.maxRecordingDuration) {
      throw const NotUploadReady("over_two_hour_cap");
    }
    final directory = nativeOutputDirectory;
    if (directory == null
        ? nativeRecordingId != null || finalizationToken != null
        : !_isNativeSourceDirectory(directory)) {
      throw const NotUploadReady("native_session_directory_invalid");
    }
    int count(String role) => files.where((f) => f.role == role).length;
    if (count("source_mcap") != 1) throw const NotUploadReady("mcap_count");
    if (count("recorder_metadata") < 1) {
      throw const NotUploadReady("recorder_metadata_missing");
    }
    if (files.any(
      (f) => !const {
        "source_mcap",
        "recorder_metadata",
        "calibration",
      }.contains(f.role),
    )) {
      throw const NotUploadReady("role_invalid");
    }
    if (files.any((f) => !f.required)) {
      // Optional files are not part of the required-file inventory.
      throw const NotUploadReady("optional_file_not_supported");
    }
    if (files.length > SourceLimits.maxSealFiles - 1) {
      throw const NotUploadReady("too_many_files");
    }
    if (files.map((f) => f.relativePath).toSet().length != files.length) {
      throw const NotUploadReady("duplicate_path");
    }
    final identity = nativeSourceIdentity;
    if (identity != null &&
        (identity.finalizationToken != finalizationToken ||
            identity.files.length != files.length ||
            files.any((f) {
              final size = identity.files[f.relativePath]?.size;
              return size == null ||
                  size < 1 ||
                  size > SourceLimits.maxFileBytes;
            }))) {
      throw const NotUploadReady("native_close_identity_invalid");
    }
  }
}
