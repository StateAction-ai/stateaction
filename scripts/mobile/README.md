# Mobile source and checks

Local builds, tests and generated probes must use
`agent-resource run -- <command>` and the shared guarded emulator. The launcher
and both installed SDK entrypoints enforce one VM across all AVDs/ports. A shared
dynamic cgroup (zero swap, at most 24 GiB, bounded by the 80% host-RAM ceiling), 6 GiB per workload, a serialized build slot and host
memory reserve prevent unbounded Gradle/emulator work. Install and verify the
[workstation guard](../../docs/components/workstation-resource-guard.md) first;
refusal never permits an unbounded retry. Local `run.py` enters it automatically.

The existing collector is `apps/mobile`; its reusable recorder is
`packages/stera_recorder`. Both are real Nx projects using Flutter/pub and Gradle,
not Node packages. Imported upstream ancestry and source evidence are retained in
[the import record](../../third_party/stera-app/IMPORT.md) and
[historical receipt](../../docs/validation/mobile-source-import.json). Current
SA-10 checks and intentional import adaptations are in the
[qualification record](../../docs/validation/sa-10-import.json).

Use the pinned [mobile toolchain](../../config/mobile-toolchain.json): Flutter
3.44.6/Dart 3.12.2, JDK 21, Android SDK 36, NDK 28.2.13676358 and Gradle 8.14.
Use [the platform setup](../platform/README.md) for pinned Node/pnpm/uv. On a clean
Linux clone, install the pinned Temurin 21.0.12.1+1 JDK and set `JAVA_HOME` to its
installation, then run:

From the repository root:

```sh
python3 scripts/platform/install-mobile-toolchain.py
source artifacts/platform-tools/mobile/env.sh
make install
make check
pnpm affected --base=origin/main --head=HEAD
```

The bootstrap verifies official archive checksums and Android package revisions.
The [Android CI job](../../.github/workflows/checks.yml) uses the same toolchain.
On this existing development host only, `source scripts/env.sh` exposes the
previously installed SDKs. CI does not source that host-specific file.

## Android CI footprint

The standard private Ubuntu runner has [2 CPUs, 8 GB RAM and 14 GB guaranteed free disk headroom](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).
The Android job removes only unused .NET, Haskell/GHCup, CodeQL and Swift
installation directories from the ephemeral GitHub-hosted Ubuntu 24.04 image;
the helper refuses local hosts, self-hosted runners and other jobs. These fixed
paths come from the official [runner-image installers](https://github.com/actions/runner-images/tree/main/images/ubuntu/scripts/build).
Within the fixed preinstalled SDK, it also removes unused numeric side-by-side
NDK version directories while preserving the configured NDK 28.2.13676358,
unknown entries and symlinks. Foreign or symlinked SDK roots are refused.
Android supports selecting the required version through
[`ndkVersion`](https://developer.android.com/studio/projects/install-ndk);
API platforms, build-tools, SDK managers and Java remain installed. The job
also sets `ANDROID_NDK`, `ANDROID_NDK_HOME` and `ANDROID_NDK_ROOT` to that pinned
version so native-asset tooling does not select a removed runner default.
After SDK setup it requires 20 GiB for the build plus a real 1 GiB log reserve.
During the build, a monitor stops its process group at 2 GiB free, releases the
reserve and fails the check so runner diagnostics can finish. The reserve is
also released on success, failure or termination. The actual VM disk may be
larger than the [guaranteed headroom](https://github.com/actions/runner-images/discussions/9329).

CI explicitly uses `--reuse-android-sdk` with its [preinstalled Android SDK](https://github.com/actions/runner-images/blob/main/images/ubuntu/Ubuntu2404-Readme.md),
verifies API 36 revision 2, build-tools 36.0.0 and NDK 28.2.13676358, and installs
only missing pinned packages. Command-line tools 23.0 use an owned directory when
the runner's existing tools differ; existing SDK tools are preserved. Verified
download archives are deleted after extraction. The bootstrap avoids broad
Android precaching; the x64 debug build fetches its required artifacts. Disk
usage is logged before setup, during bootstrap and after the job. Local setup
without this explicit flag continues to use an isolated SDK under `artifacts/`.

CI uses the pinned [subosito/flutter-action](https://github.com/subosito/flutter-action)
for its official Flutter SDK and public pub-package cache. The bootstrap's
`--reuse-flutter` flag verifies that selected SDK's exact Flutter/Dart/revision
without downloading a second SDK. Local setup without the flag retains the
checksum-pinned isolated installation. The official
[gradle/actions/setup-gradle](https://github.com/gradle/actions/tree/main/setup-gradle)
provides free basic caching of dependencies, the wrapper, compiled build scripts
and public dependency transforms. Android CI disables Gradle task-output and
configuration caches. Project APKs, `.env` and captures are outside the cached
paths. Build and test commands still execute; restored caches do not qualify them.

CI runs analysis, Dart unit/widget tests, native JVM tests and Android APK
assembly using the [command-line build tools](https://developer.android.com/build/building-cmdline).
Instrumentation APK assembly compiles test code; it does not execute tests in an
emulator or on a device.

`prepare` runs locked pub resolution, including the retained recorder example.
It creates only a missing `.env` asset with
`NO_AUTH_MODE=true`; an existing private asset is preserved. Keep both app and
recorder and recorder-example `pubspec.lock` files committed. The app depends on the recorder in the
Nx graph. Native JVM tests and instrumentation APK assembly complete before the
actual app APK build, avoiding concurrent Gradle writes. They do not run or
install instrumentation on a device. Gradle has a 3 GB heap, 1 GB metaspace cap,
two workers and a 512 MB Kotlin daemon heap to fit the small Linux CI runner.

Format targets check Git-visible Dart and supported config/docs throughout each
project, including tools and examples. Generated build/SDK state is excluded;
the Dart language floor and formatter match the installed staged hook.

The app APK target has caching disabled: Flutter bundles `.env`, and private
configuration must never enter the Nx cache. Generated Flutter/Gradle state,
private assets and build outputs are excluded from source inputs. Analysis,
unit tests and public native fixture outputs use declared source/toolchain
inputs. Real device/capture checks must always run uncached.

The inherited recorder uses JPEG messages in MCAP. H.264 processing, cloud
workers, auth/upload replacement and UI changes belong to subsequent tickets.
The synthetic checked-in MCAP regression fixture is not contributor footage.

Before any physical test, finish local checks and follow the
[personal-profile rules](../../AGENTS.md) and
[guarded helper](../ANDROID_PERSONAL_DEVICE.md). This source import performs no
device operation, and no passing host build qualifies physical camera behavior,
thermal performance or iOS signing.
