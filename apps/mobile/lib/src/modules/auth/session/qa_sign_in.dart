import "dart:convert";
import "dart:io";

import "package:flutter/foundation.dart";
import "package:path/path.dart" as p;
import "package:path_provider/path_provider.dart";
import "package:stera/src/modules/auth/session/auth_http_client.dart";
import "package:stera/src/modules/auth/session/auth_services.dart";
import "package:stera/src/modules/auth/session/auth_session_controller.dart";
import "package:stera/src/modules/auth/session/backend_origin.dart";
import "package:stera/src/modules/auth/session/server_identity.dart";
import "package:stera/src/services/app_info/app_info.dart";

const qaApplicationId = "ai.stateaction.collector.qa";
const qaSignInFileName = "qa-sign-in.json";
const _enabled =
    kDebugMode && bool.fromEnvironment("STATEACTION_QA_AUTO_SIGN_IN");

/// This credential file is created by the test driver in the QA package's
/// private files directory. Consume it before contacting the bound origin.
Future<({String email, String password})?> consumeQaSignInFile(
  File file,
  BackendOrigin backend,
) async {
  try {
    if (await FileSystemEntity.type(file.path, followLinks: false) !=
        FileSystemEntityType.file) {
      return null;
    }
    final List<int>? bytes;
    try {
      bytes = await file.length() <= 1024 ? await file.readAsBytes() : null;
    } finally {
      await file.delete();
    }
    const local = {"localhost", "127.0.0.1", "::1", "10.0.2.2"};
    if (bytes == null ||
        bytes.length > 1024 ||
        !(local.contains(backend.host) ||
            (backend.isSecure && backend.host.endsWith(".ts.net")))) {
      return null;
    }
    final decoded = jsonDecode(utf8.decode(bytes));
    if (decoded is! Map<String, dynamic> ||
        decoded["origin"] != backend.value ||
        decoded["email"] is! String ||
        decoded["password"] is! String) {
      return null;
    }
    final expires = decoded["expiresAt"];
    final deadline = expires is String ? DateTime.tryParse(expires) : null;
    if (deadline == null || !deadline.isAfter(DateTime.now())) return null;
    return (
      email: decoded["email"] as String,
      password: decoded["password"] as String,
    );
  } on FileSystemException {
    return null;
  } on FormatException {
    return null;
  }
}

/// Try once at startup when a QA collector was provisioned by the driver.
/// Current sessions are restored through the ordinary path first.
Future<void> tryQaSignIn(AuthServices auth) async {
  if (!_enabled ||
      !Platform.isAndroid ||
      AppInfo.packageInfo.packageName != qaApplicationId) {
    return;
  }
  final directory = await getApplicationSupportDirectory();
  final credential = await consumeQaSignInFile(
    File(p.join(directory.path, qaSignInFileName)),
    auth.origin,
  );
  if (credential == null || auth.controller.state is AuthActive) return;
  final result = await auth.controller.signInWithEmail(
    email: credential.email,
    password: credential.password,
    qa: true,
  );
  if (result case AuthOk<ServerIdentity>(:final value) when !value.canCollect) {
    await auth.controller.logout();
  }
}
