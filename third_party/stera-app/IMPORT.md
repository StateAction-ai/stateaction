# Stera mobile source import

Source repository: https://github.com/timothywangdev/stera-app.git

Imported revision: `8044ad672dbf03cd6db8690f260c145b9acd51ea` (2026-10-31). The clean temporary checkout includes our Pixel recording/geometry/orientation fixes. SA-10 preserves that upstream revision as the second parent of an import merge and selectively restores the source from migration `f0945cfdd06ed0ed3278654a20236b3ba85220e9`.

- `apps/mobile/` retains the complete Flutter/mobile platform source, assets and tests.
- `packages/stera_recorder/` retains the complete native Flutter plugin, FFI, examples, assets and tests.
- Legacy Bun `package.json` wrappers in these two folders are omitted. No Bun backend/package/deployment infrastructure is imported.
- Relative Flutter path dependency remains `../../packages/stera_recorder`. App IDs, native names, database migrations and existing capture behavior remain intact.
- Local credentials, `.env`, signing material, raw captures, caches and build outputs are not part of the source import.

The initial source inventory and three Gradle-wrapper bootstrap additions are retained in [the historical receipt](../../docs/validation/mobile-source-import.json). The current [SA-10 qualification record](../../docs/validation/sa-10-import.json) records subsequent whitespace normalization, pinned Dart formatting, generated-state exclusions, the internal recorder dependency lock, bounded Gradle build memory and Nx adapters. These are import/tooling adaptations; the inherited JPEG-in-MCAP recorder behavior is retained. H.264 and later UI/processing work are excluded.

Original Apache-2.0 LICENSE and NOTICE are retained beside this file; the plugin LICENSE and font OFL notice remain in their source directories. No claim of physical camera, upload-service or iOS qualification follows from this source import.
