import "dart:convert";
import "dart:io";

import "package:flutter_test/flutter_test.dart";
import "package:stera/src/modules/owner_upload/cleanup_proof_identity.dart";
import "package:stera/src/modules/source_integrity/source_limits.dart";

// fixtures/seal-identity.v1.json is a verbatim copy of the SA-73 conformance
// vectors (packages/contracts/conformance/seal-identity.v1.json at d00be42),
// computed by the TypeScript normalizeSeal/requestSha256.
List<Map<String, Object?>> _cases() {
  final doc =
      jsonDecode(
            File(
              "test/src/modules/owner_upload/fixtures/seal-identity.v1.json",
            ).readAsStringSync(),
          )
          as Map<String, Object?>;
  return (doc["cases"]! as List).cast<Map<String, Object?>>();
}

List<ProofFile> _files(Map<String, Object?> input) => [
  for (final f in (input["files"]! as List).cast<Map>())
    ProofFile(
      fileId: f["fileId"]! as String,
      role: f["role"]! as String,
      required: f["required"]! as bool,
      sizeBytes: f["sizeBytes"]! as String,
      sha256: f["sha256"]! as String,
    ),
];

const owner = "Xk2pA9qLr0";
const client = "7d444840-9dc0-4d1a-9fd7-3cf3b1c6d6a1";
const recording = "3f1b8c2e-6a4d-4e7b-9c1a-2b5d8e9f0a11";

CleanupProofIdentity identity() {
  final c = _cases().first;
  final files = _files(c["input"]! as Map<String, Object?>);
  final manifest = files.firstWhere((f) => f.role == "source_manifest");
  return CleanupProofIdentity.fromSealBody(
    ownerUserId: owner,
    clientRecordingId: client,
    recordingId: recording,
    sealBody: {
      "files": [for (final f in files) f.toWire()],
    },
    manifestSha256: manifest.sha256,
  );
}

Map<String, Object?> proofFor(
  CleanupProofIdentity id, {
  String issuedAt = "2026-11-02T10:00:00Z",
  String expiresAt = "2026-11-02T10:01:00Z",
}) => {
  "schemaVersion": 1,
  "proofId": "11111111-1111-4111-8111-111111111111",
  "recordingId": id.recordingId,
  "clientRecordingId": id.clientRecordingId,
  "ownerUserId": id.ownerUserId,
  "sealSha256": id.sealSha256,
  "sourceManifestSha256": id.sourceManifestSha256,
  "confirmationId": "22222222-2222-4222-8222-222222222222",
  "confirmedAt": "2026-11-02T09:59:00Z",
  "verification": "rehash",
  "fileCount": id.fileCount,
  "totalBytes": id.totalBytes.toString(),
  "files": [for (final f in id.files) f.toWire()],
  "issuedAt": issuedAt,
  "expiresAt": expiresAt,
};

