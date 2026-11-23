# Android device profile (personal profile only)

Mandatory. `AGENTS.md` carries the one-line prohibition; this is the full procedure. The guarded helper and its dry-run workflow are in [scripts/ANDROID_PERSONAL_DEVICE.md](../../scripts/ANDROID_PERSONAL_DEVICE.md).

**Never install, update, launch or test apps in the user's company/work profile.** The user explicitly requires personal-profile-only operations. This applies to all agents, scripts, APKs and test packages, including spike apps. Permission to open the phone or test an app does not override this restriction.

Before a physical-device app mutation, identify profiles with `adb -s "$ANDROID_SERIAL" shell cmd user list -v` and verify the personal full user. On the Pixel checked on 2026-10-31, personal is **user 0** and the managed Work profile is **user 10**. Recheck each session rather than assuming these IDs on another device.

- Install/update only with an explicit verified target: `adb -s "$ANDROID_SERIAL" install --user 0 -r "$APK"`.
- Launch only with `adb -s "$ANDROID_SERIAL" shell am start --user 0 -n "$COMPONENT"`.
- Include the verified personal `--user` for permission grants, force-stop, data clearing and uninstall. Never use unscoped app mutations or `--user all`.
- Verify the exact test package is installed in the personal profile and absent from work/managed profiles. Do not enumerate company accounts or unrelated company apps.
- Never alter work-profile policies/security. If targeting is ambiguous or unsupported, stop and report it.
- The accidental work-profile copy of `ai.stateaction.spike.capture` was removed and its absence verified. Do not reinstall it there.
