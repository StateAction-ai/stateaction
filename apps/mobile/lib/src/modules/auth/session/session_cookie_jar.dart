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
  bool _loaded = false;

  static String _key(String name, String path) => "$name|$path";

  Future<void> load() async {
    if (_loaded) return;
    _loaded = true;
    final raw = await _store.read(SecretKeys.sessionCookies);
    if (raw == null) return;
    try {
      final decoded = jsonDecode(raw);
      if (decoded is! Map || decoded["origin"] != origin.value) {
        await _store.delete(SecretKeys.sessionCookies);
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
      await _store.delete(SecretKeys.sessionCookies);
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
    Iterable<String> setCookieHeaders,
  ) async {
    await load();
    final headers = setCookieHeaders.toList();
    if (headers.isEmpty) return const [];
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

  Future<void> clear() async {
    await load();
    _cookies.clear();
    await _store.delete(SecretKeys.sessionCookies);
  }

  Future<void> _persist() async {
    final now = _clock();
    _cookies.removeWhere((_, c) => c.isExpired(now));
    if (_cookies.isEmpty) {
      await _store.delete(SecretKeys.sessionCookies);
      return;
    }
    await _store.write(
      SecretKeys.sessionCookies,
      jsonEncode({
        "origin": origin.value,
        "cookies": _cookies.values.map((c) => c.toJson()).toList(),
      }),
    );
  }
}
