import "dart:convert";
import "dart:developer" as dev;
import "dart:math";

import "package:crypto/crypto.dart";
import "package:google_sign_in/google_sign_in.dart";
import "package:sign_in_with_apple/sign_in_with_apple.dart";
import "package:stera/src/core/config/app_config.dart";
import "package:stera/src/modules/auth/helpers/auth_helper.dart";
import "package:stera/src/modules/auth/session/auth_http_client.dart";
import "package:stera/src/modules/auth/session/auth_services.dart";
import "package:stera/src/modules/auth/session/server_identity.dart";
import "package:stera/src/services/api/enums/error_type.dart";
import "package:stera/src/services/api/models/api_failure.dart";
import "package:stera/src/services/kv_store/kv_store.dart";

class AuthRepo {
  static final GoogleSignIn googleSignIn = GoogleSignIn.instance;

  /// Nonce handed to Google, stored between authenticate() and
  /// signInWithGoogle(). Google echoes it verbatim into the id token's `nonce`
  /// claim and Better Auth compares the two literally, so the same string must
  /// go to both — unlike Apple, there is no hash step here.
  static String? _googleNonce;

  /// Guard against concurrent Google auth flows. A second `authenticate()`
  /// while the first ASWebAuthenticationSession is still alive causes
  /// AppAuth to deliver the OAuth callback to a finalized session and crash
  /// with an `OIDExternalUserAgentSession` NSException.
  static bool _googleAuthInFlight = false;

  static bool get isGoogleAuthInFlight => _googleAuthInFlight;

  static void markGoogleAuthCompleted() {
    _googleAuthInFlight = false;
  }

  static String _generateNonce([int length = 32]) {
    const charset =
        "0123456789ABCDEFGHIJKLMNOPQRSTUVXYZabcdefghijklmnopqrstuvwxyz-._";
    final random = Random.secure();
    return List.generate(
      length,
      (_) => charset[random.nextInt(charset.length)],
    ).join();
  }

  static Future<void> init({String? nonce}) async {
    try {
      await googleSignIn.initialize(
        serverClientId: AppConfig.config.googleWebClientId,
        clientId: AppConfig.config.googleIosClientId,
        nonce: nonce,
      );
    } catch (e) {
      dev.log("Google Sign-In initialization failed: $e");
    }
  }

  /// Maps a session-controller outcome to the app's [Failure]. Messages are
  /// user-safe; no body, cookie, token or password reaches them.
  static Failure? failureOf(AuthOutcome<ServerIdentity> outcome) =>
      switch (outcome) {
        AuthOk() => null,
        AuthRejected(reason: AuthRejection.rateLimited) =>
          Failure.tooManyRequests(),
        AuthRejected(
          reason: AuthRejection.invalidCredentials,
          :final message,
        ) =>
          Failure(code: ErrorType.unauthorized, message: message),
        AuthRejected(:final message) => Failure(
          code: ErrorType.forbidden,
          message: message,
        ),
        AuthUnavailable(offline: true) => Failure.networkError(),
        AuthUnavailable(:final message) => Failure(
          code: ErrorType.serviceUnavailable,
          message: message,
        ),
      };

  static AuthServices? get _services => AuthServices.maybeInstance;

  static Failure _notConfigured() => Failure(
    code: ErrorType.serviceUnavailable,
    message: "The server address is not configured.",
  );

  /// Opt-in local email/password sign-in on the same Better Auth instance.
  static Future<Failure?> signInWithEmail({
    required String email,
    required String password,
  }) async {
    final services = _services;
    if (services == null) return _notConfigured();
    return failureOf(
      await services.controller.signInWithEmail(
        email: email,
        password: password,
      ),
    );
  }

