# EgoViz sensor geometry audit — 22 October 2026

**This sample contains usable metric-depth evidence, but its sensor fields are
not uniformly ready for training.** Stereo correspondence supports millimetre
depth in the saved RGB orientation. The head IMU's angular-velocity values are
degrees/second inside a ROS field that requires radians/second. The stored
odometry linear velocity is also a zero placeholder despite camera motion.
No source data or production processing code was changed during this audit.

## Source and reproducibility

Humaid Tech Inc., EgoViz-120 (2026), CC BY 4.0. Clip
`c59801fe4172cf9b430cd9232dda3909`, “Wiping bathroom sinks and faucets.”
The [official dataset card](https://huggingface.co/datasets/humaidtech/EgoViz-120)
describes stereo, depth, odometry, IMU and calibration streams, and explicitly
says its generated labels are not human-verified. Publisher hand labels were
not used as ground truth or as evidence for the checks below.

The existing 150 MB MCAP was read locally; nothing else was downloaded. Its
SHA-256 stayed unchanged:

```text
c86d1d69df71953b0b7fe1d61cfbc919743d1c108a2a0adc30b5c1a449e2e7d4
```

Run from the project root with a fresh output directory:

```sh
.venv-stera/bin/python scripts/audit_egoviz_geometry.py \
  captures/public-egocentric/egoviz_c59801fe4172cf9b430cd9232dda3909/c59801fe4172cf9b430cd9232dda3909.mcap \
  --output captures/public-egocentric/geometry_audit_new
```

Recorded results are in `captures/public-egocentric/geometry_audit_v1/`:
`audit.json`, `stereo_correspondences.json`, extracted left/right videos and six
`stereo_matches_*.jpg` images. The JSON records source and script hashes.

## RGB, depth and pose mapping

Both stereo streams and depth are **1920 × 1200**. Every one of the 449
camera-info messages per head stream contains the same calibration:

```text
K_left = K_right = K_depth =
  [731.66662598,   0,            931.16394043]
  [  0,          731.66662598,   626.66375732]
  [  0,            0,              1        ]
```

All report zero distortion and identity rectification. The right projection
matrix has `P[0,3] = -87.78396312`, giving baseline
`-P[0,3] / fx = 0.11997808838 m`. This exactly matches the right optical frame's
recorded translation `(0, -0.11997808838, 0)` relative to `zed_head_camera_link`.
The left and depth optical frames have identical zero translation and rotation.
Their supported pixel correspondence is therefore identity, with no resize,
crop or 180° rotation. Stereo checks below provide image-based support for this
interpretation; equal metadata alone would be insufficient.

Recorded optical-to-camera-link rotation is:

```text
R_link_from_optical = [ 0,  0,  1]
                      [-1,  0,  0]
                      [ 0, -1,  0]
```

This maps optical right/down/forward to camera-link forward/left/up axes.
The pose chain is `world → odom → zed_head_camera_link → optical_frame`.
Head odometry is explicitly `odom → zed_head_camera_link`. For all 449 poses,
its translation/quaternion exactly equal the corresponding dynamic TF values.
Quaternion norms remain within about `1e-7` of one. This is serialization
consistency, not independent validation of the estimated trajectory.

## Actual depth content and stereo test

Every depth frame decodes as a single-channel **uint16 PNG**, not a colorized
RGB preview. Across 1,034,496,000 pixels, nonzero values range from 140 to 2580;
**every nonzero value is a multiple of 10**. There are only 233 distinct nonzero
values across the whole clip, with a median 124 per frame. Zeros occupy 6.28% of
all pixels and should be excluded from metric reconstruction. The file does not
explain the invalid-value or quantization history.

The audit finds image correspondences without using stored depth: SIFT,
bidirectional ratio matching, then a two-pixel epipolar check and positive
disparity. At six fixed frames, 176 correspondences also have usable local depth
patches. With the recorded baseline, `Z_stereo = fx × baseline / disparity`:

| Interpretation/check | Observed result |
| --- | --- |
| Raw depth units per stereo metre | Median **1000.440** |
| Raw depth divided by 1000 versus stereo Z | Median discrepancy **1.20%**, p90 **5.14%** |
| Same comparison within 5% | 157 / 176 correspondences |
| Same comparison within 10% | 169 / 176 correspondences |
| Depth rotated 180° before lookup | Median discrepancy **36.0%** |
| Raw depth interpreted as centimetres | Median discrepancy **900.4%** |

This supports metric camera-Z in millimetres with **10 mm quantization**. It does
not establish 10 mm accuracy. Large outliers remain: the worst relative
discrepancy is 186%; mismatches, occlusions and surface edges can contribute.
The matched points are sparse and texture-selected, not a representative dense
depth benchmark. Stereo and published depth may use the same underlying camera
pair, so this is an independent *calculation*, not external ground truth.

## Timestamps and association

All 449 left/right/depth/pose frames and head camera-info records share exactly
the same recorded timestamp set. In these channels, embedded timestamps equal
MCAP log and publish times. There is one 66.654 ms gap between head frames 45
and 46; nominal cadence is approximately 33.333 ms. Do not replace these times
with a perfectly uniform 30 Hz timeline for training.

The head IMU has 2,993 distinct native timestamps and a median 4.956 ms interval.
Its nearest recorded sample to a head pose is 1.281 ms away at the median and
3.310 ms at worst. Wrist camera-info streams have 450 frames each and different
timestamp sets; they must not be paired by row number. Equality of recorded
timestamps establishes file association, not independently verified physical
exposure synchronization or a measured inter-device clock calibration.

## Confirmed unit inconsistency and unsupported motion fields

The head IMU's raw gyro norm has median 24.179; the odometry angular-speed norm
has median 0.422. Pairing nearest timestamps gives:

- Median `raw_gyro_norm / odom_angular_norm` is **57.295779513**, exactly the
  degrees-per-radian factor.
- Multiplying raw gyro vectors by `π/180` reduces median vector disagreement
  with odometry angular velocity from **23.767 to zero**. The fitted scalar is
  0.01744996, close to `π/180`.
- An additional check against angular rates from consecutive IMU orientation
  quaternions gives a median raw-gyro/radian-rate ratio of **56.971**.

The ROS `sensor_msgs/Imu` specification requires rad/s, while native ZED SDK
gyro readings are in deg/s. The source file violates the ROS unit convention;
copying native SDK values without conversion is a plausible producer bug, not
an implementation fact established from this MCAP alone.
[ROS message definition](https://github.com/ros2/common_interfaces/blob/rolling/sensor_msgs/msg/Imu.msg),
[Stereolabs IMU units](https://docs.stereolabs.com/docs/development/zed-sdk/modules/sensors/imu).

Acceleration magnitude has median 9.772, consistent with m/s² including gravity.
All 449 stored odometry linear velocities are zero, whereas finite differences
of its positions give median speed 0.142 m/s and maximum 1.092 m/s. Those zero
velocities must be treated as unavailable, not a stationary-camera label.

Position covariance diagonals lie between `6.15e7` and `9.59e7`. Their units,
conversion history and tracking-quality interpretation are unverified. They
cannot be promoted to trustworthy metric uncertainty merely because they occupy
a standard ROS covariance field. A missing covariance unit conversion is one
possibility; the file alone does not establish the cause.

## Strongest next implementable check

Build a separate EgoViz adapter that preserves raw fields and explicitly records
`depth_scale_m=0.001`, 0.01 m quantization, a zero-depth mask, exact native
timestamps, the recorded optical transform, and a derived `gyro_rad_s` column.
Leave the original gyro untouched; mark linear twist and covariance as unverified.
Keep publisher hand poses out of the accepted-label path.

The next geometric test should compare **stored pose motion with RGB-D temporal
reprojection** on static background features. Back-project matched pixels with
depth in frame `t`, transform them using
`inverse(T_odom_optical[t+k]) × T_odom_optical[t]`, and compare projections with
observed image matches at offsets of 1, 5 and 15 frames. Reject dynamic-hand and
occlusion outliers without fitting away the recorded pose. Include wrong-unit,
wrong-transform-direction and 180°-depth controls. This can expose a remaining
pose-axis, scale or association error before trusting a world-space trajectory.
Passing still would not validate hidden finger joints or replace a physical
Pixel recording with independently measured geometry.
