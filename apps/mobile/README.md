# StateAction.ai mobile collector

The Flutter collector and its existing Pixel recording/playback fixes live here as
ordinary monorepo source. The Dart/Kotlin/Swift recorder lives in
[`packages/stera_recorder`](../../packages/stera_recorder/README.md). The relative
path dependency remains unchanged; no old app submodule or Bun backend is needed.
[Upstream history, license and import evidence](../../third_party/stera-app/IMPORT.md)
are preserved.

This import preserves the existing JPEG MCAP recording behavior. It does not add
H.264, replace authentication/uploads, change the collector UI, or qualify device
accuracy and long recordings. iOS source is retained; Linux checks do not qualify
its build or signing.

Use the [mobile setup and Nx commands](../../scripts/mobile/README.md). Flutter
and Gradle still perform the actual work; Nx selects and orders their tasks. Both
app and recorder dependencies have committed lockfiles. The bootstrap creates a
missing ignored `.env` containing only `NO_AUTH_MODE=true` and preserves existing
private configuration. Flutter bundles this asset, so APK builds are deliberately
uncached and must never be added to Git.

Run local simulations and automated checks before involving the user's phone.
Every physical-device operation must use the
[personal-profile helper](../../scripts/ANDROID_PERSONAL_DEVICE.md); company/work
profiles are forbidden. Capture requires the user's intentional Start. Never use
an unscoped `flutter run`, `connectedAndroidTest` or ADB app mutation.

The small synthetic MCAP under `test/fixtures/` is a controlled regression input.
Real captures, copied images, local logs and APKs stay ignored.
