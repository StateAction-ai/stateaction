import "dart:async";
import "dart:developer" as dev;

import "package:flutter/widgets.dart";
import "package:google_sign_in/google_sign_in.dart";
import "package:provider/provider.dart";
import "package:stera/src/core/common/widgets/video_thumbnail/video_thumbnail.dart";
import "package:stera/src/core/router/app_router.dart";
import "package:stera/src/modules/auth/data/models/app_auth_type.dart";
import "package:stera/src/modules/auth/data/models/user.dart";
import "package:stera/src/modules/auth/data/repo/auth_repo.dart";
import "package:stera/src/modules/auth/data/repo/user_repo.dart";
import "package:stera/src/modules/auth/session/auth_http_client.dart";
import "package:stera/src/modules/auth/session/auth_services.dart";
import "package:stera/src/modules/auth/session/auth_session_controller.dart";
import "package:stera/src/modules/upload/providers/upload_provider.dart";
import "package:stera/src/services/api/enums/error_type.dart";
import "package:stera/src/services/api/models/api_failure.dart";
import "package:stera/src/services/kv_store/kv_store.dart";

/// UI-facing auth state, derived from [AuthSessionController].
class AuthProvider extends ChangeNotifier {
  AuthSessionController? _controller;

  User? _user;
  User? get user => _user;
  set user(User? value) {
    _user = value;
    notifyListeners();
  }

  /// True for a server-verified session and for a recently verified owner
  /// who is offline/expired (capture allowed, networking paused).
  bool get isLoggedIn => user != null;

  AuthSessionState get sessionState =>
      _controller?.state ?? const AuthSignedOut();

  /// Networking is paused and a fresh sign-in is needed to resume it.
  bool get reauthRequired => switch (sessionState) {
    AuthOfflineEligible(:final reauthRequired) => reauthRequired,
    _ => false,
  };

  /// Signed in but the server has not granted an active collector role.
  bool get awaitingAccess => switch (sessionState) {
    AuthActive(:final identity) => !identity.canCollect,
    _ => false,
  };

  bool _isNewUser = false;
  bool get isNewUser => _isNewUser;
  set isNewUser(bool value) {
    _isNewUser = value;
    notifyListeners();
  }

  bool _loading = false;
  bool get loading => _loading;
  set loading(bool value) {
    _loading = value;
    notifyListeners();
  }

  /// Name returned by Sign in with Apple on first auth.
  String? _pendingDisplayName;
  String? get pendingDisplayName => _pendingDisplayName;
  set pendingDisplayName(String? value) {
    _pendingDisplayName = value;
    notifyListeners();
  }

  void _attach() {
    final controller = AuthServices.maybeInstance?.controller;
    if (controller == null || identical(controller, _controller)) return;
    _controller?.removeListener(_syncFromSession);
    _controller = controller..addListener(_syncFromSession);
  }

  void _syncFromSession() {
    final state = sessionState;
    _user = switch (state) {
      AuthActive(:final identity) => UserRepo.fromIdentity(identity),
      AuthOfflineEligible() => UserRepo.fromOffline(state),
      _ => null,
    };
    notifyListeners();
  }

  Future<Failure?> onAuth({
    required AppAuthType type,
    GoogleSignInAuthenticationEvent? event,
    String? email,
    String? password,
  }) async {
    _attach();
    loading = true;
    try {
      switch (type) {
        case AppAuthType.google:
          if (event == null) {
            return Failure(
              code: ErrorType.validation,
              message: "Google sign-in event is required.",
            );
          }
          final err = await AuthRepo.signInWithGoogle(event);
          if (err != null) return err;
        case AppAuthType.apple:
          final (appleFullName, err) = await AuthRepo.signInWithApple();
          if (err != null) return err;
          if (appleFullName != null) _pendingDisplayName = appleFullName;
        case AppAuthType.localPassword:
          if (email == null || password == null) {
            return Failure(
              code: ErrorType.validation,
              message: "Email and password are required.",
            );
          }
          final err = await AuthRepo.signInWithEmail(
            email: email,
            password: password,
          );
          if (err != null) return err;
        case AppAuthType.phone:
          return Failure(
            code: ErrorType.validation,
            message: "Phone sign-in is no longer supported.",
          );
      }
      return _afterSignIn();
    } finally {
      loading = false;
    }
  }

  Future<Failure?> _afterSignIn() async {
    _syncFromSession();
    if (_user == null) {
      return Failure(
        code: ErrorType.unknown,
        message: "Could not verify this account. Please try again.",
      );
    }
    isNewUser = !(KvStore.get<bool>(KvStoreKeys.onboardingComplete) ?? false);

    final ctx = AppRouter.navigatorKey.currentContext;
    if (ctx != null && ctx.mounted) {
      unawaited(ctx.read<UploadProvider>().picker.recoverOrphanedSessions());
    }
    return null;
  }

  Future<void> forceRefreshUser() async {
    try {
      final (updatedUser, err) = await UserRepo.getMe();
      if (err != null) return;
      user = updatedUser;
    } catch (e) {
      dev.log("AUTH: forceRefreshUser error: ${e.runtimeType}");
    }
  }

  /// A human route returned 401: pause networking, keep owner data.
  Future<void> onSessionEnded() async {
    _attach();
    await _controller?.reportUnauthorized();
  }

  Future<Failure?> updateCurrentUserProfile({
    String? name,
    String? city,
    String? country,
    int? age,
  }) async {
    if (_user == null) {
      return Failure(code: ErrorType.unknown, message: "User not found");
    }

    final (updatedUser, err) = await UserRepo.updateProfile(
      name: name,
      city: city,
      country: country,
      age: age,
    );

    if (err != null) return err;

    user = updatedUser;
    return null;
  }

  /// Explicit logout. Returns `unconfirmed` when the server could not be
  /// reached; local credentials and offline eligibility are cleared anyway.
  Future<SignOutConfirmation> logout() async {
    _pendingDisplayName = null;
    final confirmation = await AuthRepo.logout();
    user = null;
    isNewUser = false;
    _clearLocalCaches();
    return confirmation;
  }

  Future<Failure?> delete() async {
    if (_user == null) {
      return Failure(code: ErrorType.unknown, message: "User not found");
    }
    return AuthRepo.deleteAccount();
  }

  Future<void> init() async {
    _attach();
    final controller = _controller;
    if (controller == null) return;
    await controller.restore();
    _syncFromSession();
    if (_user != null) {
      isNewUser = !(KvStore.get<bool>(KvStoreKeys.onboardingComplete) ?? false);
    }
  }

  void _clearLocalCaches() {
    VideoThumbnail.clearCache();
    PaintingBinding.instance.imageCache.clear();
    PaintingBinding.instance.imageCache.clearLiveImages();
  }

  /// In-memory reset only (used by [AuthHelper]); never touches the session.
  void reset() {
    _user = null;
    isNewUser = false;
    loading = false;
    _pendingDisplayName = null;
  }

  @override
  void dispose() {
    _controller?.removeListener(_syncFromSession);
    super.dispose();
  }
}
