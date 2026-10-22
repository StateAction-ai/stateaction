---
status: investigating
trigger: "Hand estimate is broken; training quality is the highest priority."
created: 2026-10-22
updated: 2026-10-22
---

## Symptoms

- Expected: visible hand geometry tracks open hand, fist, and tool grasp with defensible calibrated camera coordinates; measured quality, no fabricated labels.
- Actual: latest complete Pixel v3 recording has 68 MediaPipe right-hand detections in 186 frames. All 68 fail model/2D reprojection consistency after the current translation-only depth anchor. Accepted hand arrays are all NaN. This conservative rejection diagnoses failure but does not fix it.
- Reproduction: run scripts/process_geometry_capture.py on captures/session_20261022_152005/session_data_20261022_152005.mcap. Existing processed directory stera_processed_geometry_v3 and inspection/rgb_frames, depth.npz are available. Earlier held-out complete recording session_20261022_151917 is available.
- Timeline: native CPU RGB/depth registration, optical/physical camera axes, writer finalization, and acquisition are repaired. Native recorder v3 physically records all RGB/depth/pose topics without failures. Playback orientation is now correct; root handles thumbnail separately.
- Existing hypothesis: translation-only reconstruction assumes MediaPipe world shape already matches calibrated perspective and metric scale; upside-down native model input may also harm inference. Depth is coarse and may describe tabletop instead of hand surface.

## Current Focus

reasoning_checkpoint:
  hypothesis: Translation-only depth anchoring treats crop-model XYZ as a calibrated perspective reconstruction; MediaPipe's world-landmark projection only rotates crop XY and never uses the actual camera K. This causes the observed large model/image contradiction.
  confirming_evidence:
    - Exact 186-frame raw recording produces 68 native detections, median 97.45px translation-only reprojection error. Calibrated rigid PnP lowers the same-model fitted error to 21.79px without changing model shape.
    - Pinned MediaPipe v0.10.21 WorldLandmarkProjectionCalculator source rotates X/Y only, preserves Z, and does not recover calibrated camera translation or perspective.
    - Upright180 input produces71 detections and99.52px baseline error, ruling out image orientation as the main cause.
  falsification_test: A synthetic model expressed in a rotated local frame with exact calibrated 2D projections must recover known camera geometry; a wrong K or altered model-to-image correspondence must fail held-out or depth checks.
  fix_rationale: Add an explicit calibrated perspective camera solve, preserve raw model outputs and depth-anchored baseline, expose independent surface-depth disagreement and unknown visibility rather than silently claiming supervision quality.
  blind_spots: Real-hand anatomical XYZ ground truth is absent; PnP inherits learned metric shape scale; smooth ARCore depth may measure the background behind moving hands. Fitted reprojection is not independent accuracy.
next_action: compare the SDK-default WiLoR research backend against the MediaPipe baseline once the user supplies the registered MANO_RIGHT.pkl asset; official source, models and isolated GPU preflight are prepared. Keep PnP experimental and do not bypass SDK dependency metadata.

## Evidence

- 186 RGB, depth, tracked poses; 0 encoder failures; 68 detected hands. Camera K approx fx=1381.8, fy=1383.1, cx=962.2, cy=539.6 for 1920x1080. Depth 160x90 mm, recorded RGB-to-depth H approximately diag(1/12,1/12,1).
- Same data temporal feature warp preliminary check: correct axes median 2.79 px, wrong axes 64.61 px; rough capture geometry supported, absolute hand metric quality not established.
- Local GPU RTX3090 24GB is available; use no paid compute. Existing Python env .venv-stera lacks torch; isolate any large-model dependencies.
- 2026-10-22: Native/upright180 full186-frame comparison:68/71 detections. Median translation-only reprojection97.4476/99.5237px; rigid calibrated PnP21.7892/22.8095px. WristZ changes0.5494/0.5480m to0.3438/0.3410m. All scores compare same-model predictions and do not establish anatomical accuracy.
- 2026-10-22: Palm-only fitted camera evaluated on16 other predicted finger joints gives58.4893/56.7262px; the model world/image outputs are not a rigid calibrated reconstruction even after camera recovery. Depth/model disagreement remains a separate unresolved quality issue.
- 2026-10-22: Held-out245-frame native comparison has100 hand observations. Median translation-only mismatch90.0268px falls to16.5704px fitted residual; fitted wristZ0.4277m versus depth anchor0.6523m. Upright input reduces coverage100→96 and is not selected.
- 2026-10-22: Ray-lifting to every predicted image ray gives zero fitted residual by construction but median bone-length/model ratios1.284/1.418, P901.878/1.970, maxima6.38/5.21 on latest/held-out. This is not selected as a physical geometry fix.
- 2026-10-22: Independent native-surface depth versus fitted wristZ disagreement median155/178mm; fitted wrist adjacent-frame steps median23.8/18.9mm versus historical12.3/17.5mm. Temporal instability worsens; lower fitted reprojection is not hand accuracy.
- 2026-10-22: Full E2E completed on186/245 raw frames, yielding68/100 finite fitted hand candidates; HDF5 and both RRD files load, raw hashes unchanged, zero qualified training hands. Right/left split on held-out is99/1.
- 2026-10-22: Root's independent HanCo benchmark uses24 correlated views of3 manually validated timesteps. Raw versus calibrated-PnP root-relative MPJPE36.26→33.62mm, but PnP absolute86.22mm versus raw+oracle-depth35.83mm. Hybrid diagnostic: PnP rotation+oracle-depth32.22mm absolute; uniformly scaledPnP withoracle wristZ27.03mm absolute. These are reference MANO fits and privileged depths, not direct anatomical ground truth or available Pixel measurements.
- 2026-10-22: Added9 focused known-camera, wrong-K, scale-ambiguity, correspondence, visibility, and degeneracy tests. FullPython suite90tests passes. Explicit calibrated-pnp experiment is available; historical translation-depth remains CLI default after independent evaluation.
- 2026-10-22: After restoring historical default, a fresh no-selector E2E run completed186frames,68finite candidates,0qualified hands; receipt explicitly records translation-depth, unchanged rawSHA and complete status. HDF5 and RRD readback pass. Explicit calibrated-pnp was separately exercised on both recordings.
- 2026-10-22: Root confirmed the SDK HandTracker defaults to WiLoR, whereas the local geometry runner explicitly selects MediaPipe. The measured MediaPipe failures do not establish that the published SDK-default WiLoR estimator is broken.
- 2026-10-22: Official WiLoR source and official model/config assets are pinned and downloaded in ignored research storage. Isolated .venv-wilor passes actual RTX3090 CUDA matmul/autocast, model imports, hash-checked checkpoint deserialization, and detector inference on existing native frame20 (one right-hand box, confidence0.87793). Receipt: docs/validation/wilor-research-preflight.json. No full hand forward pass is claimed.
- 2026-10-22: The remaining protected asset is artifacts/research-models/WiLoR/mano_data/MANO_RIGHT.pkl from legitimate MANO registration. The isolated Python3.10/NumPy1.23.5 environment preserves legacy Chumpy compatibility; SDK NumPy>=1.24 packaging integration is explicitly deferred rather than installing with conflicting metadata. WiLoR pretrained weights are research-only under their noncommercial license and are not a commercial product default.

