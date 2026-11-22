# Emulator defaults and simulation before user testing

Mandatory. Launcher options, acceleration proof and display handling are also described in [linux-recording-test-loop.md](../linux-recording-test-loop.md); the guard is in [workstation-resource-guard.md](../components/workstation-resource-guard.md). Where the two disagree, fix them in the same PR.

## Simulation before user testing

Always run and iterate on simulations/emulators and local end-to-end tests before handing a build to the user. Test the actual changed camera/encoder/recording path where the simulator supports it; build/unit/protocol checks alone do not qualify that path. Reproduce and fix accessible failures without asking the user to keep retrying. Ask for physical testing only for a clearly identified hardware-only limitation after local checks pass, and report simulation coverage honestly.

The existing Stera checkout is **our temporary work**, not another engineer's active changes. Use its existing recorder as the starting point rather than rebuilding working app behavior unnecessarily. Preserve our existing work and unrelated edits; use an isolated branch/worktree when appropriate. Standalone test package IDs remain useful to avoid replacing the collector.

Capture on the physical phone requires an intentional user Start action. Raw recordings and captured images stay in ignored local directories, never in Git.

## Accelerated emulator defaults

Launch with [`scripts/supervise_capture_emulator.sh`](../../scripts/supervise_capture_emulator.sh) in a persistent terminal; it enters its own bounded control scope and keeps the guarded SDK supervisor alive across heavy jobs. Do not nest it under `agent-resource run`. Use `agent-resource run -- bash scripts/start_capture_emulator.sh --ar --verify-only` to verify the warm API33 instance; do not hand-start `emulator`. On this Linux x86_64 workstation the default is KVM (`-accel on`), an x86_64 guest and host GPU rendering (`-gpu host`, the RTX 3090). Software rendering is never a silent default or fallback.

- ARCore work uses `--ar`: the pinned API33 x86_64 AVD `stera_ar_api33` (`emulator-5582`) with emulator 36.4.10 and Vulkan off. Do not reset or reinstall the AVD, update the global SDK, or replace the pinned emulator for speed. Keep the separate API35 `stera_ar_api35` (`emulator-5580`) for ordinary tests.
- Reuse one warm dedicated emulator. The launcher reuses a running instance only after verification: a `/dev/kvm` descriptor open in the qemu process, `-accel on -gpu host`, and a guest renderer (`dumpsys SurfaceFlinger` GLES line) naming the host NVIDIA GPU with no SwiftShader, llvmpipe or lavapipe. A running instance that fails is not reused; `--replace` restarts only the dedicated emulator. `nvidia-smi` alone is not proof.
- Camera, lifecycle and recovery tests keep the default cold boot (`-no-snapshot`). `--quick-boot` is opt-in for ordinary app tests only. Default warm reuse is fine for routine loops; for a cold-start case (camera, lifecycle, recovery) pass explicit `--force-cold-start`, which stops and restarts even a healthy warm dedicated instance (and overrides `--quick-boot`).
- Display: honor a caller-provided `DISPLAY`/`XAUTHORITY`; otherwise the launcher discovers a working same-user display using `xdpyinfo` and fails closed with instructions. Never `xhost +`, change display-server or desktop policy, read or print authority cookies, or hardcode an authority file name.
- `--software` (or `CAPTURE_EMULATOR_PROFILE=software`) is the explicit CI/compatibility override. Its output and evidence carry the label `software-rendering-not-accelerated` and must never be cited as accelerated evidence. Earlier software-rendered results stay valid but labeled as such.
- Report acceleration as rendering only: the guest video encoder stays software, and emulator results are never physical-device qualification. Make no speedup claim without comparable timings of the same task.
- Run expensive emulator, Flutter and Gradle work in the `emulator` lane (emulator sessions) or `android-build` (Flutter/Gradle builds), with no ad hoc lock files, use incremental builds, and do not weaken recorder assertions for speed. Verification evidence is written to the ignored `artifacts/emulator-verification/`.
