import "package:flutter/foundation.dart";
import "package:stera/src/modules/auth/session/auth_http_client.dart";
import "package:stera/src/modules/auth/session/offline_eligibility.dart";
import "package:stera/src/modules/auth/session/server_identity.dart";

/// Session state as the capture/upload owner fence sees it.
///
/// Owner answers are evaluated at call time against [now]: a state that was
/// valid when entered stops authorizing capture/networking once its policy
/// window passes, even if the app never refreshes.
sealed class AuthSessionState {
  const AuthSessionState();

  /// Verified immutable owner a new capture would be stamped with at [now],
  /// or null when capture must be refused.
  String? captureOwnerAt(DateTime now);

  /// Owner whose uploads/networking may run at [now], or null when every
  /// owner's networking is paused.
  String? networkOwnerAt(DateTime now) => null;
}

class AuthRestoring extends AuthSessionState {
  const AuthRestoring();
  @override
  String? captureOwnerAt(DateTime now) => null;
}

class AuthSignedOut extends AuthSessionState {
  const AuthSignedOut({this.lastSignOut});

  /// Set after an explicit logout. `unconfirmed` means the server could not be
  /// told (offline); local credentials were still removed.
  final SignOutConfirmation? lastSignOut;

  @override
  String? captureOwnerAt(DateTime now) => null;
}

/// Server-verified session. Capture and networking only for an active
/// collector, and only inside their time windows.
class AuthActive extends AuthSessionState {
  const AuthActive(this.identity, {required this.verifiedAt});
  final ServerIdentity identity;

  /// Local time `/api/v1/me` last confirmed this identity.
  final DateTime verifiedAt;

  @override
  String? captureOwnerAt(DateTime now) {
    if (!identity.canCollect) return null;
    final age = now.difference(verifiedAt);
    if (age.isNegative || age > OfflineEligibility.maxOfflineAge) return null;
    return identity.authUserId;
  }

  @override
  String? networkOwnerAt(DateTime now) {
    if (!identity.canCollect) return null;
    if (now.isBefore(verifiedAt)) return null;
    final expires = identity.sessionExpiresAt;
    if (expires != null && !now.isBefore(expires)) return null;
    return identity.authUserId;
  }
}

/// The server could not verify the session now (offline, or the session
/// expired), but [eligibility] proves the owner was recently an active
/// collector. Capture is allowed for that owner while fresh; networking is
/// paused.
class AuthOfflineEligible extends AuthSessionState {
  const AuthOfflineEligible(this.eligibility, {required this.reauthRequired});
  final OfflineEligibility eligibility;

  /// True when the server answered 401 (session ended) rather than being
  /// unreachable. The owner must sign in again before networking resumes.
  final bool reauthRequired;

  @override
  String? captureOwnerAt(DateTime now) =>
      eligibility.isFresh(now) ? eligibility.authUserId : null;
}

/// Cookies exist but the server could not be reached and there is no prior
/// eligibility. Nothing is authorized until the server answers.
class AuthUnverified extends AuthSessionState {
  const AuthUnverified();
  @override
  String? captureOwnerAt(DateTime now) => null;
}

