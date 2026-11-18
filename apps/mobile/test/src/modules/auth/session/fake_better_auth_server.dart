import "dart:convert";
import "dart:io";
import "dart:math";

import "package:uuid/uuid.dart";

/// Ephemeral loopback HTTP fixture with Better Auth-like cookie semantics and
/// the published `http.me.v1` response inside `http.success-envelope.v1`.
///
/// It is a deterministic test double for the client's cookie/role/expiry
/// handling only. It is NOT the real Better Auth server and proves nothing
/// about Google OAuth, audience/nonce checks or the real backend.
class FakeBetterAuthServer {
  FakeBetterAuthServer._(this._server) : port = _server.port;

  final HttpServer _server;

  /// Cached so the origin stays usable after [close] (offline simulations).
  final int port;
  static const String cookieName = "better-auth.session_token";
  static const String dataCookieName = "better-auth.session_data";

  final Map<String, FakeUser> users = {};
  final Map<String, FakeSession> sessions = {};
  final List<RecordedRequest> requests = [];
  final Random _random = Random(7);

  /// When true the next `/api/v1/me` re-issues the session cookie (refresh
  /// window), extending its Max-Age.
  bool reissueOnNextMe = false;

  /// When set, the next `/api/v1/me` 200 answers with this raw `data` value
  /// instead of the identity document (contract negative cases).
  Object? meDataOverrideOnce;

  /// Optional `/api/v1` routes beyond `/me` for upload-workflow tests. Called
  /// only for an authenticated session; return null for 404. `data` becomes
  /// the success envelope payload (or the error body when [status] >= 400).
  ({int status, Object? data})? Function(
    String method,
    String path,
    String body,
    Map<String, String> headers,
  )?
  apiRoutes;

  /// Overrides the status code of the next request when set.
  int? failNextWith;

  /// Called after each request is recorded (headers only, never values of
  /// credentials are printed by the standalone runner).
  void Function(RecordedRequest request)? onRequest;

