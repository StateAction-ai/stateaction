import "dart:io";

import "package:device_info_plus/device_info_plus.dart";
import "package:package_info_plus/package_info_plus.dart";
import "package:stera/src/modules/owner_upload/final_source_evidence.dart";
import "package:stera/src/modules/source_integrity/closed_source_ack.dart";

/// Bounded, non-identifying facts about the device and app build.
class DeviceFacts {
  const DeviceFacts({
    required this.model,
    required this.osVersion,
    required this.appVersion,
  });
  final String model;
  final String osVersion;
  final String appVersion;
}

abstract interface class DeviceFactsSource {
  Future<DeviceFacts> read();
}

class PlatformDeviceFactsSource implements DeviceFactsSource {
  const PlatformDeviceFactsSource();

  @override
  Future<DeviceFacts> read() async {
    final package = await PackageInfo.fromPlatform();
    if (Platform.isAndroid) {
      final info = await DeviceInfoPlugin().androidInfo;
      return DeviceFacts(
        model: info.model,
        osVersion: info.version.release,
        appVersion: package.version,
      );
    }
    return DeviceFacts(
      model: "unknown",
      osVersion: Platform.operatingSystemVersion,
      appVersion: package.version,
    );
  }
}

/// Builds the exact `http.recording-create.v2` request frozen into the owner
/// journal when it is created. Nothing here is guessed:
/// - the profile follows the recorder's own final metadata;
/// - a simulation marker is present only for the explicit simulation profile
///   and every provenance component is `unknown` (nothing was measured);
/// - `startedAt` is the real wall-clock start or the build is refused.
class CreateRequestBuilder {
  const CreateRequestBuilder();

  static final RegExp _revision = RegExp(r"^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$");

  Map<String, Object?> build({
    required String clientRecordingId,
    required FinalSourceEvidence evidence,
    required DeviceFacts device,
  }) {
    final started = evidence.startedAtUtc;
    if (started == null) throw const NotUploadReady("start_time_unknown");
    final model = _bounded(device.model, 80);
    final os = _bounded(device.osVersion, 40);
    final app = _revision.hasMatch(device.appVersion)
        ? device.appVersion
        : _sanitizeRevision(device.appVersion);
    return {
      "schema": "stateaction.recording_create.v2",
      "clientRecordingId": clientRecordingId,
      "captureFormat": "stateaction.capture.v1",
      "rgbProfile": evidence.rgbProfile,
      "startedAt": _rfc3339Utc(started),
      "device": {"model": model, "osVersion": os, "appVersion": app},
      if (evidence.isSimulation)
        "simulation": {
          "schema": "stateaction.simulation_provenance.v1",
          "qualification": "simulation_only",
          "mappedTimelineSemantics": "simulation_transport_only",
          "productionQualified": false,
          "provenance": {
            "camera": {"status": "unknown"},
            "encoder": {"status": "unknown"},
            "clock": {"status": "unknown"},
          },
        },
    };
  }

  static String _bounded(String value, int max) {
    final trimmed = value.trim();
    if (trimmed.isEmpty) return "unknown";
    return trimmed.length <= max ? trimmed : trimmed.substring(0, max);
  }

  static String _sanitizeRevision(String value) {
    final cleaned = value.replaceAll(RegExp(r"[^A-Za-z0-9._+-]"), "");
    if (cleaned.isEmpty || !RegExp(r"^[A-Za-z0-9]").hasMatch(cleaned)) {
      return "unknown0";
    }
    return cleaned.length <= 64 ? cleaned : cleaned.substring(0, 64);
  }

  static String _rfc3339Utc(DateTime utc) {
    final u = utc.toUtc();
    String two(int v) => v.toString().padLeft(2, "0");
    return "${u.year.toString().padLeft(4, "0")}-${two(u.month)}-${two(u.day)}"
        "T${two(u.hour)}:${two(u.minute)}:${two(u.second)}Z";
  }
}
