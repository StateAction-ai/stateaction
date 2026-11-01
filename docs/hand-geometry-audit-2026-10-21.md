# Pixel hand and body geometry audit

**Disposition: reject the current 3D hand/body annotations as trusted training labels.** The raw recording remains useful for debugging and visual tasks, subject to their own requirements. The previous world-up correction fixed the body's vertical sign only. It did not validate the hand estimates, depth alignment or camera transform. Stera's 97/100 health score does not test these failures.

Audited capture: `session_20261021_210417`, using `stera_processed_y_up`. This was handheld, not head-mounted. All checks run locally; no raw capture or existing processed artifact was modified. Diagnostics are separate derived files.

## Evidence to open first

- [Spatula frame: 2D landmarks versus projected 3D](../captures/session_20261021_210417/geometry_audit/frame_79_comparison.png). Both panels show the same frame and crop. The wrist agrees, while the projected fingers are too small and displaced.
- [Representative hand frames](../captures/session_20261021_210417/geometry_audit/representative_contact_sheet.png).
- [Recorded versus rotated depth](../captures/session_20261021_210417/depth_orientation_audit_v2/depth_orientation.png). The depth layout matches the RGB much better after a 180-degree rotation.
- [Hand measurements and hypotheses](../captures/session_20261021_210417/geometry_audit/report.json), [per-hand CSV](../captures/session_20261021_210417/geometry_audit/per_hand_frame.csv), and [depth-orientation measurements](../captures/session_20261021_210417/depth_orientation_audit_v2/report.json).

## 1. The 2D overlay does not validate the 3D hand

The SDK keeps MediaPipe's image landmarks and its separate 3D hand-shape prediction. It subtracts the 3D wrist, estimates an absolute wrist position from depth, then translates the entire predicted hand shape to that wrist. The green image overlay displays the original 2D landmarks, not a reprojection of the exported 3D hand. See [tracker.py](../stera-sdk/src/stera/models/mediapipe/tracker.py#L155).

Across 135 detected hands, projecting the exported 3D finger joints through the exported RGB intrinsics disagrees with the saved 2D predictions by **93.17 px median**, **154.36 px p90**. For the 131 right hands, the corresponding median is **93.85 px**. The wrist agrees almost exactly because it was constructed from its image pixel. Excluding image-outside landmarks leaves a median of 93.07 px, so the failure is not driven only by clipped hands.

This measures **internal consistency**, not accuracy against ground truth: the 2D predictions and camera calibration also need validation. Nevertheless, a reconstruction that disagrees with its own image evidence is unsuitable for acceptance as accurate 3D labeling.

All 48 global signed axis permutations were tested on wrist-relative joints, keeping the wrist fixed. Identity was best by both median and RMS error. A uniform axis swap or flip does not solve the finger mismatch. This experiment concerns the local hand shape; it does not clear the separate world-transform error.

