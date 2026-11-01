/// StateAction v1 contract validation, shared with the TypeScript and Python
/// adapters. Pure Dart (no dart:io) so Flutter can load schemas from assets.
library;

export 'src/canonical.dart';
export 'src/rules.dart' show Violation, checkSealedInventory, handArrayShapes;
export 'src/validate.dart';
