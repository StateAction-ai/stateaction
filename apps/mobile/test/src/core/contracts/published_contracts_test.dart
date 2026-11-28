import "dart:convert";
import "dart:io";

import "package:flutter_test/flutter_test.dart";
import "package:stateaction_contracts/stateaction_contracts.dart";
import "package:stera/src/core/contracts/published_contracts.dart";
import "package:stera/src/core/contracts/published_contracts.g.dart";
import "package:stera/src/modules/auth/session/server_identity.dart";

const _api = "../../packages/contracts/api";
const _fixtures = "../../packages/contracts/conformance/fixtures/contracts";
const _requestId = "0b9f1c7e-4d3a-4f6b-9a2e-5c8d7e6f1a20";

Map<String, Object?> _json(String path) =>
    jsonDecode(File(path).readAsStringSync()) as Map<String, Object?>;

List<int> _envelope(Object? data) =>
    utf8.encode(jsonEncode({"data": data, "requestId": _requestId}));

// Interpret every shared fixture form; missing fixture input must never pass
// an invalid-case assertion accidentally by validating null instead.
ValidationResult _runFixture(String contract, Map<String, Object?> input) {
  final registry = PublishedContracts.registry;
  List<int> read(String path) => File(
    "../../packages/contracts/conformance/fixtures/$path",
  ).readAsBytesSync();
  if (input.containsKey("document")) {
    return registry.validateValue(contract, input["document"]);
  }
  if (input.containsKey("json")) {
    return registry.validateBytes(
      contract,
      utf8.encode(input["json"]! as String),
    );
  }
  if (input.containsKey("base64")) {
    return registry.validateBytes(
      contract,
      base64Decode(input["base64"]! as String),
    );
  }
  if (input.containsKey("file")) {
    return registry.validateBytes(contract, read(input["file"]! as String));
  }
  if (input.containsKey("pad")) {
    final pad = input["pad"]! as Map;
    final bytes = read(pad["file"]! as String);
    return registry.validateBytes(contract, [
      ...bytes,
      ...List.filled((pad["totalBytes"]! as int) - bytes.length, 0x20),
    ]);
  }
  if (input.containsKey("repeat")) {
    final repeat = input["repeat"]! as Map;
    final document = jsonDecode(jsonEncode(repeat["document"]));
    dynamic node = document;
    for (final raw in (repeat["pointer"]! as String).split("/").skip(1)) {
      final part = raw.replaceAll("~1", "/").replaceAll("~0", "~");
      node = node is List ? node[int.parse(part)] : (node as Map)[part];
    }
    final items = node as List;
    while (items.length < (repeat["count"]! as int)) {
      items.add(jsonDecode(jsonEncode(items.first)));
    }
    return registry.validateValue(contract, document);
  }
  throw StateError("Unknown shared fixture form: ${input.keys}");
}

