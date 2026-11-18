import "dart:convert";

import "package:stateaction_contracts/stateaction_contracts.dart";
import "package:stera/src/core/contracts/published_contracts.dart";
import "package:stera/src/modules/auth/session/auth_http_client.dart";

enum ControlFailure {
  /// 401: the session ended. Same-owner sign-in is required; nothing restarts.
  unauthenticated,
  forbidden,

  /// 404 for the owner (unknown or not theirs; the server does not say which).
  notFound,

  /// 409 (`conflict`, `idempotency_conflict`, stale epoch): never retried
  /// blindly; the orchestrator re-reads the file plan.
  conflict,

  /// 422 / 413 / 406: the request was refused as invalid.
  invalid,

  /// Network, timeout, 5xx or a rate limit: safe to try again later with the
  /// identical frozen request.
  transient,

  /// A 2xx whose body does not satisfy the published contract.
  contract,

  /// The session changed (logout/sign-in) after the step was decided.
  superseded,
}

class ControlApiException implements Exception {
  const ControlApiException(this.failure, [this.code]);
  final ControlFailure failure;

  /// Server error code (`idempotency_conflict`, `conflict`, ...), if any.
  final String? code;
  @override
  String toString() => "ControlApiException($failure, $code)";
}

/// A validated `http.upload-plan.v1` document and the exact JSON handed to the
/// native uploader.
class UploadPlanDocument {
  const UploadPlanDocument(this.data, this.json);
  final Map<String, Object?> data;
  final String json;

  String get fileId => data["fileId"]! as String;
  String get recordingId => data["recordingId"]! as String;
  String get role => data["role"]! as String;
  String get sizeBytes => data["sizeBytes"]! as String;
  String get sha256 => data["sha256"]! as String;
  int get transportEpoch => data["transportEpoch"]! as int;
  String get state => data["state"]! as String;
}

/// Typed `/api/v1` client for the owner-bound upload workflow. Uses the same
/// Better Auth cookie session through [AuthHttpClient]; it never talks to a
/// storage provider and never handles a part URL.
class OwnerControlApi {
  OwnerControlApi(this._client);

  final AuthHttpClient _client;

  static const String recordingV2MediaType =
      "application/vnd.stateaction.recording.v2+json";

  int get jarGeneration => _client.jar.generation;

  Future<Map<String, Object?>> register(
    Map<String, Object?> createV2,
    int generation,
  ) => _json(
    "POST",
    "/api/v1/recordings",
    contract: "http.recording-registration.v2",
    body: createV2,
    headers: const {"accept": recordingV2MediaType},
    generation: generation,
  );

  Future<Map<String, Object?>> getRecording(
    String recordingId,
    int generation,
  ) => _json(
    "GET",
    "/api/v1/recordings/$recordingId",
    contract: "http.recording.v2",
    headers: const {"accept": recordingV2MediaType},
    generation: generation,
  );

  /// Returns the sealed `http.recording.v2` view.
  Future<Map<String, Object?>> seal(
    String recordingId,
    Map<String, Object?> sealBody,
    int generation,
  ) => _json(
    "POST",
    "/api/v1/recordings/$recordingId/seal",
    contract: "http.recording.v2",
    body: sealBody,
    headers: const {"accept": recordingV2MediaType},
    generation: generation,
  );

  Future<UploadPlanDocument> createUpload(
    Map<String, Object?> body,
    int generation,
  ) async => _plan(
    await _json(
      "POST",
      "/api/v1/uploads",
      contract: "http.upload-plan.v1",
      body: body,
      generation: generation,
    ),
  );

  Future<UploadPlanDocument> getUpload(String fileId, int generation) async =>
      _plan(
        await _json(
          "GET",
          "/api/v1/uploads/$fileId",
          contract: "http.upload-plan.v1",
          generation: generation,
        ),
      );

  /// Reconcile an uncertain `completing` upload (read-only for the provider).
  Future<UploadPlanDocument> reconcile(
    String fileId,
    int expectedEpoch,
    int generation,
  ) async => _plan(
    await _json(
      "POST",
      "/api/v1/uploads/$fileId/reconcile",
      contract: "http.upload-plan.v1",
      body: {"expectedTransportEpoch": expectedEpoch},
      generation: generation,
    ),
  );

  /// Full restart of an expired multipart upload (new epoch, full
  /// retransmission). Only ever called for an explicit user decision.
  Future<UploadPlanDocument> restart(
    String fileId,
    int expectedEpoch,
    int generation,
  ) async => _plan(
    await _json(
      "POST",
      "/api/v1/uploads/$fileId/restart",
      contract: "http.upload-plan.v1",
      body: {"expectedTransportEpoch": expectedEpoch},
      generation: generation,
    ),
  );

  UploadPlanDocument _plan(Map<String, Object?> data) =>
      UploadPlanDocument(data, jsonEncode(data));

  Future<Map<String, Object?>> _json(
    String method,
    String path, {
    required String contract,
    required int generation,
    Map<String, Object?>? body,
    Map<String, String> headers = const {},
  }) async {
    final outcome = await _client.sendApi(
      method,
      path,
      jsonBody: body,
      headers: headers,
      expectedJarGeneration: generation,
    );
    final ApiExchange exchange;
    switch (outcome) {
      case AuthOk(:final value):
        exchange = value;
      case AuthUnavailable(:final message):
        throw ControlApiException(
          message.startsWith("The session changed")
              ? ControlFailure.superseded
              : ControlFailure.transient,
        );
      case AuthRejected():
        throw const ControlApiException(ControlFailure.transient);
    }
    if (exchange.jarGeneration != generation) {
      throw const ControlApiException(ControlFailure.superseded);
    }
    if (exchange.isSuccess) {
      try {
        return PublishedContracts.parseSuccessData(
          contract,
          exchange.bodyBytes,
        );
      } on ContractViolation {
        throw const ControlApiException(ControlFailure.contract);
      }
    }
    throw ControlApiException(
      _classify(exchange.statusCode),
      _errorCode(exchange.bodyBytes),
    );
  }

  static ControlFailure _classify(int status) {
    if (status == 401) return ControlFailure.unauthenticated;
    if (status == 403) return ControlFailure.forbidden;
    if (status == 404) return ControlFailure.notFound;
    if (status == 409) return ControlFailure.conflict;
    if (status == 406 || status == 413 || status == 415 || status == 422) {
      return ControlFailure.invalid;
    }
    if (status == 400) return ControlFailure.invalid;
    return ControlFailure.transient;
  }

  static String? _errorCode(List<int> bytes) {
    try {
      final decoded = jsonDecode(utf8.decode(bytes));
      if (decoded is Map) {
        final error = decoded["error"];
        if (error is Map && error["code"] is String) {
          final code = error["code"] as String;
          return RegExp(r"^[a-z_]{1,48}$").hasMatch(code) ? code : null;
        }
      }
    } on FormatException {
      // fall through
    }
    return null;
  }
}
