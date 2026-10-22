# Pixel v3 acquisition and saved-playback orientation

Two user-started recordings on 22 October 2026 confirm that v3 restored this
Pixel's RGB/depth/pose acquisition. Phone/local raw hashes match, both captures
finalized, and every MCAP message decoded without structural errors. The
[machine-readable evidence](validation/pixel-v3-acquisition.json) preserves exact
source hashes, counts and limitations. Household images and sensor payloads stay
in the ignored local `captures/` directory.

| Capture | RGB / depth / tracked poses | Encoder failures | Decoded messages |
|---|---:|---:|---:|
| `session_20261022_151917` | 245 / 245 / 245 | 0 / 245 attempts | 16,305 / 16,305 |
| `session_20261022_152005` | 186 / 186 / 186 | 0 / 186 attempts | 11,888 / 11,888 |

Every RGB frame is 1920×1080; depth is native uint16 160×90 millimetres. All
per-frame calibration/mapping contracts pass. All depth payloads differ within
each recording. This establishes saved data availability and association, not
independently measured depth, temporal or trajectory accuracy. The earlier
session includes nonfinite sparse point-cloud values, recorded in its audit;
that optional stream is not automatically clean training data.

## Why saved video appeared upside down

The recorder saves native CPU images and their matching K, depth mapping and
camera poses. The existing saved-video widget displayed those JPEGs directly,
without an orientation transform. Native camera raster orientation differs
from the live preview's orientation. The first twelve camera poses in each new
recording independently and consistently select a 180° display rotation.

The installed playback update uses the declared native Android coordinate
contract and associated camera poses to pick one right-angle viewing rotation.
It projects ARCore world-up into the optical image, requires a sufficiently
strong/stable cue, and retains that choice throughout playback. RGB and depth
use the same procedure. Unknown contracts, inconsistent votes or a view too
close to straight up/down retain native orientation; the top-right rotate
button provides an override. This is a gravity-based presentation default,
not recovery of unrecorded display orientation or a pose-accuracy certificate.

The [playback build receipt](playback-orientation-build-receipt.json) identifies
the installed APK and source revision. Six Flutter tests include the actual
latest Pixel MCAP; tests also render an asymmetric image at all four rotations
and verify the displayed pixel order, layout dimensions and unchanged decoded
image bytes. Flutter analysis passes. Recorder Kotlin and raw recordings were
not modified by this UI change. Visual confirmation on the phone is pending
reopening the saved recording.

## Processing result and remaining hand problem

The latest recording completes the full local pipeline: 186 frames, HDF5,
MP4, evaluation HTML/JSON and readable Rerun output. All 186 exported camera
poses have true tracking/association masks. The
[processing receipt](validation/pixel-v3-processing.json) records source and
artifact hashes. Its derived outputs are local:

```sh
python3 scripts/view_capture.py \
  captures/session_20261022_152005/stera_processed_geometry_v3/episode/visualization.rrd
```

The hand model produces 68 right-hand estimates. All 68 fail the current
model/2D reprojection consistency check; 36 also have inconsistent palm depth,
and RGB/depth timing remains independently unverified. No metric hand estimate
is accepted. Thus successful acquisition and upright playback have **not**
solved hand-pose reconstruction. The next measurements must address these
contradictions and independently establish accuracy before training claims.

The [printed reference protocol](physical-calibration-validation.md) measures
depth/camera-motion agreement; [training qualification requirements](training-qualification-requirements.md)
describe the missing joint reference, temporal and downstream evidence. The
overall goal remains incomplete.
