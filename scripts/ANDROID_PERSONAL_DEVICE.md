# Personal-profile Android helper

`android_personal_device.py` is the required guarded path for physical-device app install/update, launch and runtime permission grants. **Company/work profiles are forbidden.** Complete emulator/local qualification before involving the user's phone. This helper does not qualify camera hardware or authorize a physical capture; capture still requires the user's intentional Start.

The helper requires both `--serial` and numeric `--user`. It reads the verbose Android profile inventory, verifies the current personal full user independently, checks only the exact requested package across users and repeats checks after mutation. It rejects managed profiles, device/profile owners, unknown or ambiguous types, and existing non-target copies. Other users' existing copies matter because APK code updates can affect that package globally. No account/policy or unrelated app inventory is requested.

On the previously inspected Pixel, personal was user **0** and work was user **10**. Those are observations, never defaults. Reverify each session. Unknown formats/permissions fail closed; do not fall back to raw unscoped ADB commands.

From the project root, source the existing SDK environment and run the read-only check or install dry-run first:

```bash
source scripts/env.sh
python3 scripts/android_personal_device.py --serial SERIAL --user 0 check --package ai.stateaction.spike.capture
python3 scripts/android_personal_device.py --serial SERIAL --user 0 install --package ai.stateaction.spike.capture --apk /absolute/path/app-debug.apk --dry-run
```

`check` requires that exact package already be installed in personal and absent elsewhere; a missing personal install is a refusal. The install dry-run permits a missing personal copy, validates the APK's actual package using SDK `aapt2`, performs read-only scope checks and prints the proposed command without executing it. Pass `--aapt2 /path/aapt2` if SDK discovery is unavailable.

After the read-only checks and simulation prerequisites pass:

```bash
python3 scripts/android_personal_device.py --serial SERIAL --user 0 install --package ai.stateaction.spike.capture --apk /absolute/path/app-debug.apk
python3 scripts/android_personal_device.py --serial SERIAL --user 0 grant --package ai.stateaction.spike.capture --permission android.permission.CAMERA
python3 scripts/android_personal_device.py --serial SERIAL --user 0 start --component ai.stateaction.spike.capture/.MainActivity
```

Install uses `--user VERIFIED_ID -r`, preserving existing app data; `--test-apk` additionally permits a test-only APK. Start/grant also use the verified `--user`. The helper has no clear/uninstall/profile/policy command. An uncertain result, unexpected diagnostics or changed post-operation scope stops with an error; it never retries, removes apps or attempts a work-profile cleanup automatically. A user/profile change concurrent with ADB cannot be made atomic, so after-checks remain mandatory.

Safety tests contact no device:

```bash
python3 -m unittest discover -s tests -p test_android_personal_device.py -v
```

The parser follows the [AOSP verbose user-list implementation](https://android.googlesource.com/platform/frameworks/base/+/refs/heads/main/services/core/java/com/android/server/pm/UserManagerServiceShellCommand.java), including abbreviated `full.SYSTEM` / `profile.MANAGED` types. The helper itself has only Python standard-library dependencies, plus the existing Android SDK commands.
