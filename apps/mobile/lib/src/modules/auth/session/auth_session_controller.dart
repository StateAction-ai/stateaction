import "package:flutter/foundation.dart";
import "package:stera/src/modules/auth/session/auth_http_client.dart";
import "package:stera/src/modules/auth/session/offline_eligibility.dart";
import "package:stera/src/modules/auth/session/server_identity.dart";

/// Session state as the capture/upload owner fence sees it.
sealed class AuthSessionState {
  const AuthSessionState();

  /// Verified immutable owner a new capture would be stamped with, or null
  /// when capture must be refused.
  String? get captureOwnerId;

  /// Owner whose uploads/networking may run now, or null when every owner's
  /// networking is paused.
  String? get networkOwnerId => null;
}

class AuthRestoring extends AuthSessionState {
  const AuthRestoring();
  @override
  String? get captureOwnerId => null;
}

class AuthSignedOut extends AuthSessionState {
  const AuthSignedOut({this.lastSignOut});

  /// Set after an explicit logout. `unconfirmed` means the server could not be
  /// told (offline); local credentials were still removed.
  final SignOutConfirmation? lastSignOut;

  @override
  String? get captureOwnerId => null;
}

/// Server-verified session. Capture and networking only for an active
/// collector.
class AuthActive extends AuthSessionState {
  const AuthActive(this.identity);
  final ServerIdentity identity;

  @override
  String? get captureOwnerId =>
      identity.canCollect ? identity.authUserId : null;

  @override
  String? get networkOwnerId =>
      identity.canCollect ? identity.authUserId : null;
}

/// The server could not verify the session now (offline, or the session
/// expired), but [eligibility] proves the owner was recently an active
/// collector. Capture is allowed for that owner; networking is paused.
class AuthOfflineEligible extends AuthSessionState {
  const AuthOfflineEligible(this.eligibility, {required this.reauthRequired});
  final OfflineEligibility eligibility;

  /// True when the server answered 401 (session ended) rather than being
  /// unreachable. The owner must sign in again before networking resumes.
  final bool reauthRequired;

  @override
  String? get captureOwnerId => eligibility.authUserId;
}

/// Cookies exist but the server could not be reached and there is no prior
/// eligibility. Nothing is authorized until the server answers.
class AuthUnverified extends AuthSessionState {
  const AuthUnverified();
  @override
  String? get captureOwnerId => null;
}

/// Coordinates [AuthHttpClient] and [OfflineEligibilityStore]. No UI imports.
class AuthSessionController extends ChangeNotifier {
  AuthSessionController({
    required AuthHttpClient client,
    required OfflineEligibilityStore eligibility,
    DateTime Function()? clock,
  }) : _client = client,
       _eligibility = eligibility,
       _clock = clock ?? DateTime.now;

  final AuthHttpClient _client;
  final OfflineEligibilityStore _eligibility;
  final DateTime Function() _clock;

  AuthSessionState _state = const AuthRestoring();
  AuthSessionState get state => _state;

  bool _busy = false;
  bool get busy => _busy;

  void _set(AuthSessionState next) {
    _state = next;
    notifyListeners();
  }

  /// Startup: restore cookies and eligibility, then ask the server.
  Future<AuthSessionState> restore() async {
    if (!await _client.jar.hasCredentials) {
      await _fallBackToEligibility(reauthRequired: true);
      return _state;
    }
    return refresh();
  }

  /// Re-reads `/api/v1/me`. Call on startup, resume and after a 401.
  Future<AuthSessionState> refresh() async {
    final result = await _client.fetchMe();
    switch (result) {
      case AuthOk(:final value):
        await _applyIdentity(value);
      case AuthRejected(reason: AuthRejection.unauthenticated):
        // Session ended (expiry or server-side revocation of the session row).
        // Not proof of access revocation, so eligibility survives.
        await _client.jar.clear();
        await _fallBackToEligibility(reauthRequired: true);
      case AuthRejected():
      case AuthUnavailable():
        if (_state case AuthActive(:final identity) when identity.canCollect) {
          final e = await _eligibility.read();
          if (e != null && e.authUserId == identity.authUserId) {
            _set(AuthOfflineEligible(e, reauthRequired: false));
            break;
          }
        }
        await _fallBackToEligibility(reauthRequired: false);
    }
    return _state;
  }

  /// Called by the API layer on a 401 from a human route.
  Future<void> reportUnauthorized() async {
    if (_state is AuthSignedOut) return;
    await _client.jar.clear();
    await _fallBackToEligibility(reauthRequired: true);
  }

  Future<AuthOutcome<ServerIdentity>> signInWithEmail({
    required String email,
    required String password,
  }) => _signIn(() => _client.signInEmail(email: email, password: password));

  Future<AuthOutcome<ServerIdentity>> signInWithIdToken({
    required String provider,
    required String idToken,
    String? nonce,
  }) => _signIn(
    () => _client.signInWithIdToken(
      provider: provider,
      idToken: idToken,
      nonce: nonce,
    ),
  );

  Future<AuthOutcome<ServerIdentity>> _signIn(
    Future<AuthOutcome<void>> Function() exchange,
  ) async {
    if (_busy) {
      return const AuthUnavailable("Sign-in is already in progress.");
    }
    _busy = true;
    notifyListeners();
    try {
      final signedIn = await exchange();
      switch (signedIn) {
        case AuthRejected(:final reason, :final message):
          return AuthRejected(reason, message);
        case AuthUnavailable(:final message, :final offline):
          return AuthUnavailable(message, offline: offline);
        case AuthOk():
          break;
      }
      // Enrollment is decided by the server's /me, never by the sign-in body.
      final me = await _client.fetchMe();
      switch (me) {
        case AuthOk(:final value):
          await _applyIdentity(value);
          return AuthOk(value);
        case AuthRejected(:final reason, :final message):
          await _client.signOut();
          return AuthRejected(reason, message);
        case AuthUnavailable(:final message, :final offline):
          await _client.signOut();
          return AuthUnavailable(message, offline: offline);
      }
    } finally {
      _busy = false;
      notifyListeners();
    }
  }

  /// Explicit logout: pauses networking first, asks the server to revoke,
  /// clears cookies and offline eligibility. Captures and upload journals are
  /// untouched; they stay bound to their owner.
  Future<SignOutConfirmation> logout() async {
    _set(const AuthSignedOut());
    final confirmation = await _client.signOut();
    await _eligibility.clear();
    _set(AuthSignedOut(lastSignOut: confirmation));
    return confirmation;
  }

  Future<void> _applyIdentity(ServerIdentity identity) async {
    // Records eligibility for an active collector; clears it for a pending,
    // disabled or non-collector identity (known revocation).
    await _eligibility.recordVerified(identity, _clock());
    _set(AuthActive(identity));
  }

  Future<void> _fallBackToEligibility({required bool reauthRequired}) async {
    final e = await _eligibility.read();
    if (e != null && e.isFresh(_clock())) {
      _set(AuthOfflineEligible(e, reauthRequired: reauthRequired));
      return;
    }
    if (!reauthRequired && await _client.jar.hasCredentials) {
      _set(const AuthUnverified());
      return;
    }
    _set(const AuthSignedOut());
  }
}
