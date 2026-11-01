# StateAction.ai mobile collector

The existing Flutter collector and its Pixel recording/playback fixes are now
ordinary monorepo source. The native Dart/Kotlin/Swift recorder lives in
[`packages/stera_recorder`](../../packages/stera_recorder/README.md); its relative
path dependency is unchanged. Upstream [license and import provenance](../../third_party/stera-app/IMPORT.md)
are retained separately.

This source move preserves current behavior. The existing JPEG MCAP recorder is
distinct from the unqualified H.264 feasibility spike. Neither the move nor an
APK build establishes sensor synchronization, model accuracy, or two-hour
reliability. See the [current workspace status](../../README.md) and
[mobile implementation plan](../../docs/components/mobile-app-implementation.md).

## Local Android setup

From the repository root, using the pinned Flutter 3.44.6/Dart 3.12.2 toolchain:

```sh
source scripts/env.sh
cd apps/mobile
# On a new checkout only, create the required private Flutter asset.
test -f .env || printf 'NO_AUTH_MODE=true\n' > .env
flutter pub get --enforce-lockfile
flutter analyze --no-pub
flutter test --no-pub
flutter build apk --debug --target-platform android-x64 --no-pub
```

`.env` must exist because Flutter bundles it. Keep it ignored; no-auth mode
supports local recording/preview without creating accounts or uploading data.
Use `.env.example` when configuring authentication explicitly. Existing private
configuration and signing keys must stay local.

For native JVM/encoder-fixture tests, run the maintained emulator-only helper
from the repository root:

```sh
scripts/test_android_capture.sh emulator-5580
```

Run simulation/local end-to-end checks before requesting a physical test.
Physical operations must follow the repository's [personal-profile restrictions](../../AGENTS.md),
and recording requires the user's intentional Start. Never invoke an unscoped
`flutter run`, `connectedAndroidTest`, or ADB app mutation against connected
devices. A simulator's unavailable ARCore capability remains an explicit
qualification limit.

## Backend and capture implementation

The legacy Bun server/auth packages were excluded from this import. The new
[auth/access](../../docs/components/auth-and-access.md),
[upload](../../docs/components/mcap-upload.md), and
[local development](../../docs/components/local-development.md) documents define
the Node.js/TypeScript/Render integration to implement. Existing auth/upload
client code is migration input, not proof that the replacement backend works.
Configuration helpers under `tool/` remain Dart commands; no Bun setup is needed.

The [capture-format contract](../../docs/components/capture-format.md) specifies
future H.264 MCAP and raw-sensor requirements. Keep existing recordings immutable.
The iOS source is preserved, but this import is qualified only by the stated
Android/local checks; iOS builds and signing require macOS follow-up.

Private captures pulled by the helpers stay under ignored local `logs/` or
`captures/`; do not add them to Git. Source-import checks and deliberate bootstrap
changes are recorded in the [migration receipt](../../docs/validation/mobile-source-import.json).
