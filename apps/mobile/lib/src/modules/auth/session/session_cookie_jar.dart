import "dart:convert";
import "dart:io" show Cookie;

import "package:stera/src/modules/auth/session/backend_origin.dart";
import "package:stera/src/modules/auth/session/secret_store.dart";

/// One stored Better Auth cookie. Values are credentials: [toString] redacts.
class StoredCookie {
  const StoredCookie({
    required this.name,
    required this.value,
    required this.path,
    required this.secure,
    required this.httpOnly,
    this.expiresAt,
  });

  final String name;
  final String value;
  final String path;
  final bool secure;
  final bool httpOnly;

  /// Null for a session cookie (no Max-Age/Expires).
  final DateTime? expiresAt;

  bool isExpired(DateTime now) => expiresAt != null && !expiresAt!.isAfter(now);

  Map<String, Object?> toJson() => {
    "name": name,
    "value": value,
    "path": path,
    "secure": secure,
    "httpOnly": httpOnly,
    "expiresAt": expiresAt?.toUtc().toIso8601String(),
  };

  static StoredCookie? fromJson(Object? raw) {
    if (raw is! Map) return null;
    final name = raw["name"];
    final value = raw["value"];
    final path = raw["path"];
    if (name is! String || value is! String || path is! String) return null;
    final expires = raw["expiresAt"];
    return StoredCookie(
      name: name,
      value: value,
      path: path,
      secure: raw["secure"] == true,
      httpOnly: raw["httpOnly"] == true,
      expiresAt: expires is String ? DateTime.tryParse(expires) : null,
    );
  }

  @override
  String toString() => "StoredCookie($name, path=$path, value=<redacted>)";
}

/// Why a `Set-Cookie` value was not stored. Exposed for tests/diagnostics; it
/// never includes the cookie value.
enum CookieRejection {
  foreignOrigin,
  unparseable,
  foreignDomain,
  secureOverHttp,
  invalidPrefix,

  /// The jar was cleared (logout/account switch) after the request started;
  /// a late response must not reinstall credentials.
  staleGeneration,
}

/// Cookie jar bound to a single exact [BackendOrigin].
///
/// - Accepts `Set-Cookie` only from responses of that origin; host-only
///   semantics (a `Domain` attribute other than the exact host is rejected).
/// - Applies `Max-Age`/`Expires`, including deletion (`Max-Age=0`, past
///   `Expires`), path scoping, `Secure`, `__Secure-` and `__Host-` rules.
/// - Sends cookies only to requests on the exact origin (scheme+host+port).
/// - Persists solely through [SecretStore] (OS secure storage in the app). The
///   persisted record carries the origin; a record for another origin is
///   discarded on load, so changing the configured backend never replays an
///   old session elsewhere.
class SessionCookieJar {
  SessionCookieJar({
    required this.origin,
    required SecretStore store,
    DateTime Function()? clock,
  }) : _store = store,
       _clock = clock ?? DateTime.now;

  final BackendOrigin origin;
  final SecretStore _store;
  final DateTime Function() _clock;

  final Map<String, StoredCookie> _cookies = <String, StoredCookie>{};
  int _generation = 0;
  Future<void> _tail = Future<void>.value();

  /// Incremented by every [clear]. Callers capture it before a request and
  /// pass it to [ingest]/[clearIfGeneration] so a late response from an older
  /// session can neither reinstall cookies nor wipe a newer session.
  int get generation => _generation;

  /// Serializes store writes so a clear can never be overtaken by an earlier
  /// persist that completes later.
  Future<T> _serial<T>(Future<T> Function() body) {
    final run = _tail.then((_) => body());
    _tail = run.then<void>((_) {}, onError: (_) {});
    return run;
  }

  static String _key(String name, String path) => "$name|$path";

  Future<void>? _loading;

  /// Loads the persisted record once. Concurrent callers share one Future, so
  /// a [clear] issued during startup waits for the read and then wins; a read
  /// that completes after a clear is discarded by the generation fence.
  Future<void> load() => _loading ??= _load();

  Future<void> _load() async {
    final generation = _generation;
    final String? raw;
    try {
      raw = await _store.read(SecretKeys.sessionCookies);
    } catch (_) {
      // Fail closed: unreadable storage means no session.
      return;
    }
    if (raw == null || generation != _generation) return;
    try {
      final decoded = jsonDecode(raw);
      if (decoded is! Map || decoded["origin"] != origin.value) {
        await _serial(() => _store.delete(SecretKeys.sessionCookies));
        return;
      }
      final list = decoded["cookies"];
      if (list is! List) return;
      final now = _clock();
      for (final entry in list) {
        final cookie = StoredCookie.fromJson(entry);
        if (cookie == null || cookie.isExpired(now)) continue;
        _cookies[_key(cookie.name, cookie.path)] = cookie;
      }
    } on FormatException {
      await _serial(() => _store.delete(SecretKeys.sessionCookies));
    }
  }

  /// Live (unexpired) cookies. For tests and state checks; never log values.
  Future<List<StoredCookie>> cookies() async {
    await load();
    final now = _clock();
    return _cookies.values.where((c) => !c.isExpired(now)).toList();
  }

