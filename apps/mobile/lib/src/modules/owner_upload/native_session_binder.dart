import "dart:async";
import "package:flutter/foundation.dart";

import "package:stera/src/modules/auth/session/auth_http_client.dart";
import "package:stera/src/modules/auth/session/auth_session_controller.dart";
import "package:stera/src/modules/auth/session/session_cookie_jar.dart";
import "package:stera/src/modules/owner_upload/native_upload_port.dart";
import "package:stera_recorder/stera_recorder.dart";

/// Keeps the native uploader on the same Better Auth session as Dart.
///
/// Dart's [SessionCookieJar] stays the primary store. This class
/// - hands native the jar's cookies (bindOwner) whenever the verified network
///   owner or the jar revision changes;
/// - adopts a newer native snapshot only for the exact verified/offline-cached
///   owner and origin, under the jar generation fence, before a refresh sends
///   the old cookies (see [AuthSessionController.preRefresh]);
/// - on logout or sign-in start, immediately queues `unbindOwner` (never
///   awaited by the user action) so native stops using the old credentials.
///
/// Every native call runs on one serial chain, so an unbind can never be
/// overtaken by an older bind and a late response from an old account cannot
/// install credentials: a bind is skipped when the auth epoch moved on, and the
/// logout/sign-in unbind queued behind it wipes anything that slipped through.
class NativeSessionBinder extends ChangeNotifier {
  NativeSessionBinder({
    required AuthSessionController auth,
    required AuthHttpClient client,
    required NativeUploadPort native,
    bool Function()? enabled,
  }) : _auth = auth,
       _client = client,
       _native = native,
       _enabled = enabled ?? (() => true);

  final AuthSessionController _auth;
  final AuthHttpClient _client;
  final NativeUploadPort _native;
  final bool Function() _enabled;

  Future<void> _tail = Future<void>.value();
  bool _unbindPending = false;
  bool _reconciled = false;
  String? _pushedKey;
  String? _boundOwner;
  int _ownerGeneration = 0;
  bool _attached = false;
  bool _conflict = false;

  /// Auth epoch started by the latest explicit sign-in. A session whose epoch
  /// equals this was just minted by the server; it may replace an older native
  /// copy but must never adopt one.
  int _signInEpoch = -1;

  /// Native holds an incompatible credential set for the current owner (equal
  /// revision with different cookies, or a stale push that could not be
  /// resolved). The owner must sign in again before native uploads resume.
  bool get conflict => _conflict;

  SessionCookieJar get _jar => _client.jar;

  /// The last unbind was not acknowledged (native unreachable or slow). No
  /// bind or enqueue happens until a retry is acknowledged, and a startup
  /// reconcile also retries it.
  bool get unbindPending => _unbindPending;

  void attach() {
    if (_attached) return;
    _attached = true;
    _auth
      ..onSessionEnding = _onEnding
      ..preRefresh = adoptNewerNativeSession
      ..addListener(_onAuthChanged);
  }

  void detach() {
    if (!_attached) return;
    _attached = false;
    _auth
      ..onSessionEnding = null
      ..preRefresh = null
      ..removeListener(_onAuthChanged);
  }

  Future<T> _serial<T>(Future<T> Function() body) {
    final run = _tail.then((_) => body());
    _tail = run.then<void>((_) {}, onError: (_) {});
    return run;
  }

  final List<void Function()> _endingListeners = [];

  /// Called synchronously, before the unbind is queued, at every logout and
  /// sign-in start. Used to cancel in-flight Dart upload steps at once.
  void addEndingListener(void Function() listener) =>
      _endingListeners.add(listener);

  Future<void>? _onEnding(SessionEnding reason) {
    for (final listener in List.of(_endingListeners)) {
      listener();
    }
    // Synchronous part: forget what was bound so nothing is considered current.
    _pushedKey = null;
    _boundOwner = null;
    _conflict = false;
    if (reason == SessionEnding.signInStarting) _signInEpoch = _auth.epoch;
    if (!_enabled()) return null;
    return _invalidateNative();
  }

  /// Sends `unbindOwner` NOW, outside the Dart serial chain: it must not wait
  /// behind a bind/adopt that is in flight, because native commits the owner
  /// generation bump (and so stops every control request and part PUT of the
  /// old owner) when it handles this call. The platform channel preserves
  /// message order, so it still lands after any earlier bind. The serial
  /// chain waits for it, so a later bind can never overtake it. The returned
  /// future completes when native acknowledged (generation committed).
  Future<void> _invalidateNative() {
    _unbindPending = true;
    final Future<void> sent;
    try {
      sent = _native.unbindOwner(fenceRevision: _jar.revision);
    } on Object {
      return Future<void>.value();
    }
    final acknowledged = sent.then<void>((_) {
      _unbindPending = false;
    }, onError: (_) {});
    _tail = _tail.then((_) => acknowledged);
    return acknowledged;
  }

  void _onAuthChanged() {
    if (!_reconciled && _auth.state is! AuthRestoring) {
      _reconciled = true;
      unawaited(reconcileNativeBinding().then<void>((_) {}, onError: (_) {}));
    }
    if (_auth.networkOwnerId == null) return;
    unawaited(pushIfChanged().then<void>((_) {}, onError: (_) {}));
  }