/// Coordinates [AuthHttpClient] and [OfflineEligibilityStore]. No UI imports.
///
/// Concurrency: every sign-in and logout starts a new auth epoch. A refresh or
/// sign-in whose epoch is no longer current when its response arrives is
/// discarded, so a late response can never resurrect a logged-out session,
/// reinstall eligibility or replace a newer account. Cookie writes are
/// fenced separately by [SessionCookieJar.generation].
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

  int _epoch = 0;

  /// Current auth epoch (for tests and diagnostics).
  int get epoch => _epoch;

  bool _busy = false;
  bool get busy => _busy;

  DateTime now() => _clock();

  /// Owner checks at the current clock.
  String? get captureOwnerId => _state.captureOwnerAt(_clock());
  String? get networkOwnerId => _state.networkOwnerAt(_clock());

  void _set(AuthSessionState next) {
    _state = next;
    notifyListeners();
  }

  /// Startup: restore cookies and eligibility, then ask the server.
  Future<AuthSessionState> restore() async {
    final epoch = _epoch;
    final hasCredentials = await _client.jar.hasCredentials;
    // A logout/sign-in during startup owns the state now.
    if (epoch != _epoch) return _state;
    if (!hasCredentials) {
      await _fallBackToEligibility(epoch, reauthRequired: true);
      return _state;
    }
    return _refresh(epoch);
  }

  /// Re-reads `/api/v1/me`. Call on startup, resume and after a 401.
  Future<AuthSessionState> refresh() => _refresh(_epoch);

  Future<AuthSessionState> _refresh(int epoch) async {
    if (epoch != _epoch) return _state;
    final generation = _client.jar.generation;
    final result = await _client.fetchMe();
    if (epoch != _epoch) return _state;
    switch (result) {
      case AuthOk(:final value):
        await _applyIdentity(epoch, value);
      case AuthRejected(reason: AuthRejection.unauthenticated):
        // Session ended (expiry or server-side revocation of the session row).
        // Not proof of access revocation, so eligibility survives. Only clear
        // the cookies this request actually used.
        await _client.jar.clearIfGeneration(generation);
        await _fallBackToEligibility(epoch, reauthRequired: true);
      case AuthRejected():
      case AuthUnavailable():
        final current = _state;
        if (current is AuthActive && current.identity.canCollect) {
          final e = await _eligibility.read();
          if (epoch != _epoch) return _state;
          if (e != null &&
              e.authUserId == current.identity.authUserId &&
              e.isFresh(_clock())) {
            _set(AuthOfflineEligible(e, reauthRequired: false));
            break;
          }
        }
        await _fallBackToEligibility(epoch, reauthRequired: false);
    }
    return _state;
  }

  /// Called by the API layer on a 401 from a human route. [generation] is the
  /// jar generation the failing request used; a 401 from an older session
  /// (before logout/account switch) is ignored.
  Future<void> reportUnauthorized({int? generation}) async {
    final epoch = _epoch;
    if (_state is AuthSignedOut) return;
    final cleared = await _client.jar.clearIfGeneration(
      generation ?? _client.jar.generation,
    );
    if (!cleared || epoch != _epoch) return;
    await _fallBackToEligibility(epoch, reauthRequired: true);
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
    final epoch = ++_epoch;
    _busy = true;
    notifyListeners();
    try {
      // A previous session is revoked and its cookies dropped first, so no
      // response from it can land in the new account's jar.
      if (await _client.jar.hasCredentials) await _client.signOut();
      if (epoch != _epoch) return _superseded();
      final signedIn = await exchange();
      if (epoch != _epoch) return _superseded();
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
      if (epoch != _epoch) return _superseded();
      switch (me) {
        case AuthOk(:final value):
          final applied = await _applyIdentity(epoch, value);
          return applied ? AuthOk(value) : _superseded();
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

  static AuthOutcome<ServerIdentity> _superseded() =>
      const AuthUnavailable("Sign-in was cancelled by a newer action.");

  /// Explicit logout: pauses networking and drops cookies immediately, asks
  /// the server to revoke, and clears offline eligibility. Captures and upload
  /// journals are untouched; they stay bound to their owner.
  Future<SignOutConfirmation> logout() async {
    ++_epoch;
    _set(const AuthSignedOut());
    final signOut = _client.signOut();
    final clearEligibility = _eligibility.clear();
    final confirmation = await signOut;
    await clearEligibility;
    if (_state is AuthSignedOut) {
      _set(AuthSignedOut(lastSignOut: confirmation));
    }
    return confirmation;
  }

  /// Returns false when the epoch moved on while persisting.
  Future<bool> _applyIdentity(int epoch, ServerIdentity identity) async {
    final at = _clock();
    // Records eligibility for an active collector; clears it for a pending,
    // disabled or non-collector identity (known revocation).
    await _eligibility.recordVerified(identity, at);
    if (epoch != _epoch) {
      // A logout/sign-in raced this write. Its clear is serialized after the
      // write, but re-clear defensively unless a newer identity owns it.
      if (_state is AuthSignedOut) await _eligibility.clear();
      return false;
    }
    _set(AuthActive(identity, verifiedAt: at));
    return true;
  }

  Future<void> _fallBackToEligibility(
    int epoch, {
    required bool reauthRequired,
  }) async {
    final e = await _eligibility.read();
    final hasCredentials = await _client.jar.hasCredentials;
    if (epoch != _epoch) return;
    if (e != null && e.isFresh(_clock())) {
      _set(AuthOfflineEligible(e, reauthRequired: reauthRequired));
      return;
    }
    if (!reauthRequired && hasCredentials) {
      _set(const AuthUnverified());
      return;
    }
    _set(const AuthSignedOut());
  }
}
