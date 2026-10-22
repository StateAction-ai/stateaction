# Qualifying egocentric data for a named training use

Research and source audit: **22 October 2026**. This is a proposed acceptance
protocol, not a frontier-lab procurement standard. Android capture fixes are in
progress; the code observations below describe the inspected v2 reader and
current Python processing/export path.

**Our present result is a reproducible RGB inference/export workflow with
explicitly unvalidated model predictions. It is not yet an accuracy-qualified
metric hand dataset or evidence of improved robot learning.** A useful next
deliverable is a measured, independently reviewed dataset for one task, with a
small training experiment and an honest account of its limitations.

## What the training literature actually consumes

| Primary source | Concrete data and training contract | Consequence for our product |
| --- | --- | --- |
| [Physical Intelligence, human-to-robot transfer](https://www.pi.website/download/human_to_robot.pdf), §§IV–V | Repeated task demonstrations, head video, estimated camera motion and 17 hand keypoints, dense subtask language, and relative hand/head action chunks. Human data is co-trained with relevant robot data; no bespoke alignment step. Human gripper openness is not inferred. Transfer is tested on robot tasks in new scenes, objects and task conditions. | Head video alone does not implement this recipe. Correct temporal actions and task semantics matter; robot pretraining and the evaluation setting also determine benefit. |
| [EgoMimic](https://egomimic.github.io/) and its [human converter](https://github.com/SimarKareer/EgoMimic/blob/main/egomimic/scripts/aria_process/aria_to_robomimic.py) | Human images/palm trajectories and robot demonstrations enter a shared policy with different action outputs. The human converter produces future Cartesian palm targets; these are not robot joint commands. Visual and embodiment differences receive explicit treatment. | Specify the coordinate frame, horizon and observation/action meaning before exporting an `actions` array. |
| [EgoScale](https://arxiv.org/html/2602.16710v1), §§2.1–2.5 | Large-scale pretraining uses estimated camera/hand motion, including noisy labels. A separate aligned human–robot stage uses synchronized video, tracked wrists and glove measurements, followed by task-specific robot training. Finger articulation and retargeting matter for dexterous control. | Noisy pseudo-labels can be useful without being ground truth. Precise alignment data is a separate product with a different evidence burden; wrist-only data cannot be assumed sufficient for dexterity. |
| [UMI](https://umi-gripper.github.io/) | Instrumented handheld grippers capture trajectories and opening width. Deployable demonstrations also require embodiment feasibility, a relative action representation and latency matching. | A phone on a head does not measure the same supervision. Phone IMU is not the UMI manipulation interface. |
| [Open-AoE format](https://github.com/ant-research/Open-AoE/blob/main/open-aoe-2000h/README.md) and [training integrations](https://github.com/ant-research/Open-AoE/blob/main/aoe-training-ready/README.md) | Video, calibration, camera/hand trajectories, validity and semantic annotations feed model-specific conversion recipes. The integration guide explicitly rejects a universal format, action representation or converter. | Offer a canonical evidence-preserving archive plus a tested adapter for a particular consumer. File-format compatibility alone does not qualify the supervision. |

These sources support several products: visual/semantic pretraining data,
pseudo-action pretraining data, measured motion supervision, and robot-compatible
demonstrations. They do **not** establish one required camera, mandatory depth
channel, accuracy threshold or acceptance rate for every buyer. The proposed
gates below are our engineering requirements; numerical acceptance limits must
belong to a named task and claim.

## What our existing checks establish

The audit covered [capture_geometry.py](../scripts/capture_geometry.py),
[hand_geometry.py](../scripts/hand_geometry.py),
[process_geometry_capture.py](../scripts/process_geometry_capture.py) and
[the public-video runner](../scripts/test_public_egocentric_video.py).

* `calibration_contract_verified` checks dimensions, finite intrinsics and the
  arithmetic relationship between RGB/depth calibration and the recorded pixel
  mapping. It does not measure lens calibration or registration accuracy.
* The reader preserves native RGB, depth and ARCore event clocks. It explicitly
  leaves `cross_stream_clock_verified` and `depth_time_verified` false. Equal or
  nearby integer timestamps alone would not establish synchronization.
* `cam-pose/valid` denotes tracked, exactly associated frame events. It is not a
  statement that the camera trajectory has a measured absolute metric accuracy.
* Hand checks compare reprojection and local depth consistency. Current
  tolerances include 12 pixels, a hand-size-dependent cap and 4 cm depth checks;
  these are uncalibrated heuristics. Depth measures an observed surface, not
  necessarily the anatomical joint beneath it.
* Independent joint visibility is required for supported joint output, but the
  production caller currently supplies no `visible_joints` labels. Unsupported
  joints remain masked/NaN. That prevents a false accuracy claim; it does not
  produce a usable fully supervised hand training set by itself.
* Raw predictions, side scores, rejection reasons, source hashes and separate
  clocks are retained. Handedness score is not pose confidence. Public export
  slots are per-frame observations, not persistent hand identities.

Our [public RGB validation](public-egocentric-video-validation.md) processed
449 frames and retained 71 predictions. **15.8% is prediction coverage, not
recall or accuracy.** There is no independently annotated denominator of visible
hands, no accepted metric 3D supervision and no downstream learning comparison.

## Acceptance gates and missing evidence

Each release should name its intended supervision and consumer. A semantic-only
release can mark depth/metric pose as out of scope; it must not quietly expose
them as verified targets.

| Layer | Required evidence before making the corresponding claim | Current position / next measurement |
| --- | --- | --- |
| RGB and lifecycle | Every released frame decodes; dimensions, orientation, frame association and finalization are auditable. Report dropped/duplicate frames and gaps rather than hiding them through resampling. Preserve original payloads and hashes. | Software fixtures/public RGB pass their documented checks. A fixed recorder still needs a real Pixel recording and repeat stop/start validation. |
| Camera calibration | Compare known target observations against projection using the saved calibration, on held-out positions, image regions and device orientations. Report pixel residual distribution and measurement uncertainty. | Metadata consistency exists; an independent physical calibration test does not. |
| Depth and registration | Measure depth bias/error/missingness against independently measured surfaces at working distances, and RGB/depth edge registration. Include task materials and motion; do not infer hand accuracy from a flat wall test. | Registration contract exists; measured accuracy and synchronization remain unestablished. |
| Timing | Record clock domains and estimate any mapping/offset/drift using independent evidence. Quantify alignment uncertainty and stale depth under motion. | Native values are preserved, but the cross-stream relationship is unverified. |
| Camera motion | Test direction, scale, drift and relocalization against an external metric reference. Report unaligned or fixed-extrinsic errors as well as any aligned errors. | ARCore tracking status is available. Returning to the start can measure loop inconsistency, not establish full trajectory accuracy. |
| Model labels | Independently label hand presence, visible joints, side/unknown, occlusions and temporal identity. Evaluate missed hands and unsupported predictions as well as errors on successful detections. For metric 3D, use independent 3D reference with stated uncertainty. | No gold benchmark yet. Visually plausible projection or agreement between two models is insufficient. |
| Task annotations | Define observable subtasks, boundaries, object/tool references, outcome/failure and uncertainty. Audit boundary errors and annotator agreement on held-out samples. | The processing path does not supply reviewed task/outcome supervision. |
| Rights and provenance | Maintain per-source license/version, attribution, allowed uses, transformations, capture permission evidence where applicable, model/license dependencies, hashes and revision history. | Public clip attribution exists. A complete production rights/consent manifest and contributor workflow do not. |
| Coverage and splitting | Inventory worker/session/site/task/object/tool/viewpoint, gloves, occlusion and failure modes. Deduplicate and split related sessions together. Report coverage by stratum, not only hours. | One public clip cannot support a generalization claim. |
| Training utility | Reproduce a named loader and objective; compare against an appropriate baseline on independent held-out groups with fixed training budget. Robot-policy benefit additionally needs the target embodiment and rollout evaluation. | No learning ablation or robot transfer result yet. |

Timing limits should follow an error budget. For illustration, allocating 5 mm
to temporal error at 0.5 m/s permits roughly 10 ms of misalignment by
`position_error ≈ speed × time_error`. These are **example task assumptions**,
not a published standard; rotation, other error sources and uncertainty still
consume budget. Similarly, similarity-aligned trajectory/joint metrics can hide
scale error: Open-AoE reports alignment choices with its accuracy metrics, which
must be preserved when making comparisons.
[Open-AoE evaluation definitions](https://github.com/ant-research/Open-AoE/blob/main/open-aoe-2000h/README.md).

For the public source, EgoViz states its hand/action annotations are
model-generated and recommends splitting by `group_id`, because clips in a
group share worker/site/lighting. We should use those annotations as candidates,
not gold labels. [Official dataset card](https://huggingface.co/datasets/humaidtech/EgoViz-120).
Its CC BY 4.0 license permits commercial reuse subject to attribution and other
terms, but does not itself resolve every privacy/publicity permission.
[License terms](https://creativecommons.org/licenses/by/4.0/).

## Experiments we can execute locally

### 1. Establish a small, independent label benchmark first

Use the already downloaded clip to validate the review procedure. Select 60
uniformly distributed frames **before inspecting detector output**. Add a
separately reported challenge set for gloves, blur, contact and occlusion; do not
mix its deliberately difficult sampling into an unbiased recall estimate.

Label visible hand presence, bounding boxes, anatomical side or unknown, and
only observable 2D joints. Mark ambiguous/occluded joints as such instead of
inventing positions. Re-label a fixed 20% subset after a delay; use an independent
second reviewer when available and report which review procedure actually ran.

Report hand precision/recall, missed bimanual frames, side errors, visible-joint
pixel error and PCK at 5%/10% of annotated hand-box diagonal. These PCK settings
define measurements, not accuracy guarantees. Show error versus retained-data
coverage for every quality filter. Evaluate the existing pipeline and one
candidate improvement on exactly the same frames; freeze thresholds before the
held-out comparison. One clip diagnoses failure and review effort, not
cross-worker generalization.

### 2. Test whether cleaning labels improves a small training task

**Recommended first utility test: cleaning-workflow subtask recognition.** It
fits RGB and reviewed semantics, and avoids manufacturing metric action targets
from our currently unsupported hand reconstruction. PI's use of dense subtask
supervision motivates this task, but a local classifier is not a replication of
its robot transfer result.
[PI training objectives](https://www.pi.website/download/human_to_robot.pdf).

Proposed pilot:

1. Inspect public metadata first; select a bounded subset containing recurring,
   visually distinguishable cleaning subtasks across independent `group_id`s.
   Define the vocabulary from training material, including an unknown class.
   Aim for at least 12 groups for an exploratory study, with at least three
   held-out groups. This is a resource planning target, not statistical power
   assurance. If class/group coverage is insufficient, do not report utility.
2. Review temporal labels and a small gold test set without using predictions
   from the candidate learner. Keep continuous recordings and related groups
   together. Hold out whole workers/sites where identifiers permit; otherwise
   limit the claim to session generalization.
3. Cache frozen image-encoder features locally. Fit the same small linear or
   temporal classifier on short fixed windows in three conditions: source
   pseudo-labels; reviewed labels on exactly the same windows; quality-filtered
   pseudo-labels with a matched-size random subset baseline. Keep encoder,
   budget, class treatment and hyperparameter search fixed. No rented GPU or
   foundation-model pretraining is required for this initial experiment.
4. Evaluate macro-F1, per-class recall, calibration and abstention coverage on
   the same held-out gold labels. Report variation across groups and three
   training seeds; confidence intervals must resample groups, not adjacent
   frames. With few groups, wide intervals are an honest inconclusive result.
5. Predeclare an internal go/no-go target: at least **5 absolute macro-F1
   points** improvement over the matched baseline, with a positive lower bound
   on the paired group-level interval. This is our proposed commercial
   hypothesis, not a buyer requirement. Report review minutes and cost per
   retained labeled minute alongside improvement. Freeze the evaluation before
   selecting a winning filter or model.

This tests whether our cleaning work creates useful semantic supervision for a
specific learner. It does not prove useful 3D actions, contact-force inference,
VLA transfer or purchasing demand. An unsuccessful small learner also cannot
establish that the same data has no value to a larger model.

### 3. Qualify physical geometry independently

After a successful Pixel recording, capture an asymmetric calibration target
and measured surfaces at several working distances, then controlled translation,
rotation and a short real manipulation. Preserve native clocks and raw streams.
Compare held-out projection/depth errors and record failure modes before
promoting any geometry flag. A consumer reference camera or surveyed target
setup can check selected motions; full dynamic hand accuracy requires suitable
independent 3D instrumentation or a licensed benchmark with reference poses.

Only after that should we construct future-palm or retargeted action chunks and
evaluate trajectory prediction. Even strong offline action accuracy is an
intermediate result: the eventual buyer test is fixed-budget robot-only versus
robot-plus-human training with held-out task/scene rollouts. A simulated test can
qualify a specified simulated consumer, but cannot certify physical transfer.

## Deliverable and immediate order

The first useful package is: source/rights manifest, immutable raw data,
versioned observations and labels, visible/unknown masks, annotation protocol,
group-based split, measured error report, and a reproducible consumer training
script with an ablation report. Keep measured values, model estimates and
reviewer judgments separate. Do not replace missing evidence with a single
`training_ready=true` flag.

Start with the 60-frame review and metadata coverage audit while recorder
validation continues. Then execute the bounded semantic learning experiment.
Prioritize sensor instrumentation if the intended first buyer specifically
needs metric action supervision. This gives us a testable software product
hypothesis—reducing supervision error and review cost—before scaling the
contributor network or promising robot-ready 3D motion.
