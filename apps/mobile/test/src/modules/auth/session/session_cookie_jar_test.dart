import "dart:convert";

import "package:flutter_test/flutter_test.dart";
import "package:stera/src/modules/auth/session/backend_origin.dart";
import "package:stera/src/modules/auth/session/secret_store.dart";
import "package:stera/src/modules/auth/session/session_cookie_jar.dart";

/// Everything stored except the non-secret credential revision floor.
Map<String, String> _credentials(MemorySecretStore store) => {
  for (final e in store.values.entries)
    if (e.key != SecretKeys.sessionRevisionFloor) e.key: e.value,
};

void main() {
  final origin = BackendOrigin.parse(
    "https://tim-work-pc.taila68f99.ts.net:8444",
  );
  late MemorySecretStore store;
  late DateTime now;
  SessionCookieJar jar() =>
      SessionCookieJar(origin: origin, store: store, clock: () => now);
  Uri at(String path, {int port = 8444, String scheme = "https"}) =>
      Uri.parse("$scheme://tim-work-pc.taila68f99.ts.net:$port$path");

  setUp(() {
    store = MemorySecretStore();
    now = DateTime.utc(2026, 11, 1, 12);
  });

  group("BackendOrigin", () {
    test("accepts exact https origins and loopback http only", () {
      expect(origin.value, "https://tim-work-pc.taila68f99.ts.net:8444");
      expect(BackendOrigin.parse("https://api.example.com").port, 443);
      expect(BackendOrigin.parse("http://127.0.0.1:3000").isSecure, isFalse);
      expect(BackendOrigin.parse("http://10.0.2.2:3000").port, 3000);
      for (final bad in [
        "http://tim-work-pc.taila68f99.ts.net:8444",
        "https://host/api/v1",
        "https://user:pw@host",
        "https://host?x=1",
        "ftp://host",
        "host:8444",
      ]) {
        expect(
          () => BackendOrigin.parse(bad),
          throwsFormatException,
          reason: bad,
        );
      }
    });

    test("matches scheme, host and port exactly", () {
      expect(origin.matches(at("/api/v1/me")), isTrue);
      expect(origin.matches(at("/", port: 8443)), isFalse);
      expect(origin.matches(at("/", port: 443)), isFalse);
      expect(origin.matches(at("/", scheme: "http")), isFalse);
    });
  });

  test("stores, rotates and deletes cookies; sends only to the exact origin", () async {
    final j = jar();
    await j.ingest(at("/api/auth/sign-in/email"), [
      "__Secure-better-auth.session_token=a.sig; Max-Age=604800; Path=/; HttpOnly; Secure; SameSite=Lax",
      "__Secure-better-auth.session_data=d1; Max-Age=300; Path=/; HttpOnly; Secure",
    ]);
    expect(
      await j.cookieHeaderFor(at("/api/v1/me")),
      allOf(contains("session_token=a.sig"), contains("session_data=d1")),
    );
    // Same host, other ports/schemes: unrelated services never get the session.
    expect(await j.cookieHeaderFor(at("/api/v1/me", port: 8443)), isNull);
    expect(await j.cookieHeaderFor(at("/api/v1/me", port: 443)), isNull);
    expect(await j.cookieHeaderFor(at("/api/v1/me", scheme: "http")), isNull);

    await j.ingest(at("/api/v1/me"), [
      "__Secure-better-auth.session_token=b.sig; Max-Age=604800; Path=/; HttpOnly; Secure",
    ]);
    final rotated = await j.cookieHeaderFor(at("/api/v1/me"));
    expect(rotated, contains("session_token=b.sig"));
    expect(rotated, isNot(contains("a.sig")));

    await j.ingest(at("/api/auth/sign-out"), [
      "__Secure-better-auth.session_token=; Max-Age=0; Path=/; Secure",
      "__Secure-better-auth.session_data=; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/; Secure",
    ]);
    expect(await j.cookieHeaderFor(at("/api/v1/me")), isNull);
    expect(_credentials(store), isEmpty);
  });

  test(
    "rejects foreign responses, domains, insecure and bad prefixes",
    () async {
      final j = jar();
      expect(await j.ingest(at("/x", port: 8443), ["s=1; Path=/; Secure"]), [
        CookieRejection.foreignOrigin,
      ]);
      expect(
        await j.ingest(at("/x"), [
          "s=1; Domain=taila68f99.ts.net; Path=/; Secure",
          "__Secure-s=1; Path=/",
          "__Host-s=1; Path=/api; Secure",
          "not a cookie",
        ]),
        [
          CookieRejection.foreignDomain,
          CookieRejection.invalidPrefix,
          CookieRejection.invalidPrefix,
          CookieRejection.unparseable,
        ],
      );
      expect(await j.cookies(), isEmpty);

      final local = SessionCookieJar(
        origin: BackendOrigin.parse("http://127.0.0.1:4000"),
        store: store,
        clock: () => now,
      );
      expect(
        await local.ingest(Uri.parse("http://127.0.0.1:4000/"), [
          "s=1; Secure",
        ]),
        [CookieRejection.secureOverHttp],
      );
    },
  );

  test("expires cookies by Max-Age and scopes by path", () async {
    final j = jar();
    await j.ingest(at("/api/auth/x"), [
      "short=1; Max-Age=60; Path=/; Secure",
      "scoped=1; Max-Age=600; Path=/api/auth; Secure",
    ]);
    expect(await j.cookieHeaderFor(at("/api/v1/me")), "short=1");
    expect(
      await j.cookieHeaderFor(at("/api/auth/get-session")),
      contains("scoped=1"),
    );
    expect(await j.cookieHeaderFor(at("/api/authx")), "short=1");
    now = now.add(const Duration(seconds: 61));
    expect(await j.cookieHeaderFor(at("/api/v1/me")), isNull);
  });

  test("persists only in the secret store, bound to the origin", () async {
    await jar().ingest(at("/"), ["s=v; Max-Age=600; Path=/; Secure"]);
    final saved = jsonDecode(store.values[SecretKeys.sessionCookies]!) as Map;
    expect(saved["origin"], origin.value);
    expect(await jar().cookieHeaderFor(at("/")), "s=v");

    // A different configured backend never replays this session.
    final other = SessionCookieJar(
      origin: BackendOrigin.parse("https://stateaction.onrender.com"),
      store: store,
      clock: () => now,
    );
    expect(await other.cookies(), isEmpty);
    expect(store.values.containsKey(SecretKeys.sessionCookies), isFalse);
  });

  test("never exposes cookie values through toString", () async {
    final j = jar();
    await j.ingest(at("/"), ["s=topsecret; Max-Age=600; Path=/; Secure"]);
    expect((await j.cookies()).single.toString(), isNot(contains("topsecret")));
  });
}
