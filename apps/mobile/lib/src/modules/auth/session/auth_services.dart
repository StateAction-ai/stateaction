import "dart:io";

import "package:flutter/foundation.dart";

import "package:path/path.dart" as p;
import "package:path_provider/path_provider.dart";
import "package:stera/src/core/config/app_config.dart";
import "package:stera/src/modules/auth/session/auth_http_client.dart";
import "package:stera/src/modules/auth/session/auth_session_controller.dart";
import "package:stera/src/modules/auth/session/backend_origin.dart";
import "package:stera/src/modules/auth/session/offline_eligibility.dart";
import "package:stera/src/modules/auth/session/secret_store.dart";
import "package:stera/src/modules/auth/session/session_cookie_jar.dart";
import "package:stera/src/modules/capture_ownership/capture_access_policy.dart";
import "package:stera/src/modules/capture_ownership/capture_owner_gate.dart";
import "package:stera/src/modules/capture_ownership/capture_owner_ledger.dart";
import "package:stera/src/modules/owner_upload/owner_upload_services.dart";

/// Composition root for the authenticated build: one origin, one cookie jar,
/// one controller and one owner ledger. Never created in `NO_AUTH_MODE`.
class AuthServices {
  AuthServices._({
    required this.origin,
    required this.client,
    required this.controller,
    required this.ledger,
  }) : policy = CaptureAccessPolicy(ledger, clock: controller.now);

  final BackendOrigin origin;
  final AuthHttpClient client;
  final AuthSessionController controller;
  final CaptureOwnerLedger ledger;
  final CaptureAccessPolicy policy;

  SessionCookieJar get jar => client.jar;

  static AuthServices? _instance;

  @visibleForTesting
  static void debugReset() {
    _instance?.client.close();
    _instance = null;
  }

  /// Null in the auth-free build and before startup completes; callers must
  /// fail closed (no cookies, no owner, no networking).
  static AuthServices? get maybeInstance => _instance;

  /// Builds the services. Throws [StateError] when the backend origin is not
  /// configured, so startup surfaces a configuration error instead of silently
  /// running without a session.
  static Future<AuthServices> initialize({
    SecretStore secrets = const OsSecretStore(),
    BackendOrigin? origin,
    File? ledgerFile,
  }) async {
    final existing = _instance;
    if (existing != null) return existing;
    final resolved = origin ?? AppConfig.backendOrigin;
    if (resolved == null) {
      throw StateError(
        "Backend origin is not configured (DEV_/PROD_BACKEND_ORIGIN).",
      );
    }
    final file =
        ledgerFile ??
        File(
          p.join(
            (await getApplicationSupportDirectory()).path,
            "capture_ownership",
            "ledger.v1.json",
          ),
        );
    final ledger = CaptureOwnerLedger(file);
    await ledger.load();
    final client = AuthHttpClient(
      origin: resolved,
      jar: SessionCookieJar(origin: resolved, store: secrets),
      clientKind: Platform.isIOS ? "ios" : "android",
    );
    final services = AuthServices._(
      origin: resolved,
      client: client,
      controller: AuthSessionController(
        client: client,
        eligibility: OfflineEligibilityStore(origin: resolved, store: secrets),
      ),
      ledger: ledger,
    );
    _instance = services;
    return services;
  }

  /// Start gate for the recorder. Resolves services lazily so the provider can
  /// be created before startup; denies Start until services exist.
  static CaptureOwnerGate lazyCaptureGate() => CaptureOwnerGate.lazy(
    session: () => _instance?.controller.state ?? const AuthRestoring(),
    ledger: () => _instance?.ledger,
    pause: () => OwnerUploadServices.maybeInstance?.pause,
  );
}