  static Future<Failure?> signInWithGoogle(
    GoogleSignInAuthenticationEvent event,
  ) async {
    _googleAuthInFlight = false;
    try {
      final GoogleSignInAccount? googleUser = switch (event) {
        GoogleSignInAuthenticationEventSignIn(:final user) => user,
        GoogleSignInAuthenticationEventSignOut() => null,
      };

      if (googleUser == null) {
        return Failure(
          code: ErrorType.cancelled,
          message: "Google sign-in was cancelled.",
        );
      }

      final idToken = googleUser.authentication.idToken;
      if (idToken == null) {
        return Failure(
          code: ErrorType.invalidToken,
          message: "Google did not return an ID token.",
        );
      }

      final nonce = _googleNonce;
      _googleNonce = null;

      final services = _services;
      if (services == null) return _notConfigured();
      // Better Auth `sign-in/social` with the native ID token; the server
      // verifies audience and nonce. Roles come from /api/v1/me afterwards.
      return failureOf(
        await services.controller.signInWithIdToken(
          provider: "google",
          idToken: idToken,
          nonce: nonce,
        ),
      );
    } catch (e) {
      dev.log("Error signing in with Google: ${e.runtimeType}");
      return Failure.fromException(e);
    }
  }

  static Future<void> authenticateWithGoogle() async {
    if (_googleAuthInFlight) return;
    _googleAuthInFlight = true;
    try {
      final nonce = _generateNonce();
      _googleNonce = nonce;
      await init(nonce: nonce);
      await googleSignIn.authenticate();
    } catch (e) {
      _googleNonce = null;
      _googleAuthInFlight = false;
      dev.log("Google Sign-In authenticate failed: $e");
    }
  }

  static Future<(String?, Failure?)> signInWithApple() async {
    try {
      // Apple's convention: hand Apple the hash, hand the server the
      // pre-image. Better Auth's apple provider hashes before comparing.
      final rawNonce = _generateNonce();
      final hashedNonce = sha256.convert(utf8.encode(rawNonce)).toString();

      final credential = await SignInWithApple.getAppleIDCredential(
        scopes: [
          AppleIDAuthorizationScopes.email,
          AppleIDAuthorizationScopes.fullName,
        ],
        nonce: hashedNonce,
      );

      final idToken = credential.identityToken;
      if (idToken == null) {
        return (
          null,
          Failure(
            code: ErrorType.invalidToken,
            message: "Apple did not return an ID token.",
          ),
        );
      }

      final services = _services;
      if (services == null) return (null, _notConfigured());
      final failure = failureOf(
        await services.controller.signInWithIdToken(
          provider: "apple",
          idToken: idToken,
          nonce: rawNonce,
        ),
      );

      final appleFullName = [credential.givenName, credential.familyName]
          .whereType<String>()
          .map((s) => s.trim())
          .where((s) => s.isNotEmpty)
          .join(" ");

      if (failure != null) return (null, failure);
      return (appleFullName.isEmpty ? null : appleFullName, null);
    } on SignInWithAppleAuthorizationException catch (e) {
      if (e.code == AuthorizationErrorCode.canceled) {
        return (
          null,
          Failure(
            code: ErrorType.cancelled,
            message: "Apple sign-in was cancelled.",
          ),
        );
      }
      return (null, Failure.fromException(e));
    } catch (e) {
      dev.log("Error signing in with Apple: ${e.runtimeType}");
      return (null, Failure.fromException(e));
    }
  }

  /// Explicit logout. Pauses networking, requests server revocation and
  /// clears cookies plus offline eligibility. Captures, upload journals,
  /// receipts and recorder settings are deliberately preserved and stay bound
  /// to their owner. Returns whether the server confirmed revocation.
  static Future<SignOutConfirmation> logout() async {
    final services = _services;
    final confirmation =
        await services?.controller.logout() ?? SignOutConfirmation.confirmed;
    try {
      await googleSignIn.signOut();
    } catch (e) {
      dev.log("Error signing out from Google: ${e.runtimeType}");
    }
    await AuthHelper.reset();
    await KvStore.remove(KvStoreKeys.user);
    await KvStore.remove(KvStoreKeys.profileId);
    return confirmation;
  }

  /// Account deletion is disabled server-side for the pilot (`/delete-user`
  /// is a disabled Better Auth path); it must be an operator action.
  static Future<Failure?> deleteAccount() async => Failure(
    code: ErrorType.forbidden,
    message: "Contact the StateAction team to delete this account.",
  );
}