## Eliminated

- Blind world-axis flip or handedness swap is not supported; Tasks 0.10.21 handedness was verified with fixtures.
- Upside-down detector input is not the dominant reconstruction cause: upright preprocessing changes coverage only68→71 and does not reduce the main reprojection contradiction.

## Specialist Review

- Python specialist dispatch was checked. The mapped `python-expert-best-practices-code-review` skill is not installed in the available skill catalog, so no specialist result is claimed.
- Root independently evaluated the solver on public HanCo reference annotations. That review rejected promotion of calibrated PnP to the default because lower fitted reprojection concealed substantially larger absolute hand-position error. The implementation retains it as an explicit experiment and preserves the baseline.

## Resolution

root_cause: The local runner selected MediaPipe instead of the SDK-default WiLoR, then treated its independently predicted crop-model XYZ as an already calibrated perspective hand and added sensor-depth translation. Native orientation is not the dominant problem. The MediaPipe baseline also has unresolved learned-shape, scale, occlusion, depth-surface and temporal errors; fixing camera recovery alone does not meet the user's training-quality goal. WiLoR hand accuracy has not yet been measured.
fix: Implemented an explicit experimental calibrated rigid-camera solve, separate depth/model disagreement audits, preserved baseline/raw observations, inspectable labeled candidates, an explicit method selector, reproducible orientation/ray-lift/temporal diagnostics and independent-reference hybrid evaluation. PnP is not promoted to default; no quality thresholds were relaxed.
verification: 90 Python tests pass, including9 new focused regressions; both real raw recordings process E2E and load HDF5/RRD with unchanged raw hashes. Actual training-quality validation remains unresolved and this debug session stays investigating.
files_changed: [scripts/hand_geometry.py, scripts/process_geometry_capture.py, scripts/benchmark_hand_reconstruction.py, scripts/summarize_hand_ablation.py, tests/test_hand_geometry.py, docs/hand-camera-reconstruction.md, docs/validation/hand-camera-recovery.json, docs/validation/hand-camera-tests.log]

## Follow-up evidence: tracker backend and input mode

- Local runner explicitly selects MediaPipe; upstream SDK defaults WiLoR. MediaPipe findings do not measure the upstream default backend.
- VIDEO mode on unchanged Pixel frames increases detected-frame coverage 68 to 135 (latest) and 100 to 167 (earlier). Full latest video-mode pipeline reads back HDF5/RRD; zero hands qualify; raw hash unchanged.
- Independent 24-view HanCo reference check: VIDEO mean raw wrist-relative joint error 39.03 mm versus IMAGE 36.26 mm. Detection coverage is not pose accuracy; IMAGE remains default.
- Fixed crop fallback gives 100/186 and 127/245 detected frames; two reviewed latest outputs are obvious partial-hand skeletons. Keep experimental.
- Isolated WiLoR GPU environment and pinned official assets are ready; CUDA math/autocast, SHA-checked checkpoint deserialization and one-frame detector inference pass. Actual hand inference still requires registered artifacts/research-models/WiLoR/mano_data/MANO_RIGHT.pkl; asynchronous user question pending. No protected model assets were fetched from unofficial mirrors. See docs/wilor-research-preflight.md and docs/validation/wilor-research-preflight.json.
