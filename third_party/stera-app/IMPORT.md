# Stera mobile source import

Source repository: https://github.com/timothywangdev/stera-app.git

Imported revision: `8044ad672dbf03cd6db8690f260c145b9acd51ea` (2026-10-31). The clean temporary checkout includes our Pixel recording/geometry/orientation fixes; root migration preserves its Git history separately.

- `apps/mobile/` retains the complete Flutter/mobile platform source, assets and tests.
- `packages/stera_recorder/` retains the complete native Flutter plugin, FFI, examples, assets and tests.
- Legacy Bun `package.json` wrappers in these two folders are omitted. No Bun backend/package/deployment infrastructure is imported.
- Relative Flutter path dependency remains `../../packages/stera_recorder`. App IDs, native names, database migrations and existing capture behavior remain intact.
- Local credentials, `.env`, signing material, raw captures, caches and build outputs are not part of the source import.

Original Apache-2.0 LICENSE and NOTICE are retained beside this file; the plugin LICENSE and font OFL notice remain in their source directories. Source checksums, deliberate wrapper bootstrap changes and validation are recorded in `docs/validation/mobile-source-import.json`.
