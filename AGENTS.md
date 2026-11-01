# StateAction.ai agent instructions

## Android device profile: mandatory

**Never install, update, launch or test apps in the user's company/work profile.** The user explicitly requires personal-profile-only operations. This applies to all agents, scripts, APKs and test packages, including spike apps. Permission to open the phone or test an app does not override this restriction.

Before a physical-device app mutation, identify profiles with `adb -s "$ANDROID_SERIAL" shell cmd user list -v` and verify the personal full user. On the Pixel checked on 2026-10-31, personal is **user 0** and the managed Work profile is **user 10**. Recheck each session rather than assuming these IDs on another device.

- Install/update only with an explicit verified target: `adb -s "$ANDROID_SERIAL" install --user 0 -r "$APK"`.
- Launch only with `adb -s "$ANDROID_SERIAL" shell am start --user 0 -n "$COMPONENT"`.
- Include the verified personal `--user` for permission grants, force-stop, data clearing and uninstall. Never use unscoped app mutations or `--user all`.
- Verify the exact test package is installed in the personal profile and absent from work/managed profiles. Do not enumerate company accounts or unrelated company apps.
- Never alter work-profile policies/security. If targeting is ambiguous or unsupported, stop and report it.
- The accidental work-profile copy of `ai.stateaction.spike.capture` was removed and its absence verified. Do not reinstall it there.

## Simulation before user testing

Always run and iterate on simulations/emulators and local end-to-end tests before handing a build to the user. Test the actual changed camera/encoder/recording path where the simulator supports it; build/unit/protocol checks alone do not qualify that path. Reproduce and fix accessible failures without asking the user to keep retrying. Ask for physical testing only for a clearly identified hardware-only limitation after local checks pass, and report simulation coverage honestly.

The existing Stera checkout is **our temporary work**, not another engineer's active changes. Use its existing recorder as the starting point rather than rebuilding working app behavior unnecessarily. Preserve our existing work and unrelated edits; use an isolated branch/worktree when appropriate. Standalone test package IDs remain useful to avoid replacing the collector.

Capture on the physical phone requires an intentional user Start action. Raw recordings and captured images stay in ignored local directories, never in Git.

## Linear and pull request traceability

- Work from the applicable Linear ticket and keep its acceptance criteria, evidence and remaining gates current.
- Use an issue branch such as `sa-11-platform-foundations`; include the primary issue ID in each PR title: `SA-11: Scaffold platform foundations`.
- Include `Refs SA-11` in the PR body for partial work. Use `Fixes SA-11` only when every acceptance criterion is demonstrated and merge should complete the ticket. Reference other affected tickets separately.
- Record the actual PR URL on the ticket after publication and verify the native GitHub integration link. A pasted commit hash or a configured Git remote is not a verified integration.
- Use PRs for new work; do not commit new implementation directly on `main`, rewrite existing implementation history, or mark a ticket Done merely because local checks passed.
