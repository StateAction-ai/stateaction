import "dart:convert";

import "package:stateaction_contracts/stateaction_contracts.dart";
import "package:stera/src/core/contracts/published_contracts.g.dart";

/// Shared validator ([ContractRegistry] from `packages/contracts/dart`) built
/// from exact published auth, recording registration, source and seal documents,
/// including their referenced schemas. Same fail-closed rules as the server
/// and TypeScript/Python adapters; existing v1 documents remain unchanged.
final class PublishedContracts {
  PublishedContracts._();

  static final ContractRegistry registry = ContractRegistry.load(
    jsonDecode(publishedCatalogSubset) as Map<String, Object?>,
    (path) =>
        jsonDecode(
              publishedSchemaDocuments[path] ??
                  (throw ArgumentError("Unpublished schema $path")),
            )
            as Map<String, Object?>,
  );

  static const String successEnvelope = "http.success-envelope.v1";
  static const String me = "http.me.v1";

  /// Validates a raw `/api/v1` success body (byte bound, strict UTF-8/JSON,
  /// envelope schema), then its `data` against [contract] including that
  /// contract's own byte bound. Throws [ContractViolation] on any failure.
  static Map<String, Object?> parseSuccessData(
    String contract,
    List<int> bodyBytes,
  ) {
    final envelope = registry.validateBytes(successEnvelope, bodyBytes);
    if (!envelope.valid) throw ContractViolation(successEnvelope, envelope);
    final data = (envelope.value! as Map<String, Object?>)["data"];
    final result = registry.validateBytes(
      contract,
      utf8.encode(jsonEncode(data)),
    );
    if (!result.valid) throw ContractViolation(contract, result);
    return result.value! as Map<String, Object?>;
  }
}
