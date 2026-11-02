import "dart:io";

import "package:flutter/material.dart";
import "package:flutter_test/flutter_test.dart";
import "package:provider/provider.dart";
import "package:stera/src/core/theme/app_theme.dart";
import "package:stera/src/modules/auth/providers/auth_provider.dart";
import "package:stera/src/modules/auth/session/auth_services.dart";
import "package:stera/src/modules/auth/session/auth_session_controller.dart";
import "package:stera/src/modules/auth/session/backend_origin.dart";
import "package:stera/src/modules/auth/session/secret_store.dart";
import "package:stera/src/modules/auth/ui/widgets/local_password_sign_in_form.dart";

import "session/fake_better_auth_server.dart";

/// Drives the real dev sign-in form -> AuthProvider -> AuthRepo ->
/// AuthSessionController -> AuthHttpClient over loopback HTTP to the fixture,
/// with NO_AUTH_MODE off. Fixture only; not real-backend qualification.
void main() {
  late FakeBetterAuthServer server;
  late Directory tmp;
  late MemorySecretStore secrets;

  setUp(() async {
    AuthServices.debugReset();
  });

  tearDown(() async {
    AuthServices.debugReset();
  });

  Future<void> boot(WidgetTester tester) async {
    // testWidgets installs a mock HttpClient that answers 400; this test needs
    // real loopback HTTP to the fixture.
    HttpOverrides.global = null;
    await tester.runAsync(() async {
      server = await FakeBetterAuthServer.start();
      server.addUser("collector@example.test", id: "opaque-c1");
      tmp = await Directory.systemTemp.createTemp("sa17-form");
      secrets = MemorySecretStore();
      await AuthServices.initialize(
        secrets: secrets,
        origin: BackendOrigin.parse(server.origin),
        ledgerFile: File("${tmp.path}/ledger.v1.json"),
      );
    });
  }

  Future<void> shutdown(WidgetTester tester) async {
    await tester.runAsync(() async {
      await server.close();
      await tmp.delete(recursive: true);
    });
  }

  Widget host(AuthProvider provider, VoidCallback onSignedIn) =>
      ChangeNotifierProvider.value(
        value: provider,
        child: MaterialApp(
          theme: AppTheme.light,
          home: Scaffold(
            body: SingleChildScrollView(
              child: LocalPasswordSignInForm(onSignedIn: onSignedIn),
            ),
          ),
        ),
      );

  Future<void> submit(
    WidgetTester tester,
    String email,
    String password,
  ) async {
    await tester.enterText(
      find.byKey(LocalPasswordSignInForm.emailKey).last,
      email,
    );
    await tester.enterText(
      find.descendant(
        of: find.byKey(LocalPasswordSignInForm.passwordKey),
        matching: find.byType(EditableText),
      ),
      password,
    );
    await tester.tap(find.byKey(LocalPasswordSignInForm.submitKey));
    // Real loopback I/O has to run outside the fake-async zone.
    for (var i = 0; i < 20; i++) {
      await tester.runAsync(
        () => Future<void>.delayed(const Duration(milliseconds: 25)),
      );
      await tester.pump();
    }
  }

  testWidgets("signs in a seeded collector and reaches an active session", (
    tester,
  ) async {
    await boot(tester);
    final provider = AuthProvider();
    var signedIn = 0;
    await tester.pumpWidget(host(provider, () => signedIn++));

    await submit(tester, "collector@example.test", "correct horse battery");

    expect(signedIn, 1);
    expect(provider.user?.id, "opaque-c1");
    expect(provider.sessionState, isA<AuthActive>());
    expect(provider.sessionState.captureOwnerAt(DateTime.now()), "opaque-c1");
    expect(secrets.values.keys, contains(SecretKeys.sessionCookies));
    expect(
      server.requests.every((r) => !r.headers.containsKey("authorization")),
      isTrue,
    );
    await shutdown(tester);
  });

  testWidgets("shows a safe error for a wrong password and clears it", (
    tester,
  ) async {
    await boot(tester);
    final provider = AuthProvider();
    var signedIn = 0;
    await tester.pumpWidget(host(provider, () => signedIn++));

    await submit(tester, "collector@example.test", "wrong-password-here");

    expect(signedIn, 0);
    expect(find.text("Email or password is incorrect."), findsOneWidget);
    expect(find.text("wrong-password-here"), findsNothing);
    expect(provider.user, isNull);
    expect(secrets.values, isEmpty);
    await shutdown(tester);
  });
}
