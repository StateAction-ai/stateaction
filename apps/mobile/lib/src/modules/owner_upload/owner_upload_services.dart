import "dart:io";

import "package:flutter/foundation.dart";
import "package:path/path.dart" as p;
import "package:path_provider/path_provider.dart";
import "package:stera/src/core/config/app_config.dart";
import "package:stera/src/core/contracts/published_contracts.dart";
import "package:stera/src/modules/auth/session/auth_services.dart";
import "package:stera/src/modules/owner_upload/capture_pause_coordinator.dart";
import "package:stera/src/modules/owner_upload/native_session_binder.dart";
import "package:stera/src/modules/owner_upload/native_source_guard.dart";
import "package:stera/src/modules/owner_upload/native_upload_port.dart";
import "package:stera/src/modules/owner_upload/owner_control_api.dart";
import "package:stera/src/modules/owner_upload/owner_upload_controller.dart";
import "package:stera/src/modules/source_integrity/android_channel_hash_backend.dart";
import "package:stera/src/modules/source_integrity/source_sealer.dart";
import "package:stera/src/modules/source_integrity/stable_hasher.dart";
import "package:permission_handler/permission_handler.dart";

/// Composition root for the owner-bound native uploader. Android only, behind
/// two independent gates (`OWNER_NATIVE_UPLOAD` and the native build gate);
/// otherwise the instance is null or disabled and no behavior changes.
class OwnerUploadServices {
  OwnerUploadServices._({
    required this.controller,
    required this.binder,
    required this.pause,
    required this.port,
    required this.journalDir,
  });

  final OwnerUploadController controller;
  final NativeSessionBinder binder;
  final CapturePauseCoordinator pause;
  final NativeUploadPort port;
  final Directory journalDir;

  static OwnerUploadServices? _instance;
  static bool _nativeGate = false;

  static OwnerUploadServices? get maybeInstance => _instance;

  static final List<void Function(OwnerUploadServices)> _whenReady = [];

  /// Runs [action] once the services exist (now, or after startup). Never runs
  /// when the feature is gated off.
  static void whenReady(void Function(OwnerUploadServices services) action) {
    final ready = _instance;
    if (ready != null) {
      action(ready);
    } else {
      _whenReady.add(action);
    }
  }

  @visibleForTesting
  static void debugReset() {
    _instance?.binder.detach();
    _instance = null;
    _nativeGate = false;
    NativeSourceGuard.reset();
  }

  static bool get _enabled => AppConfig.ownerNativeUpload && _nativeGate;

  /// Builds the services after [AuthServices.initialize]. Never throws: a
  /// failure leaves the feature off and the rest of the app untouched.
  static Future<OwnerUploadServices?> initialize({
    required AuthServices auth,
    NativeUploadPort? port,
    Directory? journalDir,
  }) async {
    final existing = _instance;
    if (existing != null) return existing;
    if (!Platform.isAndroid || !AppConfig.ownerNativeUpload) return null;
    try {
      final native = port ?? BridgeNativeUploadPort();
      final capabilities = await native.capabilities();
      _nativeGate = capabilities.gateEnabled && capabilities.supported;
      if (!_nativeGate) return null;
      final dir =
          journalDir ??
          Directory(
            p.join(
              (await getApplicationSupportDirectory()).path,
              "owner_upload",
              "journals",
            ),
          );
      await dir.create(recursive: true);
      NativeSourceGuard.configure(dir);
      final binder = NativeSessionBinder(
        auth: auth.controller,
        client: auth.client,
        native: native,
        enabled: () => _enabled,
      )..attach();
      final hasher = StableFileHasher(AndroidChannelHashBackend());
      final controller = OwnerUploadController(
        auth: auth.controller,
        client: auth.client,
        ledger: auth.ledger,
        api: OwnerControlApi(auth.client),
        native: native,
        binder: binder,
        sealer: SourceSealer(
          registry: PublishedContracts.registry,
          hasher: hasher,
        ),
        hasher: hasher,
        journalDir: dir,
        enabled: () => _enabled,
        requestNotificationPermission: () async =>
            (await Permission.notification.request()).isGranted,
      );
      final pause = CapturePauseCoordinator(
        native: native,
        enabled: () => _enabled,
      );
      final created = _instance = OwnerUploadServices._(
        controller: controller,
        binder: binder,
        pause: pause,
        port: native,
        journalDir: dir,
      );
      for (final action in List.of(_whenReady)) {
        action(created);
      }
      _whenReady.clear();
      return created;
    } on Object catch (e) {
      debugPrint("⚠️ owner upload unavailable: ${e.runtimeType}");
      _nativeGate = false;
      return null;
    }
  }
}
