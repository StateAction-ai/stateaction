import "dart:convert";

import "package:flutter_test/flutter_test.dart";
import "package:http/http.dart" as http;
import "package:http/testing.dart";
import "package:stera/src/modules/auth/session/auth_http_client.dart";
import "package:stera/src/modules/auth/session/auth_session_controller.dart";
import "package:stera/src/modules/auth/session/backend_origin.dart";
import "package:stera/src/modules/auth/session/offline_eligibility.dart";
import "package:stera/src/modules/auth/session/secret_store.dart";
import "package:stera/src/modules/auth/session/session_cookie_jar.dart";

Map<String, Object?> _me(String id) => {
  "data": {
    "user": {"id": id, "email": "$id@example.test", "name": ""},
    "access": {
      "status": "active",
      "roles": ["collector"],
    },
    "session": {"expiresAt": DateTime.utc(2026, 11, 9).toIso8601String()},
  },
  "requestId": "0b9f1c7e-4d3a-4f6b-9a2e-5c8d7e6f1a20",
};

void main() {
  for (final variant in ["expired", "deleted"]) {
    test("stale 401 after $variant jar cannot erase a newer sign-in", () async {
      final origin = BackendOrigin.parse("http://127.0.0.1:4100");
      var now = DateTime.utc(2026, 11, 2, 12);
      var user = "user-a";
      final secrets = MemorySecretStore();
      final jar = SessionCookieJar(
        origin: origin,
        store: secrets,
        clock: () => now,
      );
      final client = AuthHttpClient(
        origin: origin,
        jar: jar,
        clientKind: "test",
        client: MockClient((req) async {
          switch (req.url.path) {
            case "/api/auth/sign-in/email":
              return http.Response(
                "{}",
                200,
                headers: {
                  "set-cookie":
                      "better-auth.session_token=$user.sig; Max-Age=3600; Path=/; HttpOnly",
                },
              );
            case "/api/v1/me":
              return http.Response(jsonEncode(_me(user)), 200);
          }
          return http.Response("{}", 404);
        }),
      );
      final controller = AuthSessionController(
        client: client,
        eligibility: OfflineEligibilityStore(origin: origin, store: secrets),
        clock: () => now,
      );
      expect(
        await controller.signInWithEmail(email: "a@x", password: "p"),
        isA<AuthOk>(),
      );
      final staleGeneration = jar.generation;

      if (variant == "expired") {
        now = now.add(const Duration(hours: 2));
      } else {
        await jar.ingest(origin.resolve("/api/v1/x"), [
          "better-auth.session_token=; Max-Age=0; Path=/",
        ]);
      }
      expect(await jar.hasCredentials, isFalse);

      user = "user-b";
      expect(
        await controller.signInWithEmail(email: "b@x", password: "p"),
        isA<AuthOk>(),
      );
      expect(jar.generation, greaterThan(staleGeneration));

      await controller.reportUnauthorized(generation: staleGeneration);

      expect(await jar.cookieHeaderFor(origin.resolve("/api/v1/x")), isNotNull);
      expect(controller.state, isA<AuthActive>());
      expect((controller.state as AuthActive).identity.authUserId, "user-b");
    });
  }

  test("failed account exchange drops the previous network owner", () async {
    final origin = BackendOrigin.parse("http://127.0.0.1:4100");
    final now = DateTime.utc(2026, 11, 2, 12);
    var fail = false;
    final secrets = MemorySecretStore();
    final jar = SessionCookieJar(
      origin: origin,
      store: secrets,
      clock: () => now,
    );
    final client = AuthHttpClient(
      origin: origin,
      jar: jar,
      clientKind: "test",
      client: MockClient((req) async {
        if (req.url.path == "/api/auth/sign-in/email") {
          if (fail) return http.Response("{}", 401);
          return http.Response(
            "{}",
            200,
            headers: {
              "set-cookie":
                  "better-auth.session_token=user-a.sig; Max-Age=3600; Path=/; HttpOnly",
            },
          );
        }
        if (req.url.path == "/api/v1/me") {
          return http.Response(jsonEncode(_me("user-a")), 200);
        }
        return http.Response("{}", 200);
      }),
    );
    final controller = AuthSessionController(
      client: client,
      eligibility: OfflineEligibilityStore(origin: origin, store: secrets),
      clock: () => now,
    );
    await controller.signInWithEmail(email: "a@x", password: "p");
    expect(controller.networkOwnerId, "user-a");
    fail = true;
    final out = await controller.signInWithEmail(email: "b@x", password: "bad");
    expect(out, isA<AuthRejected>());
    expect(controller.networkOwnerId, isNull);
    expect(controller.state, isNot(isA<AuthActive>()));
    // Legitimate offline capture eligibility for A is preserved.
    expect(controller.captureOwnerId, "user-a");
  });
}
