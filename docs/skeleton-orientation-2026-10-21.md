# Skeleton inversion in the Pixel replay

The saved body geometry was inverted in world coordinates. The original Rerun file correctly declares a right-handed, positive-Y-up world at both `/` and `/world`; rotating the viewer would hide the error rather than repair the geometry.

The SDK chooses the vertical sign from the first ten camera orientations. For this capture, their mean image-up vector was approximately `[-0.02195, -0.75858, 0.65107]`, so the estimator selected world up `[0, -1, 0]`. All 243 estimated skeletons then placed the head 0.10 m below the neck and the spine 0.45 m above the shoulder midpoint. Specifying `SkeletonConfig(up_axis=1)` selects the axis but still infers its sign, so it does not fix the issue.

## Derived-pipeline correction

`scripts/skeleton_world_up.py` pins the body estimator to `[0, 1, 0]` for a verified Android ARCore capture. It requires matching recorder metadata, session identity, first-pose timestamp and the audited SDK revision. Other inputs retain upstream behavior. It preserves the original nine warmup frames and applies the correction only after the estimator is ready.

The runner records this adaptation in its receipt. The SDK checkout and original processed run remain unchanged. The new run is under `captures/session_20261021_210417/stera_processed_y_up/`. The viewer launcher chooses the newest completed run for the newest session:

```bash
cd ~/projects/robotics-data-collection
python3 scripts/view_capture.py
```

Regression checks cover camera-roll invariance, unchanged warmup, metadata mismatch, unknown SDK versions and non-Android fallback. All seven local clock/orientation tests passed. The regenerated recording has 243 skeletons with head-minus-neck **+0.10 m in Y** and spine-minus-shoulder-midpoint **−0.45 m in Y**. Its frame indices, camera points, detected wrists and all 19 HDF5 datasets match the original run, treating missing NaN values as equal. Full viewer ingestion and artifact hashes passed. The raw MCAP is unchanged. See [orientation validation](../captures/session_20261021_210417/stera_processed_y_up/orientation_validation.json) and [run receipt](../captures/session_20261021_210417/stera_processed_y_up/receipt.json).

## Remaining geometry limitations

The [subsequent hand-geometry audit](hand-geometry-audit-2026-10-21.md) confirms substantial hand reprojection failures, inconsistent RGB/depth orientation and unreachable inferred arms. The positive-Y correction is not sufficient to accept this episode's 3D annotations.

This is a correction to vertical orientation, not validation of body tracking. The estimator still assumes a camera near the head and default body dimensions; the recording was handheld.

There is also a separate image/pose calibration concern. The recorded optical-to-camera transform swaps X and Z. For an unrotated optical image, ARCore's physical camera convention implies a Y/Z sign flip instead. However, this app renders JPEGs using display-transformed UV coordinates while recording unrotated image intrinsics and the physical camera pose. A valid correction therefore needs the complete image rotation/crop and calibration chain. We have not changed that transform or validated hand positions in world coordinates. See the [ARCore camera pose contract](https://developers.google.com/ar/reference/java/com/google/ar/core/Camera#getPose()).