  Future<bool> get hasCredentials async => (await cookies()).isNotEmpty;

  /// Stores/rotates/deletes cookies from one response. Returns the rejections
  /// (empty when every header was applied).
  Future<List<CookieRejection>> ingest(
    Uri responseUri,
    Iterable<String> setCookieHeaders, {
    int? expectedGeneration,
  }) async {
    await load();
    final headers = setCookieHeaders.toList();
    if (headers.isEmpty) return const [];
    if (expectedGeneration != null && expectedGeneration != _generation) {
      return List.filled(headers.length, CookieRejection.staleGeneration);
    }
    if (!origin.matches(responseUri)) {
      return List.filled(headers.length, CookieRejection.foreignOrigin);
    }
    final now = _clock();
    final rejections = <CookieRejection>[];
    var changed = false;
    for (final header in headers) {
      final Cookie parsed;
      try {
        parsed = Cookie.fromSetCookieValue(header);
      } catch (_) {
        rejections.add(CookieRejection.unparseable);
        continue;
      }
      final problem = _validate(parsed);
      if (problem != null) {
        rejections.add(problem);
        continue;
      }
      final path = (parsed.path == null || !parsed.path!.startsWith("/"))
          ? _defaultPath(responseUri)
          : parsed.path!;
      final key = _key(parsed.name, path);
      final DateTime? expiresAt;
      if (parsed.maxAge != null) {
        expiresAt = now.add(Duration(seconds: parsed.maxAge!));
      } else {
        expiresAt = parsed.expires;
      }
      if (parsed.maxAge != null && parsed.maxAge! <= 0 ||
          expiresAt != null && !expiresAt.isAfter(now)) {
        changed = _cookies.remove(key) != null || changed;
        continue;
      }
      _cookies[key] = StoredCookie(
        name: parsed.name,
        value: parsed.value,
        path: path,
        secure: parsed.secure,
        httpOnly: parsed.httpOnly,
        expiresAt: expiresAt,
      );
      changed = true;
    }
    if (changed) await _persist();
    return rejections;
  }

  CookieRejection? _validate(Cookie cookie) {
    final domain = cookie.domain?.toLowerCase();
    if (domain != null && domain.isNotEmpty) {
      final bare = domain.startsWith(".") ? domain.substring(1) : domain;
      if (bare != origin.host) return CookieRejection.foreignDomain;
    }
    if (cookie.secure && !origin.isSecure) {
      return CookieRejection.secureOverHttp;
    }
    if (cookie.name.startsWith("__Secure-") && !cookie.secure) {
      return CookieRejection.invalidPrefix;
    }
    if (cookie.name.startsWith("__Host-") &&
        (!cookie.secure ||
            (domain != null && domain.isNotEmpty) ||
            cookie.path != "/")) {
      return CookieRejection.invalidPrefix;
    }
    return null;
  }

  static String _defaultPath(Uri uri) {
    final path = uri.path;
    if (path.isEmpty || !path.startsWith("/")) return "/";
    final last = path.lastIndexOf("/");
    return last <= 0 ? "/" : path.substring(0, last);
  }

  static bool _pathMatches(String requestPath, String cookiePath) {
    final request = requestPath.isEmpty ? "/" : requestPath;
    if (request == cookiePath) return true;
    if (!request.startsWith(cookiePath)) return false;
    return cookiePath.endsWith("/") || request[cookiePath.length] == "/";
  }

  /// `Cookie` header for [requestUri], or null when it is not on the exact
  /// backend origin or no cookie applies.
  Future<String?> cookieHeaderFor(Uri requestUri) async {
    await load();
    if (!origin.matches(requestUri)) return null;
    final now = _clock();
    final applicable =
        _cookies.values
            .where(
              (c) =>
                  !c.isExpired(now) &&
                  (!c.secure || requestUri.scheme == "https") &&
                  _pathMatches(requestUri.path, c.path),
            )
            .toList()
          ..sort((a, b) => b.path.length.compareTo(a.path.length));
    if (applicable.isEmpty) return null;
    return applicable.map((c) => "${c.name}=${c.value}").join("; ");
  }

  /// Removes every cookie immediately (in memory) and from secure storage.
  Future<void> clear() async {
    await load();
    _generation++;
    _cookies.clear();
    await _serial(() => _store.delete(SecretKeys.sessionCookies));
  }

  /// Clears only if no other clear happened since [generation] was captured.
  Future<bool> clearIfGeneration(int generation) async {
    if (generation != _generation) return false;
    await clear();
    return true;
  }

  Future<void> _persist() {
    final now = _clock();
    _cookies.removeWhere((_, c) => c.isExpired(now));
    // Snapshot synchronously: the serialized write reflects the jar as of
    // this change, and a later clear is queued behind it.
    final snapshot = _cookies.isEmpty
        ? null
        : jsonEncode({
            "origin": origin.value,
            "cookies": _cookies.values.map((c) => c.toJson()).toList(),
          });
    return _serial(
      () => snapshot == null
          ? _store.delete(SecretKeys.sessionCookies)
          : _store.write(SecretKeys.sessionCookies, snapshot),
    );
  }
}
