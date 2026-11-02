import "dart:convert";

import "package:stera/src/modules/auth/session/backend_origin.dart";
import "package:stera/src/modules/auth/session/secret_store.dart";
import "package:stera/src/modules/auth/session/server_identity.dart";

/// Proof that the server last saw [authUserId] as an active collector.
///
/// It authorizes local capture (never networking) while the server is
/// unreachable or the session needs renewal. It is bound to the backend origin
/// and cleared on explicit logout or a server answer showing the account is no
/// longer an active collector.
class OfflineEligibility {
  const OfflineEligibility({
    required this.authUserId,
    required this.email,
    required this.verifiedAt,
  });

  final String authUserId;
  final String email;
  final DateTime verifiedAt;

  /// How long after the last server verification an owner may keep capturing
  /// without reaching the server. Matches the seven-day Better Auth session
  /// lifetime; a provisional pilot policy, not a server-enforced value.
  static const Duration maxOfflineAge = Duration(days: 7);

  /// Fresh only for a non-negative age within [maxOfflineAge]. A verification
  /// time in the future (device clock rolled back) fails closed.
  bool isFresh(DateTime now) {
    final age = now.difference(verifiedAt);
    return !age.isNegative && age <= maxOfflineAge;
  }

  @override
  String toString() => "OfflineEligibility(user=<opaque>, at=$verifiedAt)";
}

class OfflineEligibilityStore {
  OfflineEligibilityStore({required this.origin, required SecretStore store})
    : _store = store;

  final BackendOrigin origin;
  final SecretStore _store;
  Future<void> _tail = Future<void>.value();

  /// Serializes reads/writes/clears so a clear issued after a write is always
  /// applied after it, whatever the platform storage ordering.
  Future<T> _serial<T>(Future<T> Function() body) {
    final run = _tail.then((_) => body());
    _tail = run.then<void>((_) {}, onError: (_) {});
    return run;
  }

  Future<OfflineEligibility?> read() => _serial(_read);

  Future<OfflineEligibility?> _read() async {
    final raw = await _store.read(SecretKeys.offlineEligibility);
    if (raw == null) return null;
    try {
      final map = jsonDecode(raw);
      if (map is! Map ||
          map["origin"] != origin.value ||
          map["authUserId"] is! String ||
          map["verifiedAt"] is! String) {
        await _store.delete(SecretKeys.offlineEligibility);
        return null;
      }
      final verifiedAt = DateTime.tryParse(map["verifiedAt"] as String);
      if (verifiedAt == null) {
        await _store.delete(SecretKeys.offlineEligibility);
        return null;
      }
      return OfflineEligibility(
        authUserId: map["authUserId"] as String,
        email: map["email"] is String ? map["email"] as String : "",
        verifiedAt: verifiedAt,
      );
    } on FormatException {
      await _store.delete(SecretKeys.offlineEligibility);
      return null;
    }
  }

  /// Records eligibility only for an active collector; anything else clears.
  Future<OfflineEligibility?> recordVerified(
    ServerIdentity identity,
    DateTime now,
  ) => _serial(() => _record(identity, now));

  Future<OfflineEligibility?> _record(
    ServerIdentity identity,
    DateTime now,
  ) async {
    if (!identity.canCollect) {
      await _store.delete(SecretKeys.offlineEligibility);
      return null;
    }
    final eligibility = OfflineEligibility(
      authUserId: identity.authUserId,
      email: identity.email,
      verifiedAt: now,
    );
    await _store.write(
      SecretKeys.offlineEligibility,
      jsonEncode({
        "origin": origin.value,
        "authUserId": eligibility.authUserId,
        "email": eligibility.email,
        "verifiedAt": now.toUtc().toIso8601String(),
      }),
    );
    return eligibility;
  }

  Future<void> clear() =>
      _serial(() => _store.delete(SecretKeys.offlineEligibility));
}
