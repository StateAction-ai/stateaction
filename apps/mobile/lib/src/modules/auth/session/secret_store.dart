import "package:flutter_secure_storage/flutter_secure_storage.dart";

/// Narrow key/value boundary for credentials and owner eligibility.
///
/// Production uses the OS keystore/keychain ([OsSecretStore]). Tests use
/// [MemorySecretStore]. Values written here are never logged, exported to
/// `.env`, cached by Nx or committed.
abstract interface class SecretStore {
  Future<String?> read(String key);
  Future<void> write(String key, String value);
  Future<void> delete(String key);
}

/// `flutter_secure_storage` (Android Keystore-backed AES-GCM, iOS Keychain).
class OsSecretStore implements SecretStore {
  const OsSecretStore([this._storage = const FlutterSecureStorage()]);

  final FlutterSecureStorage _storage;

  @override
  Future<String?> read(String key) => _storage.read(key: key);

  @override
  Future<void> write(String key, String value) =>
      _storage.write(key: key, value: value);

  @override
  Future<void> delete(String key) => _storage.delete(key: key);
}

/// In-process store for tests and the auth-free build. Not durable.
class MemorySecretStore implements SecretStore {
  final Map<String, String> values = <String, String>{};

  @override
  Future<String?> read(String key) async => values[key];

  @override
  Future<void> write(String key, String value) async => values[key] = value;

  @override
  Future<void> delete(String key) async => values.remove(key);
}

/// Persisted key names. Immutable once shipped.
class SecretKeys {
  static const String sessionCookies = "stateaction.auth.session_cookies.v1";

  /// Never deleted on logout: keeps the credential revision monotonic.
  static const String sessionRevisionFloor =
      "stateaction.auth.session_revision.v1";
  static const String offlineEligibility =
      "stateaction.auth.offline_eligibility.v1";
}
