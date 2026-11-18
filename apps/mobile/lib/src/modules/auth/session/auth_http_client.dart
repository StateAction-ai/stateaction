import "dart:async";
import "dart:convert";
import "dart:io" show SocketException, HandshakeException;

import "package:http/http.dart" as http;
import "package:stera/src/modules/auth/session/backend_origin.dart";
import "package:stera/src/modules/auth/session/server_identity.dart";
import "package:stera/src/modules/auth/session/session_cookie_jar.dart";

/// Result of a Better Auth / `/api/v1` call. Messages are user-safe and never
/// contain request or response bodies, cookies, tokens or passwords.
sealed class AuthOutcome<T> {
  const AuthOutcome();
}

class AuthOk<T> extends AuthOutcome<T> {
  const AuthOk(this.value);
  final T value;
}

enum AuthRejection {
  invalidCredentials,
  unauthenticated,
  forbidden,
  rateLimited,
  invalidRequest,
}

class AuthRejected<T> extends AuthOutcome<T> {
  const AuthRejected(this.reason, this.message);
  final AuthRejection reason;
  final String message;
}

/// The server could not be reached or answered with an unusable response.
/// Callers must treat this as "unknown", never as revocation.
class AuthUnavailable<T> extends AuthOutcome<T> {
  const AuthUnavailable(this.message, {this.offline = false});
  final String message;
  final bool offline;
}

/// Outcome of sign-out: local credentials are always cleared, but the server
/// revocation is only confirmed when the server answered.
enum SignOutConfirmation { confirmed, unconfirmed }

/// A complete `/api/v1` HTTP exchange. Any status is returned; callers decide
/// what it means. Bodies may hold sensitive data: never log them.
class ApiExchange {
  const ApiExchange({
    required this.statusCode,
    required this.bodyBytes,
    required this.jarGeneration,
  });
  final int statusCode;
  final List<int> bodyBytes;

  /// Cookie-jar generation the request was sent with.
  final int jarGeneration;

  bool get isSuccess => statusCode >= 200 && statusCode < 300;
}

/// Small HTTP client for the StateAction Better Auth instance and `/api/v1`.
///
/// - Session transport is the Better Auth cookie only; it never sends an
///   `Authorization` header (human routes reject bearer credentials).
/// - Every response's `Set-Cookie` values are applied to the origin-bound
///   [SessionCookieJar], including error and sign-out responses.
/// - It performs no logging. Sign-in response bodies (which contain a session
///   token) are discarded unread except for error codes.
class AuthHttpClient {
  AuthHttpClient({
    required this.origin,
    required this.jar,
    required this.clientKind,
    http.Client? client,
    this.timeout = const Duration(seconds: 20),
  }) : _client = client ?? http.Client();

  final BackendOrigin origin;
  final SessionCookieJar jar;

  /// `X-StateAction-Client` value (`android`/`ios`/`test`).
  final String clientKind;
  final Duration timeout;
  final http.Client _client;

  static const String clientHeader = "x-stateaction-client";
  static const String authBasePath = "/api/auth";
  static const String apiBasePath = "/api/v1";

  Future<AuthOutcome<void>> signInEmail({
    required String email,
    required String password,
  }) async {
    final result = await _send(
      "POST",
      "$authBasePath/sign-in/email",
      body: {"email": email.trim(), "password": password, "rememberMe": true},
    );
    return _toVoid(result, signIn: true);
  }

  /// Native Google/Apple ID-token exchange via Better Auth `sign-in/social`.
  Future<AuthOutcome<void>> signInWithIdToken({
    required String provider,
    required String idToken,
    String? nonce,
  }) async {
    final result = await _send(
      "POST",
      "$authBasePath/sign-in/social",
      body: {
        "provider": provider,
        "idToken": {"token": idToken, "nonce": ?nonce},
      },
    );
    return _toVoid(result, signIn: true);
  }

  /// Better Auth `get-session`: true when the server still has a session.
  Future<AuthOutcome<bool>> getSession() async {
    final result = await _send("GET", "$authBasePath/get-session");
    switch (result) {
      case _Transport(:final response?):
        if (response.statusCode == 200) {
          final decoded = _decode(response.body);
          return AuthOk(decoded is Map && decoded["session"] != null);
        }
        return _reject(response, signIn: false);
      case _Transport(:final failure):
        return AuthUnavailable(failure!.message, offline: failure.offline);
    }
  }

  /// Server-owned identity, access status and roles.
  Future<AuthOutcome<ServerIdentity>> fetchMe() async {
    final result = await _send("GET", "$apiBasePath/me");
    switch (result) {
      case _Transport(:final response?):
        if (response.statusCode == 200) {
          try {
            return AuthOk(ServerIdentity.fromResponseBytes(response.bodyBytes));
          } on FormatException {
            return const AuthUnavailable("Unexpected identity response");
          }
        }
        return _reject(response, signIn: false);
      case _Transport(:final failure):
        return AuthUnavailable(failure!.message, offline: failure.offline);
    }
  }

  /// Authenticated `/api/v1` control call with the same Better Auth session
  /// cookie as every other call. Same exact origin only, no redirects, no
  /// `Authorization` header, rotated `Set-Cookie` applied under the jar's
  /// generation fence. [expectedJarGeneration] makes the call fail closed with
  /// [AuthUnavailable] when a logout/sign-in happened after the caller decided
  /// to send it. Bodies are small JSON control documents; media bytes never
  /// travel through this client.
  Future<AuthOutcome<ApiExchange>> sendApi(
    String method,
    String path, {
    Map<String, Object?>? jsonBody,
    Map<String, String> headers = const {},
    int? expectedJarGeneration,
  }) async {
    if (!path.startsWith("$apiBasePath/")) {
      throw ArgumentError.value(path, "path", "must be under $apiBasePath");
    }
    if (expectedJarGeneration != null &&
        expectedJarGeneration != jar.generation) {
      return const AuthUnavailable("The session changed; request not sent.");
    }
    final result = await _send(
      method,
      path,
      body: jsonBody,
      extraHeaders: headers,
    );
    switch (result) {
      case _Transport(:final response?):
        return AuthOk(
          ApiExchange(
            statusCode: response.statusCode,
            bodyBytes: response.bodyBytes,
            jarGeneration: result.generation,
          ),
        );
      case _Transport(:final failure):
        return AuthUnavailable(failure!.message, offline: failure.offline);
    }
  }