Fitting translation alone to the same 2D predictions reduces the overall median disagreement to 28.30 px; per-frame rigid PnP reduces it to 20.69 px. These are diagnostic fits, not validated replacement labels. They optimize the same predictions used to score them and cannot establish the actual positions of occluded fingers. MediaPipe documents image landmarks and hand-centered world landmarks as distinct outputs. [Official output documentation](https://developers.google.com/edge/mediapipe/solutions/vision/hand_landmarker/python#handle_and_display_results).

## 2. Depth anchoring samples an inconsistent image layout

The Android recorder saves display-transformed GPU RGB, but logs unrotated CPU-image intrinsics and unmodified depth. ARCore explicitly distinguishes physical-camera pose, display-oriented pose, CPU-image intrinsics and GPU-texture intrinsics. These cannot be mixed without the appropriate coordinate mapping. [ARCore camera contracts](https://developers.google.com/ar/reference/java/com/google/ar/core/Camera).

Relevant source:

- [ArRecorderImpl.kt](../packages/stera_recorder/android/src/main/kotlin/open/fpvlabs/stera/ar_recorder/ArRecorderImpl.kt#L380): sets display geometry and computes transformed texture UVs.
- [RecordingFrameOrchestrator.kt](../packages/stera_recorder/android/src/main/kotlin/open/fpvlabs/stera/ar_recorder/coordination/RecordingFrameOrchestrator.kt#L145): uses those UVs to render saved JPEGs.
- [ArFrameProcessorImpl.kt](../packages/stera_recorder/android/src/main/kotlin/open/fpvlabs/stera/ar_recorder/session/ArFrameProcessorImpl.kt#L312): uses `camera.imageIntrinsics` for calibration.
- [SessionLifecycleManager.kt](../packages/stera_recorder/android/src/main/kotlin/open/fpvlabs/stera/ar_recorder/session/SessionLifecycleManager.kt#L28): preview and configured recording dimensions are equal. A differing preview aspect ratio is not the explanation for this capture.

The saved capture does not retain the display rotation, per-frame UV mapping or GPU texture intrinsics needed to fully reconstruct and validate that chain.

An independent eight-frame comparison of RGB and inverse-depth edge magnitudes gives median correlation **−0.155 as recorded**, versus **+0.353 with depth rotated 180 degrees**. That rotation wins on all eight frames. The images also show the rice cooker and surrounding layout moving into the expected orientation. Edge correlation is only a diagnostic: intensity edges need not be depth edges, and this does not establish exact crop, focal length, metric accuracy or temporal alignment.

The SDK's default wrist sampler uses a **15×15 depth-pixel patch**, approximately **180×180 RGB pixels** in this recording. It takes the first valid patch among wrist and four MCP joints. All 135 anchors reproduce those patch medians: 116 from wrist, 18 middle MCP and one index MCP. Background depth can dominate such a patch. Fallback MCP depth is also used directly as wrist depth without accounting for the joint offset. The advertised temporal depth buffer is used only when current sampling fails.

In frame 79 at approximately 5.334 seconds, the saved wrist depth is **0.741 m**. Rotating only the lookup depth gives **0.483 m**, while a translation-only fit to the 2D landmarks gives approximately **0.466 m**. The numerical agreement supports depth misalignment as a contributor to the shrunken projection; neither alternative is ground truth.

Across all 135 hands, changing only that lookup orientation reduces median disagreement from 93.17 to **62.37 px**. A substantial mismatch remains. The experiment deliberately retains the saved wrist ray, calibration and relative hand shape; it is not a complete correction, and no corrected episode was exported.

## 3. The world transform and body assumptions are separate failures

The recorder's fixed [optical transform](../packages/stera_recorder/android/src/main/kotlin/open/fpvlabs/stera/ar_recorder/data/MCAPDatasetWriter.kt#L39) swaps optical X and Z. It maps optical forward onto physical-camera X, inconsistent with the ARCore physical-camera pose it records. An unrotated optical camera would instead use `diag(1,-1,-1)` to convert into ARCore's physical camera coordinates. The displayed JPEG's additional rotation must also be included; replacing the fixed matrix alone is insufficient.

The body is inferred from a camera assumed to sit near the head, fixed torso dimensions and detected wrists. It is not measured full-body motion. A handheld phone provides no trustworthy torso location. Every detected arm in this capture exceeds the estimator's configured 0.60 m total reach. The [IK fallback](../stera-sdk/src/stera/models/skeleton/estimator.py#L92) leaves an unreachable wrist in place, yielding right forearms of **0.670 m median** against a configured 0.27 m. Those frames should be marked unreachable, not accepted as plausible body geometry.

Finally, the SDK's exported hand confidence is the **MediaPipe handedness classification score**, assigned at [tracker.py](../stera-sdk/src/stera/models/mediapipe/tracker.py#L151). It does not certify finger accuracy, wrist depth, grasp correctness or contact. The observed median score of about 0.965 cannot override these failures.

## Concrete engineering sequence

1. **Repair and verify the capture coordinate contract first.** Prefer saving an unrotated CPU camera image with its matching intrinsics, physical camera pose, correct optical transform and native sensor timestamps. If retaining GPU capture for performance, save its texture calibration and exact image-to-texture/output mapping, then derive the calibration of the saved pixels. Validate either path with an asymmetric target in both landscape orientations and at measured distances. Include stride/crop handling, timestamp matching and image-resource lifetime in implementation checks.
2. **Make hand reconstruction test its own evidence.** After validated registration, use local hand-aware depth sampling, explicit uncertainty for missing or background-contaminated depth, reprojection residuals and temporal/bone-length checks. Evaluate translation/PnP initialization and a constrained hand fit against independent evidence. Reject or mask unsupported joints rather than treating handedness confidence as pose confidence.
3. **Separate body synthesis from observed data.** Require mount metadata for the head-camera model, label inferred joints, and reject unreachable IK results. This handheld clip should not generate accepted full-body labels.
4. **Validate grips separately from open hands.** Record a short controlled sequence of an open palm, fist and tool grip, with a second synchronized view when possible. A convincing overlay in one view does not establish occluded joint positions. Use manually checked visible landmarks and known distances first; accurate hidden-joint claims require stronger ground truth.

The existing clip is a regression fixture for these failures. It cannot recover unrecorded calibration metadata or directly observe hidden joints. Raw video and other streams should retain their provenance while derived annotations carry explicit quality status.

## Reproduce the diagnostics

Use fresh output directories to retain the original audit evidence. The depth-orientation script refuses an existing output directory; the hand audit can replace its own derived reports if given the same output path.

```bash
cd ~/projects/robotics-data-collection
.venv-stera/bin/python scripts/audit_hand_geometry.py \
  captures/session_20261021_210417 \
  --processed stera_processed_y_up \
  --output captures/session_20261021_210417/geometry_recheck
.venv-stera/bin/python scripts/audit_depth_orientation.py \
  captures/session_20261021_210417/stera_processed_y_up \
  --output captures/session_20261021_210417/depth_orientation_recheck
```

Reports retain source checksums. The hand audit also checks that its data inputs remain unchanged. SDK and app source were inspected without modification during this audit.
