import "dart:convert";

import "package:flutter_test/flutter_test.dart";
import "package:stera/src/modules/auth/session/backend_origin.dart";
import "package:stera/src/modules/auth/session/secret_store.dart";
import "package:stera/src/modules/auth/session/session_cookie_jar.dart";

void main() {
  final origin = BackendOrigin.parse("https://api.example.test");
  late MemorySecretStore store;
  late DateTime now;
  SessionCookieJar jar() =>
      SessionCookieJar(origin: origin, store: store, clock: () => now);
  final at = Uri.parse("https://api.example.test/api/auth/sign-in/email");

  StoredCookie cookie(String value, {String path = "/", bool secure = true}) =>
      StoredCookie(
        name: "__Secure-better-auth.session_token",
        value: value,
        path: path,
        secure: secure,
        httpOnly: true,
        expiresAt: now.add(const Duration(days: 1)),
      );

  setUp(() {
    store = MemorySecretStore();
    now = DateTime.utc(2026, 11, 2, 12);
  });

  test("revision increments on every credential change and persists", () async {
    final a = jar();
    expect(a.revision, 0);
    await a.ingest(at, [
      "__Secure-better-auth.session_token=a; Max-Age=3600; Path=/; Secure; HttpOnly",
    ]);
    expect(a.revision, 1);
    await a.ingest(at, [
      "__Secure-better-auth.session_token=b; Max-Age=3600; Path=/; Secure; HttpOnly",
    ]);
    expect(a.revision, 2);
    final b = jar();
    await b.load();
    expect(b.revision, 2);
  });

  test("legacy record without a revision loads as zero", () async {
    store.values[SecretKeys.sessionCookies] = jsonEncode({
      "origin": origin.value,
      "cookies": [cookie("legacy").toJson()],
    });
    final j = jar();
    expect(await j.hasCredentials, isTrue);
    expect(j.revision, 0);
  });

  test("revision stays monotonic across logout and restart", () async {
    final a = jar();
    await a.ingest(at, [
      "__Secure-better-auth.session_token=a; Max-Age=3600; Path=/; Secure",
    ]);
    await a.clear();
    expect(a.revision, 2);
    final restarted = jar();
    await restarted.load();
    expect(restarted.revision, 2);
    expect(await restarted.hasCredentials, isFalse);
  });

  group("adoptSnapshot", () {
    test(
      "adopts only a strictly newer revision under the same generation",
      () async {
        final j = jar();
        await j.ingest(at, [
          "__Secure-better-auth.session_token=old; Max-Age=3600; Path=/; Secure",
        ]);
        final generation = j.generation;
        expect(
          await j.adoptSnapshot(
            expectedGeneration: generation,
            revision: j.revision,
            cookies: [cookie("same")],
          ),
          isFalse,
        );
        expect(
          await j.adoptSnapshot(
            expectedGeneration: generation,
            revision: j.revision - 1,
            cookies: [cookie("older")],
          ),
          isFalse,
        );
        expect(
          await j.adoptSnapshot(
            expectedGeneration: generation,
            revision: 9,
            cookies: [cookie("native")],
          ),
          isTrue,
        );
        expect(j.revision, 9);
        expect(
          await j.cookieHeaderFor(
            Uri.parse("https://api.example.test/api/v1/me"),
          ),
          "__Secure-better-auth.session_token=native",
        );
        expect(j.generation, generation);
      },
    );

    test("a logout or sign-in after the decision fences the adoption", () async {
      final j = jar();
      await j.ingest(at, [
        "__Secure-better-auth.session_token=old; Max-Age=3600; Path=/; Secure",
      ]);
      final stale = j.generation;
      await j.clear();
      expect(
        await j.adoptSnapshot(
          expectedGeneration: stale,
          revision: 99,
          cookies: [cookie("old-native")],
        ),
        isFalse,
      );
      expect(await j.hasCredentials, isFalse);
    });

    test("rejects cookies that are invalid for this origin", () async {
      final j = jar();
      await j.load();
      final insecureOrigin = BackendOrigin.parse("http://127.0.0.1:3000");
      final local = SessionCookieJar(
        origin: insecureOrigin,
        store: MemorySecretStore(),
        clock: () => now,
      );
      expect(
        await local.adoptSnapshot(
          expectedGeneration: local.generation,
          revision: 1,
          cookies: [cookie("x")],
        ),
        isFalse,
        reason: "Secure cookie over plain http",
      );
      expect(
        await j.adoptSnapshot(
          expectedGeneration: j.generation,
          revision: 1,
          cookies: [
            const StoredCookie(
              name: "n",
              value: "v",
              path: "relative",
              secure: true,
              httpOnly: true,
            ),
          ],
        ),
        isFalse,
      );
      expect(
        await j.adoptSnapshot(
          expectedGeneration: j.generation,
          revision: 1,
          cookies: const [],
        ),
        isFalse,
      );
      expect(await j.hasCredentials, isFalse);
    });
  });
}
