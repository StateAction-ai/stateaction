import "dart:developer";

import "package:stera/src/modules/auth/data/models/user.dart";
import "package:stera/src/modules/auth/session/auth_services.dart";
import "package:stera/src/modules/auth/session/auth_session_controller.dart";
import "package:stera/src/modules/auth/session/server_identity.dart";
import "package:stera/src/services/api/enums/error_type.dart";
import "package:stera/src/services/api/models/api_failure.dart";
import "package:stera/src/services/kv_store/kv_store.dart";

class UserRepo {
  /// App user view of the server-owned identity. Roles/status are copied
  /// from `/api/v1/me`, never derived locally.
  static User fromIdentity(ServerIdentity identity) => User(
    id: identity.authUserId,
    email: identity.email.isEmpty ? null : identity.email,
    phone: null,
    name:
        KvStore.get<String>(KvStoreKeys.localDisplayName) ??
        (identity.name.isEmpty ? null : identity.name),
    platformRole: identity.roles.map((r) => r.name).join(","),
    city: null,
    country: KvStore.get<String>(KvStoreKeys.country),
    age: null,
    isContributor: KvStore.get<bool>(KvStoreKeys.onboardingComplete) ?? false,
    accessStatus: identity.status.name,
  );

  /// Cached view while offline under prior eligibility.
  static User fromOffline(AuthOfflineEligible state) => User(
    id: state.eligibility.authUserId,
    email: state.eligibility.email.isEmpty ? null : state.eligibility.email,
    phone: null,
    name: KvStore.get<String>(KvStoreKeys.localDisplayName),
    city: null,
    country: KvStore.get<String>(KvStoreKeys.country),
    age: null,
    isContributor: KvStore.get<bool>(KvStoreKeys.onboardingComplete) ?? false,
    accessStatus: "offline",
  );

  static Future<void> _cache(User user) async {
    await KvStore.set(KvStoreKeys.profileId, user.id);
    await KvStore.set(KvStoreKeys.user, user.toJson());
  }

  /// Completes onboarding locally. Better Auth `update-user` is disabled on
  /// the pilot server, so the display name and country stay on the device.
  static Future<Failure?> registerContributor({
    required String name,
    required String country,
  }) async {
    await KvStore.set(KvStoreKeys.localDisplayName, name);
    await KvStore.set(KvStoreKeys.country, country);
    await KvStore.set(KvStoreKeys.onboardingComplete, true);
    return null;
  }

  /// Re-reads `/api/v1/me` through the session controller.
  static Future<(User?, Failure?)> getMe() async {
    final services = AuthServices.maybeInstance;
    if (services == null) return (null, Failure.unAuthorized());
    final state = await services.controller.refresh();
    switch (state) {
      case AuthActive(:final identity):
        final user = fromIdentity(identity);
        await _cache(user);
        return (user, null);
      case AuthOfflineEligible():
        return (fromOffline(state), null);
      default:
        return (null, Failure.unAuthorized());
    }
  }

  static Future<(User?, Failure?)> updateProfile({
    String? name,
    String? city,
    String? country,
    int? age,
  }) async {
    if (name != null) await KvStore.set(KvStoreKeys.localDisplayName, name);
    if (country != null) await KvStore.set(KvStoreKeys.country, country);
    final (user, err) = await getMe();
    if (err != null) {
      return (null, Failure(code: ErrorType.unknown, message: err.message));
    }
    return (user, null);
  }

  static Future<User?> loadCachedUser() async {
    try {
      final userJson = KvStore.get<String>(KvStoreKeys.user);
      if (userJson == null) return null;
      return User.fromJson(userJson);
    } catch (e) {
      log("UserRepo: cache parse failed (stale data?), clearing");
      await KvStore.remove(KvStoreKeys.user);
      await KvStore.remove(KvStoreKeys.profileId);
      return null;
    }
  }
}
