import "dart:developer";

import "package:provider/provider.dart";
import "package:stera/src/core/common/widgets/app_toast.dart";
import "package:stera/src/core/config/app_config.dart";
import "package:stera/src/core/router/app_router.dart";
import "package:stera/src/modules/auth/providers/auth_provider.dart";
import "package:stera/src/modules/auth/session/auth_services.dart";
import "package:stera/src/services/api/models/api_failure.dart";

/// Cookie bridge between the origin-bound Better Auth [SessionCookieJar] and
/// the [Api] client. The session cookie is the only human credential: there
/// is no bearer token, and no `Authorization` header is ever produced here.
class TokenService {
  /// `Cookie` header for [uri], or unauthorized when there is no session or
  /// [uri] is not the exact configured backend origin.
  static Future<(Map<String, String>?, Failure?)> getAuthHeaders({
    required Uri uri,
  }) async {
    final services = AuthServices.maybeInstance;
    if (services == null) return (null, Failure.unAuthorized());
    final cookie = await services.jar.cookieHeaderFor(uri);
    if (cookie == null) return (null, Failure.unAuthorized());
    return ({"cookie": cookie}, null);
  }

  /// Applies every `Set-Cookie` the backend returned (rotation and clearing).
  static Future<void> saveCookiesFromResponse(
    Uri uri,
    List<String> setCookieHeaders,
  ) async {
    final services = AuthServices.maybeInstance;
    if (services == null || setCookieHeaders.isEmpty) return;
    await services.jar.ingest(uri, setCookieHeaders);
  }

  /// A human route answered 401: the session ended. This is not a logout:
  /// networking pauses, captures/journals and offline eligibility remain, and
  /// the owner is asked to sign in again.
  static Future<void> handleSessionExpired() async {
    // No session to expire, and `AuthProvider` isn't registered.
    if (AppConfig.noAuthMode) return;

    if (AppRouter.isOnPublicRoute()) {
      log("TokenService: On public route, skipping session expiry handling");
      return;
    }

    final ctx = AppRouter.navigatorKey.currentContext;
    if (ctx != null) {
      await ctx.read<AuthProvider>().onSessionEnded();
    }
    AppToast.show(title: "Session expired. Sign in again to resume uploads.");
  }
}