void main() {
  group("seal digest vectors", () {
    for (final c in _cases()) {
      test(c["name"]! as String, () {
        final files = _files(c["input"]! as Map<String, Object?>);
        expect(CleanupProofIdentity.sealSha256Of(files), c["sealSha256"]);
        expect([
          for (final f in CleanupProofIdentity.normalize(files)) f.fileId,
        ], c["normalizedFileIds"]);
      });
    }
  });

  group("identity", () {
    test("seal digest and manifest digest are different identities", () {
      final id = identity();
      expect(id.sealSha256, isNot(id.sourceManifestSha256));
      expect(id.fileCount, 3);
      expect(id.totalBytes, BigInt.from(1000 + 134217729 + 4096));
    });

    test("an empty owner or invalid recording ids are refused", () {
      final body = {
        "files": [for (final f in identity().files) f.toWire()],
      };
      String? code(String o, String c, String r) {
        try {
          CleanupProofIdentity.fromSealBody(
            ownerUserId: o,
            clientRecordingId: c,
            recordingId: r,
            sealBody: body,
            manifestSha256: identity().sourceManifestSha256,
          );
          return null;
        } on CleanupProofMismatch catch (e) {
          return e.code;
        }
      }

      expect(code("", client, recording), "owner_invalid");
      expect(code("a b", client, recording), "owner_invalid");
      expect(code(owner, client, "nope"), "recording_id_invalid");
      expect(code(owner, "nope", recording), "recording_id_invalid");
      expect(code(owner, client, recording), isNull);
    });

    test("the manifest digest must be the sealed manifest entry's", () {
      final c = _cases().first;
      final files = _files(c["input"]! as Map<String, Object?>);
      expect(
        () => CleanupProofIdentity.fromSealBody(
          ownerUserId: owner,
          clientRecordingId: client,
          recordingId: recording,
          sealBody: {
            "files": [for (final f in files) f.toWire()],
          },
          manifestSha256: identity().sealSha256,
        ),
        throwsA(isA<CleanupProofMismatch>()),
      );
    });

    test("malformed or duplicate inventories are refused", () {
      Object? attempt(List<Object?> files) {
        try {
          CleanupProofIdentity.fromSealBody(
            ownerUserId: owner,
            clientRecordingId: client,
            recordingId: recording,
            sealBody: {"files": files},
            manifestSha256: "0" * 64,
          );
          return null;
        } on CleanupProofMismatch catch (e) {
          return e.code;
        }
      }

      expect(attempt([]), "inventory_empty");
      expect(attempt(["x"]), "inventory_malformed");
      final f = identity().files.first.toWire();
      expect(attempt([f, f]), "inventory_duplicate_file");
      expect(
        attempt([
          {...f, "sizeBytes": 5},
        ]),
        "inventory_malformed",
      );
      expect(
        attempt([
          {...f, "sha256": "ABC"},
        ]),
        "inventory_malformed",
      );
      expect(
        attempt([
          {...f, "role": "other"},
        ]),
        "inventory_malformed",
      );
      expect(
        attempt([
          {...f, "fileId": "not-a-uuid"},
        ]),
        "inventory_malformed",
      );
      expect(
        attempt([
          {...f, "sizeBytes": "0"},
        ]),
        "inventory_malformed",
      );
      expect(
        attempt([
          {...f, "sizeBytes": "107374182401"},
        ]),
        "inventory_malformed",
      );
      expect(
        attempt([
          for (var i = 0; i < SourceLimits.maxSealFiles + 1; i++)
            {
              ...f,
              "fileId":
                  "00000000-0000-4000-8000-${i.toRadixString(16).padLeft(12, "0")}",
            },
        ]),
        "inventory_too_large",
      );
    });
  });

  group("server proof comparison", () {
    test("an exact proof matches", () {
      final id = identity();
      id.expectMatches(proofFor(id));
    });

    for (final field in [
      "schemaVersion",
      "recordingId",
      "clientRecordingId",
      "ownerUserId",
      "sealSha256",
      "sourceManifestSha256",
      "verification",
      "fileCount",
      "totalBytes",
    ]) {
      test("a different $field is refused", () {
        final id = identity();
        final p = proofFor(id)..[field] = field == "fileCount" ? 99 : "x";
        expect(
          () => id.expectMatches(p),
          throwsA(
            isA<CleanupProofMismatch>().having(
              (e) => e.code,
              "code",
              "proof_$field",
            ),
          ),
        );
      });
    }

    test("any changed, missing or extra file is refused", () {
      final id = identity();
      List<Map<String, Object?>> files() => [
        for (final f in id.files) f.toWire(),
      ];
      for (final mutate in <void Function(List<Map<String, Object?>>)>[
        (l) => l[0]["sha256"] = "9" * 64,
        (l) => l[1]["sizeBytes"] = "1",
        (l) => l[2]["role"] = "source_mcap",
        (l) => l[0]["required"] = false,
        (l) => l[0]["fileId"] = "00000000-0000-4000-8000-0000000000ff",
        (l) => l.removeLast(),
        (l) => l.add(l.first),
      ]) {
        final l = files();
        mutate(l);
        final p = proofFor(id)..["files"] = l;
        expect(() => id.expectMatches(p), throwsA(isA<CleanupProofMismatch>()));
      }
    });

    test("file order in the proof does not matter", () {
      final id = identity();
      final p = proofFor(id)
        ..["files"] = [for (final f in id.files.reversed) f.toWire()];
      id.expectMatches(p);
    });
  });

  group("conservative expiry", () {
    late Duration now;
    CleanupProofRequestTimer timer() =>
        CleanupProofRequestTimer.start(() => now);
    setUp(() => now = const Duration(minutes: 5));

    test("the window is the server TTL minus the margin", () {
      final id = identity();
      final proof = VerifiedCleanupProof.accept(
        identity: id,
        proof: proofFor(id),
        timer: timer(),
      );
      expect(proof.validFor, const Duration(seconds: 55));
      expect(proof.usable, isTrue);
      now += const Duration(seconds: 54);
      expect(proof.usable, isTrue);
      now += const Duration(seconds: 2);
      expect(proof.usable, isFalse);
    });

    test("request latency counts: the timer started before the request", () {
      final id = identity();
      final t = timer();
      now += const Duration(seconds: 50); // slow request
      final proof = VerifiedCleanupProof.accept(
        identity: id,
        proof: proofFor(id),
        timer: t,
      );
      expect(proof.remaining, const Duration(seconds: 5));
      now += const Duration(seconds: 6);
      expect(proof.usable, isFalse);
    });

    test("a reply that arrives already out of time is refused", () {
      final id = identity();
      final t = timer();
      now += const Duration(seconds: 56); // window is 55 s
      expect(
        () => VerifiedCleanupProof.accept(
          identity: id,
          proof: proofFor(id),
          timer: t,
        ),
        throwsA(
          isA<CleanupProofMismatch>().having(
            (e) => e.code,
            "code",
            "proof_expired",
          ),
        ),
      );
    });

    test("a TTL above the cap is capped", () {
      final id = identity();
      final proof = VerifiedCleanupProof.accept(
        identity: id,
        proof: proofFor(id, expiresAt: "2026-11-02T10:10:00Z"),
        timer: timer(),
      );
      expect(proof.validFor, const Duration(seconds: 115));
    });

    test("an unusable TTL or time format is refused", () {
      final id = identity();
      for (final p in [
        proofFor(id, expiresAt: "2026-11-02T10:00:00Z"),
        proofFor(id, expiresAt: "2026-11-02T10:00:04Z"),
        proofFor(id, expiresAt: "2026-11-02T09:00:00Z"),
        proofFor(id, expiresAt: "not a time"),
        proofFor(id, issuedAt: "2026-11-02T10:00:00+01:00"),
      ]) {
        expect(
          () => VerifiedCleanupProof.accept(
            identity: id,
            proof: p,
            timer: timer(),
          ),
          throwsA(isA<CleanupProofMismatch>()),
        );
      }
    });

    test("a mismatching proof is never accepted regardless of timing", () {
      final id = identity();
      expect(
        () => VerifiedCleanupProof.accept(
          identity: id,
          proof: proofFor(id)..["sealSha256"] = "0" * 64,
          timer: timer(),
        ),
        throwsA(isA<CleanupProofMismatch>()),
      );
    });
  });
}
