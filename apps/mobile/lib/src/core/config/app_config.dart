import "package:flutter/foundation.dart";
import "package:flutter_dotenv/flutter_dotenv.dart";
import "package:stera/src/modules/auth/session/backend_origin.dart";

class AppConfig {
  static ConfigModel? _configCache;

  /// Never throws and parses at most once.
  ///
  /// Reading before [dotenv.load] is a real case ([FeatureGates],
  /// `ErrorWidget.builder`), so an uninitialized dotenv yields an empty model
  /// **without** poisoning the cache — the `isInitialized` short-circuit has to
  /// come before the cache write, or a single pre-load read would freeze an
  /// empty model for the rest of the process.
  static ConfigModel get config {
    if (!dotenv.isInitialized) return ConfigModel.fromMap(const {});
    return _configCache ??= ConfigModel.fromMap(dotenv.env);
  }

  @visibleForTesting
  static void debugResetConfigCache() => _configCache = null;

  /// Overrides the flag in tests, which run without a loaded `.env`.
  /// Mirrors [FeatureGates.debugOverrideIsProd].
  @visibleForTesting
  static bool? debugOverrideNoAuthMode;

  /// Auth-free capture build: no login, no onboarding, no Better Auth, no
  /// upload, no network — just record, preview and recorder settings.
  ///
  /// Read from `main()` before any provider exists and from `build()` methods,
  /// so it must never throw, and it deliberately reads the raw dotenv map
  /// rather than [config] so it has no dependency on [ConfigModel] parsing.
  ///
  /// Fails **closed**: an unreadable `.env` yields the normal authenticated
  /// app. A build that silently became a different product with no session
  /// would be a far worse failure than a login screen the user didn't expect.
  static bool get noAuthMode {
    if (debugOverrideNoAuthMode != null) return debugOverrideNoAuthMode!;
    if (!dotenv.isInitialized) return false;
    final raw = dotenv.env["NO_AUTH_MODE"]?.trim().toLowerCase();
    return raw == "true" || raw == "1";
  }

  /// Whether this build may expose internal-only surfaces.
  ///
  /// Fails closed when `.env` hasn't loaded: [dotenv] throws on access before
  /// [dotenv.load], and this is read from widget `build()` methods where an
  /// exception would take down the screen. Treating "environment unknown" as
  /// prod also errs in the safe direction — a missing `.env` must never
  /// *reveal* internal surfaces.
  static bool get allowDebugFeatures {
    if (!dotenv.isInitialized) return kDebugMode;
    return config.environment == Environment.dev || kDebugMode;
  }

  /// Exact backend origin (`scheme://host[:port]`) shared by Better Auth
  /// (`/api/auth`) and the API (`/api/v1`). Null when unset or invalid, which
  /// makes every network call fail closed instead of guessing a host.
  static BackendOrigin? get backendOrigin =>
      BackendOrigin.tryParse(switch (config.environment) {
        Environment.dev => config.devBackendOrigin,
        Environment.prod => config.prodBackendOrigin,
      });

  @visibleForTesting
  static bool? debugOverrideLocalPasswordAuth;

  /// Opt-in local email/password sign-in against the same Better Auth
  /// instance (seeded pilot users, no mail service). Off unless `.env` sets
  /// `LOCAL_PASSWORD_AUTH=true`; never implied by environment.
  static bool get localPasswordAuth {
    if (debugOverrideLocalPasswordAuth != null) {
      return debugOverrideLocalPasswordAuth!;
    }
    if (!dotenv.isInitialized) return false;
    final raw = dotenv.env["LOCAL_PASSWORD_AUTH"]?.trim().toLowerCase();
    return raw == "true" || raw == "1";
  }
}

enum Environment { dev, prod }

extension EnvX on Environment {
  String get id {
    switch (this) {
      case Environment.dev:
        return "dev";
      case Environment.prod:
        return "prod";
    }
  }
}

class ConfigModel {
  final Environment environment;
  final String prodBackendOrigin;
  final String devBackendOrigin;
  final String googleWebClientId;
  final String googleIosClientId;

  ConfigModel(
    this.environment,
    this.prodBackendOrigin,
    this.devBackendOrigin,
    this.googleWebClientId,
    this.googleIosClientId,
  );

  factory ConfigModel.fromMap(Map<String, String> map) {
    final environment = Environment.values.firstWhere(
      (e) => e.id == map["ENVIRONMENT"],
      orElse: () => Environment.prod,
    );

    // Missing keys fall back to "" rather than throwing. `NO_AUTH_MODE` builds
    // ship a `.env` holding nothing but the flag, and even in the authed build
    // a missing origin surfaces as a `Failure.networkError()` at request time,
    // which beats a `TypeError` thrown out of a `build()` method at boot.
    return ConfigModel(
      environment,
      map["PROD_BACKEND_ORIGIN"] ?? "",
      map["DEV_BACKEND_ORIGIN"] ?? "",
      map["GOOGLE_WEB_CLIENT_ID"] ?? "",
      map["GOOGLE_IOS_CLIENT_ID"] ?? "",
    );
  }
}
