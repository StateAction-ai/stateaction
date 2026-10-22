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
next_action: inspect the completed direct-WiLoR replay and resolve independent Pixel metric-depth/timing and hidden-joint visibility evidence before accepting training labels. Full research-model inference and the bounded reference comparison now work; source/license provenance remains explicit. Keep default SDK/MediaPipe processing unchanged and do not bypass dependency metadata.

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

root_cause: The local runner selected MediaPipe instead of the SDK-default WiLoR, then treated its independently predicted crop-model XYZ as an already calibrated perspective hand and added sensor-depth translation. Native orientation is not the dominant problem. The MediaPipe baseline also has unresolved learned-shape, scale, occlusion, depth-surface and temporal errors. Direct WiLoR now improves raw wrist-relative error36.26 to11.57mm against24 correlated HanCo MANO-fit reference views, but Pixel metric accuracy and occluded-joint supervision remain unverified; the training-quality goal is not met.
fix: Implemented an explicit experimental calibrated rigid-camera solve, separate depth/model disagreement audits, preserved baseline/raw observations, inspectable labeled candidates, an explicit method selector, reproducible orientation/ray-lift/temporal diagnostics and independent-reference hybrid evaluation. PnP is not promoted to default; no quality thresholds were relaxed.
verification: 90 Python tests pass, including9 new focused regressions; both real raw recordings process E2E and load HDF5/RRD with unchanged raw hashes. Actual training-quality validation remains unresolved and this debug session stays investigating.
files_changed: [scripts/hand_geometry.py, scripts/process_geometry_capture.py, scripts/benchmark_hand_reconstruction.py, scripts/summarize_hand_ablation.py, tests/test_hand_geometry.py, docs/hand-camera-reconstruction.md, docs/validation/hand-camera-recovery.json, docs/validation/hand-camera-tests.log]

## Follow-up evidence: tracker backend and input mode

- Detector-only WiLoR pose benchmark processed all431 Pixel frames and24 HanCo views without MANO. Fixed confidence0.3/imgsz640, native BGR pixels, raw pre-mask joint coordinates preserved. Latest163/186 and earlier174/245 frames detected; this is coverage, not recall. Scalar receipt: docs/validation/wilor-detector-2d.json.
- HanCo conditional identity-index mean2D error4.89px versus MediaPipe8.37px; symmetric nearest-point distance3.72px. Detector metadata specifies21x3 pose outputs but does not document semantic joint order; no reference-based permutation fitting was used.
- Reviewed negatives0/5/180/185 have no detections, yet frames9/10 hallucinate extra forearm hands and110 duplicates one hand as left/right (boxIoU0.963). All six reviewed bottle-grasp frames detected, with hidden finger scores>=0.976; one HanCo joint at confidence>=0.99 has78.57px error. Confidence is not visibility or per-joint accuracy. No 3D or training qualification follows from these2D improvements.

- Local runner explicitly selects MediaPipe; upstream SDK defaults WiLoR. MediaPipe findings do not measure the upstream default backend.
- VIDEO mode on unchanged Pixel frames increases detected-frame coverage 68 to 135 (latest) and 100 to 167 (earlier). Full latest video-mode pipeline reads back HDF5/RRD; zero hands qualify; raw hash unchanged.
- Independent 24-view HanCo reference check: VIDEO mean raw wrist-relative joint error 39.03 mm versus IMAGE 36.26 mm. Detection coverage is not pose accuracy; IMAGE remains default.
- Fixed crop fallback gives 100/186 and 127/245 detected frames; two reviewed latest outputs are obvious partial-hand skeletons. Keep experimental.
- Initial staged readiness and the missing-MANO state are preserved in docs/validation/wilor-research-preflight.json. On2026-10-22 the official MANO login/register/download pages returned502. The official WiLoR README links WiLoR-mini, whose installer downloads MANO_RIGHT.pkl from Hugging Face. Root retrieved that author-linked research-demo asset with explicit third-party packager provenance, matching its pinned publisher LFS SHA; it is not an MPI registered download or proof of commercial rights. See docs/validation/mano-research-asset-source.json.
- Full WiLoR construction/RTX3090 forward pass now passes with zero missing/unexpected checkpoint keys. Receipt docs/validation/wilor-full-hand-preflight.json. All369 detected observations across24HanCo images and431Pixel frames produce finite full21-joint output. The standalone model environment remains isolated; no recorder, SDK source or dependency metadata changes.
- Same24 manually validated reference views (three correlated right-hand timesteps, eight cameras): mean raw wrist-relative MPJPE11.5688mm versus MediaPipe36.2593mm; image error2.7086px versus8.3667px. Measured-K PnP using the model's own predicted2D gives5.4712mm wrist-relative and19.8241mm absolute error against the external reference. Its fitted reprojection is internal consistency; the independently scored reference error is distinct. Nominal demo camera absolute error5723mm demonstrates its assumed focal length is not calibrated depth.
- HanCo reference is MANO-fit data and WiLoR predicts MANO joints; shared representation, unknown training overlap and this tiny correlated right-hand sample limit interpretation. No claim of measured anatomical ground truth, left-hand accuracy or Pixel absolute accuracy follows. Source and scalar results: docs/validation/wilor-full-hand-benchmark.json.
- Read-only independent source/protocol audit passed after removing an invalid exact-equality assumption between crop and nominal full-camera projections; the official conversion is approximate. Exact affine roundtrip and official-helper/algebra controls pass. Detector hallucinations/duplicates remain retained and zero training-qualified observations are claimed.
