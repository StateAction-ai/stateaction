import "dart:convert";
import "dart:io";

import "package:crypto/crypto.dart";
import "package:path/path.dart" as p;
import "package:stateaction_contracts/stateaction_contracts.dart";
import "package:stera/src/modules/source_integrity/closed_source_ack.dart";

/// Genuine closure evidence for one finished recording, read back from the
/// session directory the native recorder finalized. Everything here was checked
/// independently of the Dart UI state, so it also works after the app was
/// killed before Dart received the native stop response.
class FinalSourceEvidence {
  const FinalSourceEvidence({
    required this.ack,
    required this.rgbProfile,
    required this.captureConfig,
    required this.captureConfigSha256,
    required this.startedAtUtc,
  });

  /// The same value [ClosedSourceAck.fromNativeStop] builds from a live stop.
  final ClosedSourceAck ack;

  /// `h264_mcap_v1` (hardware) or `h264_mcap_simulation_v1` (explicitly
  /// enabled emulator profile). Never inferred from the GPU or device model.
  final String rgbProfile;

  /// Facts recorded by the recorder about the configuration actually used.
  final Map<String, Object?> captureConfig;
  final String captureConfigSha256;

  /// Wall-clock start recovered from the native session directory name, or
  /// null when it is not known. Monotonic timestamps are never mapped to Unix.
  final DateTime? startedAtUtc;

  bool get isSimulation => rgbProfile == simulationProfile;

  static const String hardwareProfile = "h264_mcap_v1";
  static const String simulationProfile = "h264_mcap_simulation_v1";
}

/// Strict, read-only adapter over the files the native recorder writes at the
/// end of a capture: `finalization_journal.json`, `metadata.json` and the
/// absence of `recovery_required.json`.
///
/// It refuses (with a stable [NotUploadReady] code) anything early, partial,
/// quarantined, unreadable, symlinked or internally inconsistent. It never
/// writes, renames, hashes or deletes an original file and never constructs a
/// completed outcome from a footer or path list.
class FinalSourceEvidenceReader {
  const FinalSourceEvidenceReader();

  static const int _maxJsonBytes = 1024 * 1024;
  static final RegExp _uuid = RegExp(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
  );

  Future<FinalSourceEvidence> read(String sessionDirPath) async {
    Never refuse(String code) => throw NotUploadReady(code);
    final dirName = p.basename(sessionDirPath);
    if (await FileSystemEntity.type(sessionDirPath, followLinks: false) !=
        FileSystemEntityType.directory) {
      refuse("session_not_directory");
    }
    if (await FileSystemEntity.type(
          p.join(sessionDirPath, "recovery_required.json"),
          followLinks: false,
        ) !=
        FileSystemEntityType.notFound) {
      refuse("session_quarantined");
    }
    final journal = await _readJson(
      p.join(sessionDirPath, "finalization_journal.json"),
      "finalization_journal",
    );
    final metadata = await _readJson(
      p.join(sessionDirPath, "metadata.json"),
      "metadata",
    );

    final recordingId = metadata["recording_id"];
    final token = metadata["finalization_token"];
    if (recordingId is! String ||
        !_uuid.hasMatch(recordingId) ||
        token is! String ||
        !_uuid.hasMatch(token)) {
      refuse("final_identity_missing");
    }
    if (journal["phase"] != "FINALIZED" ||
        journal["final"] != true ||
        journal["recording_id"] != recordingId ||
        journal["session_name"] != dirName) {
      refuse("not_finalized");
    }
    if (metadata["container_state"] != "closed" ||
        metadata["capture_outcome"] != "completed" ||
        metadata["recovery_state"] != "none" ||
        metadata["finalization_complete"] != true ||
        metadata["capture_result_valid"] != true ||
        metadata["container_fsync"] != true ||
        metadata["first_writer_error"] != null ||
        metadata["upload_admission"] != "not_evaluated_by_recorder" ||
        metadata["rgb_codec"] != "h264") {
      refuse("closure_evidence_incomplete");
    }
    final closure = metadata["source_closure"];
    if (closure is! Map ||
        closure["finalizationToken"] != token ||
        closure["recordingId"] != recordingId) {
      refuse("closure_identity_mismatch");
    }

    // Reuse the one native-closure parser so the live-stop and cold-start
    // paths cannot drift apart.
    final ack = ClosedSourceAck.fromNativeStop({
      "success": true,
      "outputDirectory": sessionDirPath,
      "containerState": metadata["container_state"],
      "captureOutcome": metadata["capture_outcome"],
      "recoveryState": metadata["recovery_state"],
      "finalizationToken": token,
      "recordingId": recordingId,
      "sourceClosure": Map<String, Object?>.from(closure),
      "sourceIdentity": journal["source_identity"],
    });

    final qualification = metadata["qualification"];
    final videoProfile = metadata["video_profile"];
    final String profile;
    if (qualification == "simulation_only" &&
        videoProfile == "simulation_640x480_30fps") {
      profile = FinalSourceEvidence.simulationProfile;
    } else if (qualification == "unqualified" &&
        videoProfile == "candidate_1920x1080_30fps") {
      profile = FinalSourceEvidence.hardwareProfile;
    } else {
      refuse("capture_profile_inconsistent");
    }

    const configKeys = [
      "rgb_codec",
      "video_profile",
      "qualification",
      "sampling_strategy",
      "rgb_sampling_strategy",
      "rgb_intentional_downsample",
      "encoder_mode",
      "raw_imu",
    ];
    final config = <String, Object?>{
      for (final key in configKeys)
        if (metadata.containsKey(key)) key: metadata[key],
    };
    final configSha = sha256.convert(utf8.encode(canonicalJson(config)));

    return FinalSourceEvidence(
      ack: ack,
      rgbProfile: profile,
      captureConfig: config,
      captureConfigSha256: configSha.toString(),
      startedAtUtc: startedAtFromDirectoryName(dirName),
    );
  }

  /// The session directory name carries the recorder's device-local
  /// wall-clock at Start. Anything else is "not known".
  static DateTime? startedAtFromDirectoryName(String dirName) {
    // `session_YYYYMMDD_HHMMSS` optionally followed by the recorder's
    // `_<millis>_<hex id>` suffix (`session_20261102_070526_592_f415712e`).
    final match = RegExp(
      r"^session_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})(?:_\d{3})?(?:_[0-9a-f]{8})?$",
    ).firstMatch(dirName);
    if (match == null) return null;
    final v = [for (var i = 1; i <= 6; i++) int.parse(match.group(i)!)];
    final local = DateTime(v[0], v[1], v[2], v[3], v[4], v[5]);
    if (local.year != v[0] ||
        local.month != v[1] ||
        local.day != v[2] ||
        local.hour != v[3] ||
        local.minute != v[4] ||
        local.second != v[5]) {
      return null;
    }
    return local.toUtc();
  }

  Future<Map<String, Object?>> _readJson(String path, String label) async {
    if (await FileSystemEntity.type(path, followLinks: false) !=
        FileSystemEntityType.file) {
      throw NotUploadReady("${label}_missing");
    }
    final file = File(path);
    if (await file.length() > _maxJsonBytes) {
      throw NotUploadReady("${label}_too_large");
    }
    try {
      final decoded = jsonDecode(utf8.decode(await file.readAsBytes()));
      if (decoded is Map<String, Object?>) return decoded;
    } on FormatException {
      // fall through
    }
    throw NotUploadReady("${label}_unreadable");
  }
}