  /// Clears local cookies immediately (so no later request or late response
  /// can use them), then asks the server to revoke that session.
  Future<SignOutConfirmation> signOut() async {
    final uri = origin.resolve("$authBasePath/sign-out");
    final cookie = await jar.cookieHeaderFor(uri);
    await jar.clear();
    if (cookie == null) return SignOutConfirmation.confirmed;
    final result = await _send(
      "POST",
      "$authBasePath/sign-out",
      body: {},
      cookieOverride: cookie,
      applyCookies: false,
    );
    // 401 means the server already has no session for this cookie.
    final confirmed = switch (result) {
      _Transport(:final response?) =>
        response.statusCode == 200 || response.statusCode == 401,
      _ => false,
    };
    return confirmed
        ? SignOutConfirmation.confirmed
        : SignOutConfirmation.unconfirmed;
  }

  AuthOutcome<void> _toVoid(_Transport result, {required bool signIn}) {
    switch (result) {
      case _Transport(:final response?):
        if (response.statusCode == 200) return const AuthOk(null);
        return _reject(response, signIn: signIn);
      case _Transport(:final failure):
        return AuthUnavailable(failure!.message, offline: failure.offline);
    }
  }

  AuthOutcome<T> _reject<T>(http.Response response, {required bool signIn}) {
    final status = response.statusCode;
    final code = _errorCode(response.body);
    if (status == 401) {
      return signIn
          ? const AuthRejected(
              AuthRejection.invalidCredentials,
              "Email or password is incorrect.",
            )
          : const AuthRejected(
              AuthRejection.unauthenticated,
              "Your session has ended. Sign in again.",
            );
    }
    if (status == 403) {
      return AuthRejected(
        AuthRejection.forbidden,
        code == "EMAIL_NOT_VERIFIED"
            ? "This account is not verified."
            : "This request was refused by the server.",
      );
    }
    if (status == 429) {
      return const AuthRejected(
        AuthRejection.rateLimited,
        "Too many attempts. Wait a moment and try again.",
      );
    }
    if (status == 400 || status == 422) {
      return const AuthRejected(
        AuthRejection.invalidRequest,
        "The server rejected this request.",
      );
    }
    return AuthUnavailable("Server unavailable (HTTP $status).");
  }

  /// Only the machine-readable error code is read from an error body.
  static String? _errorCode(String body) {
    final decoded = _decode(body);
    if (decoded is! Map) return null;
    final error = decoded["error"];
    if (error is Map && error["code"] is String) return error["code"] as String;
    if (decoded["code"] is String) return decoded["code"] as String;
    return null;
  }

  static Object? _decode(String body) {
    if (body.isEmpty) return null;
    try {
      return jsonDecode(body);
    } on FormatException {
      return null;
    }
  }

  Future<_Transport> _send(
    String method,
    String path, {
    Map<String, Object?>? body,
    String? cookieOverride,
    bool applyCookies = true,
    Map<String, String> extraHeaders = const {},
  }) async {
    final generation = jar.generation;
    final uri = origin.resolve(path);
    final request = http.Request(method, uri)
      ..followRedirects = false
      ..headers["accept"] = "application/json"
      ..headers[clientHeader] = clientKind;
    if (method != "GET") {
      // Better Auth refuses cookie-bearing mutations without an Origin; the
      // exact backend origin is always trusted by its own baseURL.
      request.headers["origin"] = origin.value;
      request.headers["content-type"] = "application/json";
      request.body = jsonEncode(body ?? const <String, Object?>{});
    }
    for (final entry in extraHeaders.entries) {
      final name = entry.key.toLowerCase();
      if (name == "cookie" || name == "authorization" || name == "origin") {
        throw ArgumentError.value(entry.key, "headers", "reserved");
      }
      request.headers[name] = entry.value;
    }
    final cookie = cookieOverride ?? await jar.cookieHeaderFor(uri);
    if (cookie != null) request.headers["cookie"] = cookie;

    try {
      final streamed = await _client.send(request).timeout(timeout);
      final response = await http.Response.fromStream(
        streamed,
      ).timeout(timeout);
      if (applyCookies) {
        await jar.ingest(
          uri,
          response.headersSplitValues["set-cookie"] ?? const [],
          expectedGeneration: generation,
        );
      }
      return _Transport(response: response, generation: generation);
    } on TimeoutException {
      return const _Transport(
        failure: _Failure("The server did not respond in time.", offline: true),
      );
    } on SocketException {
      return const _Transport(
        failure: _Failure("You appear to be offline.", offline: true),
      );
    } on HandshakeException {
      return const _Transport(
        failure: _Failure("Secure connection to the server failed."),
      );
    } on http.ClientException {
      return const _Transport(
        failure: _Failure("You appear to be offline.", offline: true),
      );
    }
  }

  void close() => _client.close();
}

class _Failure {
  const _Failure(this.message, {this.offline = false});
  final String message;
  final bool offline;
}

class _Transport {
  const _Transport({this.response, this.failure, this.generation = 0});
  final http.Response? response;
  final _Failure? failure;
  final int generation;
}
