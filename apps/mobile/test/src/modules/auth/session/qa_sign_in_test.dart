import "dart:convert";
import "dart:io";

import "package:flutter_test/flutter_test.dart";
import "package:stera/src/modules/auth/session/backend_origin.dart";
import "package:stera/src/modules/auth/session/qa_sign_in.dart";

void main() {
  test(
    "QA credentials are origin-bound, short-lived and consumed on read",
    () async {
      final temp = await Directory.systemTemp.createTemp("qa-sign-in-");
      addTearDown(() => temp.delete(recursive: true));
      final file = File("${temp.path}/$qaSignInFileName");
      final backend = BackendOrigin.parse("https://qa.example.ts.net:8444");
      final current = DateTime.now().toUtc();
      Future<void> put(String origin, DateTime expires) async {
        await file.writeAsString(
          jsonEncode({
            "origin": origin,
            "email": "collector@fixture.test",
            "password": "fixture-password",
            "expiresAt": expires.toIso8601String(),
          }),
        );
      }

      await put(backend.value, current.add(const Duration(minutes: 1)));
      expect(await consumeQaSignInFile(file, backend), (
        email: "collector@fixture.test",
        password: "fixture-password",
      ));
      expect(await file.exists(), isFalse);
      expect(await consumeQaSignInFile(file, backend), isNull);

      await put(
        "https://host.onrender.com",
        current.add(const Duration(minutes: 1)),
      );
      expect(await consumeQaSignInFile(file, backend), isNull);
      expect(await file.exists(), isFalse);

      await put(backend.value, current.subtract(const Duration(minutes: 1)));
      expect(await consumeQaSignInFile(file, backend), isNull);
      expect(await file.exists(), isFalse);
    },
  );
}