  static Future<FakeBetterAuthServer> start({int port = 0}) async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, port);
    final fake = FakeBetterAuthServer._(server);
    server.listen(fake._handle);
    return fake;
  }

  String get origin => "http://127.0.0.1:$port";

  Future<void> close() => _server.close(force: true);

  FakeUser addUser(
    String email, {
    required String id,
    String status = "active",
    List<String> roles = const ["collector"],
  }) => users[email] = FakeUser(
    id,
    email,
    "correct horse battery",
    status,
    roles,
  );

  void expireAllSessions() {
    for (final s in sessions.values) {
      s.expiresAt = DateTime.now().subtract(const Duration(seconds: 1));
    }
  }

  Future<void> _handle(HttpRequest request) async {
    final body = await utf8.decoder.bind(request).join();
    requests.add(
      RecordedRequest(request.method, request.uri.path, {
        for (final name in [
          "cookie",
          "authorization",
          "origin",
          "x-stateaction-client",
          "content-type",
        ])
          if (request.headers.value(name) != null)
            name: request.headers.value(name)!,
      }),
    );
    onRequest?.call(requests.last);
    final response = request.response;
    response.headers.set("cache-control", "private, no-store, max-age=0");
    final forced = failNextWith;
    if (forced != null) {
      failNextWith = null;
      response.statusCode = forced;
      response.write(
        jsonEncode({
          "error": {"code": "internal", "message": "x"},
        }),
      );
      await response.close();
      return;
    }
    final key = "${request.method} ${request.uri.path}";
    switch (key) {
      case "POST /api/auth/sign-in/email":
        await _signIn(request, response, body);
      case "GET /api/v1/me":
        await _me(request, response);
      case "GET /api/auth/get-session":
        final session = _session(request, response);
        response.headers.contentType = ContentType.json;
        response.write(
          jsonEncode(
            session == null
                ? null
                : {
                    "session": {"id": session.token},
                  },
          ),
        );
        await response.close();
      case "POST /api/auth/sign-out":
        await _signOut(request, response);
      default:
        final routes = apiRoutes;
        if (routes != null && request.uri.path.startsWith("/api/v1/")) {
          final session = _session(request, response);
          if (session == null) {
            response.statusCode = 401;
            response.write(
              jsonEncode({
                "error": {"code": "unauthenticated"},
              }),
            );
            await response.close();
            return;
          }
          final routed = routes(request.method, request.uri.path, body, {
            for (final name in ["accept", "content-type", "authorization"])
              if (request.headers.value(name) != null)
                name: request.headers.value(name)!,
          });
          if (routed != null) {
            response.statusCode = routed.status;
            response.headers.contentType = ContentType.json;
            response.write(
              jsonEncode(
                routed.status >= 400
                    ? routed.data
                    : {"data": routed.data, "requestId": const Uuid().v4()},
              ),
            );
            await response.close();
            return;
          }
        }
        response.statusCode = 404;
        await response.close();
    }
  }

  void _setSessionCookies(HttpResponse response, String token, int maxAge) {
    response.headers.add(
      "set-cookie",
      "$cookieName=$token.sig; Max-Age=$maxAge; Path=/; HttpOnly; SameSite=Lax",
    );
    response.headers.add(
      "set-cookie",
      "$dataCookieName=cache-$token; Max-Age=$maxAge; Path=/; HttpOnly; SameSite=Lax",
    );
  }

  void _clearSessionCookies(HttpResponse response) {
    response.headers.add(
      "set-cookie",
      "$cookieName=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax",
    );
    response.headers.add(
      "set-cookie",
      "$dataCookieName=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax",
    );
  }

  Future<void> _signIn(
    HttpRequest r,
    HttpResponse response,
    String body,
  ) async {
    final json = jsonDecode(body) as Map<String, dynamic>;
    final user = users[json["email"]];
    response.headers.contentType = ContentType.json;
    if (user == null || user.password != json["password"]) {
      response.statusCode = 401;
      response.write(
        jsonEncode({
          "code": "INVALID_EMAIL_OR_PASSWORD",
          "message": "Invalid email or password",
        }),
      );
      await response.close();
      return;
    }
    final token = List.generate(
      24,
      (_) => _random.nextInt(36).toRadixString(36),
    ).join();
    sessions[token] = FakeSession(
      token,
      user.id,
      DateTime.now().add(const Duration(days: 7)),
    );
    _setSessionCookies(response, token, 604800);
    // Real Better Auth also returns the token in the body; clients must not
    // log or persist it.
    response.write(
      jsonEncode({
        "redirect": false,
        "token": token,
        "user": {"id": user.id, "email": user.email},
      }),
    );
    await response.close();
  }

  FakeSession? _session(HttpRequest r, HttpResponse response) {
    final header = r.headers.value("cookie") ?? "";
    final match = RegExp("$cookieName=([^;.]+)\\.sig").firstMatch(header);
    if (match == null) return null;
    final session = sessions[match.group(1)];
    if (session == null) return null;
    if (!session.expiresAt.isAfter(DateTime.now())) {
      sessions.remove(session.token);
      _clearSessionCookies(response);
      return null;
    }
    return session;
  }

  Future<void> _me(HttpRequest r, HttpResponse response) async {
    response.headers.contentType = ContentType.json;
    if (r.headers.value("authorization") != null) {
      response.statusCode = 401;
      response.write(
        jsonEncode({
          "error": {"code": "unauthenticated"},
        }),
      );
      await response.close();
      return;
    }
    final session = _session(r, response);
    if (session == null) {
      response.statusCode = 401;
      response.write(
        jsonEncode({
          "error": {"code": "unauthenticated"},
        }),
      );
      await response.close();
      return;
    }
    if (reissueOnNextMe) {
      reissueOnNextMe = false;
      session.expiresAt = DateTime.now().add(const Duration(days: 7));
      _setSessionCookies(response, session.token, 604800);
    }
    final user = users.values.firstWhere((u) => u.id == session.userId);
    final override = meDataOverrideOnce;
    meDataOverrideOnce = null;
    response.write(
      jsonEncode({
        "data":
            override ??
            {
              "user": {"id": user.id, "email": user.email, "name": "Fixture"},
              "access": {
                "status": user.status,
                "roles": user.status == "active" ? user.roles : <String>[],
              },
              "session": {
                "expiresAt": session.expiresAt.toUtc().toIso8601String(),
              },
            },
        "requestId": const Uuid().v4(),
      }),
    );
    await response.close();
  }

  Future<void> _signOut(HttpRequest r, HttpResponse response) async {
    final hasCookie = (r.headers.value("cookie") ?? "").isNotEmpty;
    if (hasCookie && r.headers.value("origin") != origin) {
      response.statusCode = 403;
      await response.close();
      return;
    }
    final session = _session(r, response);
    if (session != null) sessions.remove(session.token);
    _clearSessionCookies(response);
    response.headers.contentType = ContentType.json;
    response.write(jsonEncode({"success": true}));
    await response.close();
  }
}

class FakeUser {
  FakeUser(this.id, this.email, this.password, this.status, this.roles);
  final String id;
  final String email;
  final String password;
  String status;
  List<String> roles;
}

class FakeSession {
  FakeSession(this.token, this.userId, this.expiresAt);
  final String token;
  final String userId;
  DateTime expiresAt;
}

class RecordedRequest {
  RecordedRequest(this.method, this.path, this.headers);
  final String method;
  final String path;
  final Map<String, String> headers;
}