  /// After the session is restored: native must not stay bound to an owner the
  /// Dart session does not stand for (for example a logout whose unbind never
  /// reached native before the process died). Unbinds in that case; journals
  /// are untouched.
  Future<void> reconcileNativeBinding() => _serial(() async {
    if (!_enabled()) return;
    final state = _auth.state;
    final String? dartOwner = switch (state) {
      AuthActive(:final identity) => identity.authUserId,
      AuthOfflineEligible(:final eligibility) => eligibility.authUserId,
      _ => null,
    };
    if (_unbindPending) {
      await _native.unbindOwner(fenceRevision: _jar.revision);
      _unbindPending = false;
      return;
    }
    final export = await _native.exportSession();
    if (export != null && export.ownerId != dartOwner) {
      await _native.unbindOwner(fenceRevision: _jar.revision);
    }
  });

  /// The owner generation native assigned to the last accepted bind for
  /// [ownerId], or null if native is not (known to be) bound to that owner.
  int? ownerGenerationFor(String ownerId) =>
      _boundOwner == ownerId ? _ownerGeneration : null;

  /// Binds the current verified network owner if the owner or jar revision
  /// differs from what native last accepted. Returns the native owner
  /// generation, or null when nothing could be bound.
  Future<int?> pushIfChanged() => _serial(() async {
    if (!_enabled() || _auth.busy) return null;
    if (_unbindPending) {
      // The previous owner's invalidation was never acknowledged: confirm it
      // before any new credential reaches native.
      await _native.unbindOwner(fenceRevision: _jar.revision);
      _unbindPending = false;
    }
    final epoch = _auth.epoch;
    final owner = _auth.networkOwnerId;
    if (owner == null) return null;
    final snap = await _jar.snapshot();
    if (snap.cookies.isEmpty) return null;
    final key = "$owner|${snap.revision}";
    if (key == _pushedKey && _boundOwner == owner) return _ownerGeneration;
    if (epoch != _auth.epoch || _auth.networkOwnerId != owner) return null;
    final cookies = [
      for (final c in snap.cookies)
        NativeSessionCookie(
          name: c.name,
          value: c.value,
          path: c.path,
          secure: c.secure,
          expiresAtMs: c.expiresAt?.millisecondsSinceEpoch,
        ),
    ];
    Future<NativeBindResult> bind() => _native.bindOwner(
      ownerId: owner,
      backendOrigin: _client.origin.value,
      sessionRevision: snap.revision,
      cookies: cookies,
    );
    var result = await bind();
    if (epoch != _auth.epoch) {
      // A logout/sign-in began while the bind was in flight. Its unbind is
      // queued right behind this operation.
      return null;
    }
    if (!result.accepted && result.reason == "invalidation_pending") {
      // Native is still fenced by an earlier invalidation that was not
      // durably acknowledged. Never bind through it: retry the unbind first.
      _unbindPending = true;
      return null;
    }
    if (!result.accepted) {
      if (epoch == _signInEpoch) {
        // Brand-new server session for this owner: whatever native holds is
        // from the revoked one. Wipe it (journals stay) and bind the new one.
        await _native.unbindOwner(fenceRevision: snap.revision - 1);
        if (epoch != _auth.epoch) return null;
        result = await bind();
      } else {
        // Restored session: native may hold a genuinely newer rotation.
        // Adopt it, never overwrite it with an older push.
        final adopted = await _adopt(owner, epoch);
        _conflict = !adopted;
        notifyListeners();
        return null;
      }
      if (!result.accepted) {
        _conflict = true;
        notifyListeners();
        return null;
      }
    }
    _conflict = false;
    _pushedKey = key;
    _boundOwner = owner;
    _ownerGeneration = result.ownerGeneration;
    notifyListeners();
    return _ownerGeneration;
  });

  /// [PreRefreshHook]: before a refresh uses the stored cookies, adopt any
  /// newer native rotation for the exact cached/verified owner.
  Future<void> adoptNewerNativeSession(String? cachedOwnerId) async {
    if (!_enabled() || cachedOwnerId == null) return;
    await _serial(() => _adopt(cachedOwnerId, _auth.epoch));
  }

  Future<bool> _adopt(String owner, int epoch) async {
    final generation = _jar.generation;
    final export = await _native.exportSession();
    if (export == null) return false;
    if (epoch != _auth.epoch || _auth.busy || generation != _jar.generation) {
      return false;
    }
    if (export.ownerId != owner ||
        export.backendOrigin != _client.origin.value ||
        export.sessionRevision <= _jar.revision) {
      return false;
    }
    final ok = await _jar.adoptSnapshot(
      expectedGeneration: generation,
      revision: export.sessionRevision,
      cookies: [
        for (final c in export.cookies)
          StoredCookie(
            name: c.name,
            value: c.value,
            path: c.path,
            secure: c.secure,
            httpOnly: true,
            expiresAt: c.expiresAtMs == null
                ? null
                : DateTime.fromMillisecondsSinceEpoch(
                    c.expiresAtMs!,
                    isUtc: true,
                  ),
          ),
      ],
    );
    if (ok) {
      // The jar now equals native; remember that so we do not push it back.
      _pushedKey = "$owner|${_jar.revision}";
    }
    return ok;
  }
}