void main() {
  group("embedded published contracts", () {
    test("schema documents are byte-identical to packages/contracts/api", () {
      expect(publishedSchemaDocuments, isNotEmpty);
      for (final MapEntry(:key, :value) in publishedSchemaDocuments.entries) {
        expect(value, File("$_api/$key").readAsStringSync(), reason: key);
      }
    });

    test("catalog entries match the published catalog verbatim", () {
      final published = _json("$_api/catalog.v13.json");
      final subset = jsonDecode(publishedCatalogSubset) as Map<String, Object?>;
      expect(subset["catalog"], published["catalog"]);
      expect(publishedCatalogName, published["catalog"]);
      expect(subset["common"], published["common"]);
      expect(subset["maxDepth"], published["maxDepth"]);
      final contracts = subset["contracts"]! as Map<String, Object?>;
      expect(
        contracts.keys,
        containsAll({
          PublishedContracts.successEnvelope,
          PublishedContracts.me,
          "http.recording-create.v1",
          "http.recording-create.v2",
          "http.recording-registration.v1",
          "http.recording-registration.v2",
          "http.recording-seal.v1",
          "artifacts.recording-source.v1",
          "artifacts.recording-source.v2",
        }),
      );
      for (final MapEntry(:key, :value) in contracts.entries) {
        expect(
          value,
          (published["contracts"]! as Map<String, Object?>)[key],
          reason: key,
        );
      }
    });
  });

  group("embedded shared conformance fixtures", () {
    for (final contract
        in ((jsonDecode(publishedCatalogSubset) as Map)["contracts"] as Map)
            .keys
            .cast<String>()) {
      final cases =
          _json("$_fixtures/$contract.json")["cases"]! as List<Object?>;
      for (final raw in cases.cast<Map<String, Object?>>()) {
        final input = raw["input"]! as Map<String, Object?>;
        final expected = raw["expect"]! as Map<String, Object?>;
        test("$contract: ${raw["name"]}", () {
          final result = _runFixture(contract, input);
          expect(result.valid, expected["valid"], reason: "$result");
          if (expected["code"] != null) expect(result.code, expected["code"]);
          for (final path in expected["paths"] as List? ?? const []) {
            expect(result.errors.map((e) => e.path), contains(path));
          }
        });
        if (contract == PublishedContracts.me &&
            input.containsKey("document")) {
          test("ServerIdentity agrees: ${raw["name"]}", () {
            List<int> body() => _envelope(input["document"]);
            if (expected["valid"] == true) {
              final identity = ServerIdentity.fromResponseBytes(body());
              final doc = input["document"]! as Map<String, Object?>;
              final access = doc["access"]! as Map<String, Object?>;
              expect(identity.status.name, access["status"]);
              expect(
                identity.roles.map((r) => r.name).toList(),
                access["roles"],
              );
            } else {
              expect(
                () => ServerIdentity.fromResponseBytes(body()),
                throwsFormatException,
              );
            }
          });
        }
      }
    }
  });

  group("ServerIdentity binding", () {
    Map<String, Object?> doc({
      Object? expiresAt = "2026-11-08T23:59:59.123Z",
      String status = "active",
      List<String> roles = const ["collector"],
    }) => {
      "user": {
        "id": "Xk9pQ2rT7vW1yZ4bN6mC8dF3hJ5kL0sA",
        "email": "a@b",
        "name": "",
      },
      "access": {"status": status, "roles": roles},
      "session": {"expiresAt": ?expiresAt},
    };

    test("valid active collector maps to a bounded network owner", () {
      final identity = ServerIdentity.fromResponseBytes(_envelope(doc()));
      expect(identity.canCollect, isTrue);
      expect(
        identity.sessionExpiresAt,
        DateTime.utc(2026, 11, 8, 23, 59, 59, 123),
      );
      expect(identity.sessionExpiresAt.isUtc, isTrue);
    });

    test("staff without collector cannot collect", () {
      final identity = ServerIdentity.fromResponseBytes(
        _envelope(doc(roles: ["staff", "customer"])),
      );
      expect(identity.canCollect, isFalse);
    });

    for (final (name, data) in [
      ("missing session expiry", doc(expiresAt: null)),
      ("non-UTC expiry", doc(expiresAt: "2026-11-08T23:59:59+01:00")),
      ("non-canonical role order", doc(roles: ["staff", "collector"])),
      ("duplicate roles", doc(roles: ["collector", "collector"])),
      ("unknown role", doc(roles: ["collector", "admin"])),
      ("active without roles", doc(roles: [])),
      ("pending with a role", doc(status: "pending")),
      ("unknown status", doc(status: "suspended", roles: [])),
    ]) {
      test("rejects $name", () {
        expect(
          () => ServerIdentity.fromResponseBytes(_envelope(data)),
          throwsFormatException,
        );
      });
    }

    test("rejects envelope violations before reading data", () {
      for (final body in [
        utf8.encode(jsonEncode({"data": doc()})),
        utf8.encode(jsonEncode({"data": doc(), "requestId": "req-1"})),
        utf8.encode(
          jsonEncode({"data": doc(), "requestId": _requestId, "extra": 1}),
        ),
        [0xef, 0xbb, 0xbf, ..._envelope(doc())],
        utf8.encode("not json"),
        List.filled(1048577, 0x20),
      ]) {
        expect(
          () => ServerIdentity.fromResponseBytes(body),
          throwsFormatException,
        );
      }
    });
  });
}
