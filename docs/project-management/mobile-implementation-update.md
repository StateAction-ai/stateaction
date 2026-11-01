# Mobile implementation update

2026-10-31 · [Live project](https://linear.app/hw-personal-projects/project/stateactionai-collection-and-review-mvp-392311683a3e) · [Mobile implementation in Linear](https://linear.app/hw-personal-projects/document/mobile-implementation-h264-capture-and-reliable-upload-5677599f65bd).

This addendum adds **10 tickets**, amends **14 existing tickets** and strengthens four milestone gates. The combined plan has **50 tickets, six milestones and 90 dependencies**. The original 40-ticket import remains a historical snapshot; live state/owners/dates belong to Linear. [Final remote receipt](linear-mobile-update-receipt.json), [reviewed changes](mobile-implementation-addendum.json), [local graph validation](mobile-plan-validation.json).

## Engineering entry points

- [Mobile implementation](../components/mobile-app-implementation.md): collector screens, Flutter/native bridge, ownership/auth, capture/transfer state machines, native scheduling and recovery.
- [Capture format](../components/capture-format.md): exact generic MCAP encodings, H.264 packetization, frame/clock/calibration evidence, hardware profile candidates, EOS and source integrity.
- [Processing](../components/cloud-processing.md) and [Rerun](../components/rerun-clip-review.md): bounded mixed-source reader, native MP4 remux, safe clip RRDs and matched 0.41.0 SDK/viewer.

## Added implementation work

| Ticket | Outcome | Milestone |
| --- | --- | --- |
| [SA-50](https://linear.app/hw-personal-projects/issue/SA-50/specify-h264-mcap-capture-schemas-and-cross-language-golden-fixtures) | Specify H.264 MCAP capture schemas and cross-language golden fixtures | M0 |
| [SA-51](https://linear.app/hw-personal-projects/issue/SA-51/implement-android-hardware-h264-frame-messages-in-mcap) | Implement Android hardware H.264 frame messages in MCAP | M1 |
| [SA-52](https://linear.app/hw-personal-projects/issue/SA-52/implement-ios-hardware-h264-frame-messages-in-mcap) | Implement iOS hardware H.264 frame messages in MCAP | M1 |
| [SA-53](https://linear.app/hw-personal-projects/issue/SA-53/preserve-independent-raw-imu-events-and-original-sensor-clocks) | Preserve independent raw IMU events and original sensor clocks | M1 |
| [SA-54](https://linear.app/hw-personal-projects/issue/SA-54/fix-saved-raster-calibration-capture-settings-and-tracking-loss-rgb) | Fix saved-raster calibration, capture settings and tracking-loss RGB | M1 |
| [SA-55](https://linear.app/hw-personal-projects/issue/SA-55/preserve-available-depth-confidence-and-honest-sensor-provenance) | Preserve available depth, confidence and honest sensor provenance | M1 |
| [SA-56](https://linear.app/hw-personal-projects/issue/SA-56/make-native-capture-finalization-bounded-and-evidence-complete) | Make native capture finalization bounded and evidence complete | M1 |
| [SA-57](https://linear.app/hw-personal-projects/issue/SA-57/implement-durable-android-background-multipart-uploads) | Implement durable Android background multipart uploads | M1 |
| [SA-58](https://linear.app/hw-personal-projects/issue/SA-58/fix-ios-native-retry-loops-and-background-completion-lifecycle) | Fix iOS native retry loops and background completion lifecycle | M1 |
| [SA-59](https://linear.app/hw-personal-projects/issue/SA-59/qualify-the-mobile-h264-profile-hand-detail-and-resource-budget) | Qualify the mobile H.264 profile, hand detail and resource budget | M2 |

## Existing work amended

- [SA-10](https://linear.app/hw-personal-projects/issue/SA-10/migrate-the-mobile-recorder-and-sdk-into-the-monorepo-safely): Migrate the mobile app and native recorder into the monorepo safely.
- [SA-12](https://linear.app/hw-personal-projects/issue/SA-12/publish-versioned-api-task-and-artifact-contracts): Publish versioned API, task and artifact contracts.
- [SA-17](https://linear.app/hw-personal-projects/issue/SA-17/integrate-mobile-login-and-immutable-capture-ownership): Integrate mobile login and immutable capture ownership.
- [SA-18](https://linear.app/hw-personal-projects/issue/SA-18/finalize-and-hash-closed-source-files-before-upload): Finalize and hash closed source files before upload.
- [SA-19](https://linear.app/hw-personal-projects/issue/SA-19/register-recordings-and-seal-the-required-file-inventory): Register recordings and seal the required-file inventory.
- [SA-22](https://linear.app/hw-personal-projects/issue/SA-22/implement-the-owner-bound-flutter-resumable-uploader): Implement the owner-bound Flutter resumable uploader.
- [SA-23](https://linear.app/hw-personal-projects/issue/SA-23/complete-collector-recovery-states-and-verified-local-cleanup): Complete collector recovery states and verified local cleanup.
- [SA-24](https://linear.app/hw-personal-projects/issue/SA-24/prove-cpu-hand-overlays-and-real-rerun-playback-early): Prove CPU hand overlays and real Rerun playback early.
- [SA-29](https://linear.app/hw-personal-projects/issue/SA-29/stream-mcap-and-decode-frames-with-bounded-memory): Stream MCAP and decode frames with bounded memory.
- [SA-31](https://linear.app/hw-personal-projects/issue/SA-31/write-bounded-clip-artifacts-and-a-portable-reader): Write bounded clip artifacts and a portable reader.
- [SA-32](https://linear.app/hw-personal-projects/issue/SA-32/persist-inline-quality-checks-and-reject-corrupt-candidates): Persist inline quality checks and reject corrupt candidates.
- [SA-38](https://linear.app/hw-personal-projects/issue/SA-38/embed-the-real-shared-rerun-viewer-safely): Embed the real shared Rerun viewer safely.
- [SA-43](https://linear.app/hw-personal-projects/issue/SA-43/qualify-real-r2-multipart-and-private-viewer-transfers): Qualify real R2 multipart and private viewer transfers.
- [SA-48](https://linear.app/hw-personal-projects/issue/SA-48/qualify-a-signed-device-two-hour-capture-through-cloud-review): Qualify a signed-device two-hour capture through cloud review.

## Order and release gates

Start the coordinated mobile-source handoff and shared contracts, then the capture schema/golden fixture. Android/iOS encoder and sensor corrections can proceed independently after that contract. Their bounded lifecycle/EOS evidence gates native source finalization. Android/iOS transfer work feeds the shared Flutter uploader. The early CPU/Rerun fixture gate remains independent of full hosted deployment; codec/device qualification and the signed two-hour end-to-end gate block pilot release.

The selected new source is hardware H.264 inside MCAP, not separate MP4 capture or a silent JPEG fallback. Preserve original sensor clocks/data, exact saved-raster calibration and actual write/drop evidence. Full Python Stera SDK is optional reviewed reuse; the native recorder remains required.

A fresh Python 3.12 / Rerun 0.41.0 / MediaPipe 1.2.0 / PyAV 19.0.2 environment passed a [small CPU dependency/serialization smoke](../validation/mobile-worker-dependency-smoke-20261031.json), resolving the old NumPy conflict. That proves imports/model loading and three synthetic encoded frames, **not** phone hardware capture, real MCAP/browser playback, hand quality or two-hour reliability. Those remain explicit ticket acceptance gates. No paid compute or application/native code change was performed for this planning update.
