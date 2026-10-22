# Capture comparison and framing notes

Date: 2026-10-21 (America/Toronto). Both captures are from the same Pixel 9 Pro XL and Stera build. All processing was local, with original recordings retained on the phone and local SHA-256 values matching the phone.

| Check | 20:35 capture | 21:04 capture |
|---|---:|---:|
| Decoded messages | 21,508 | 21,807 |
| Structural/decode errors | 0 | 0 |
| Saved RGB frames | 230 | 252 |
| Distinct JPEG payloads | 230 | 252 |
| RGB resolution | 1920×1080 | 1920×1080 |
| Saved depth frames | 230 | 252 |
| Distinct depth images | **1** | **252** |
| Depth resolution | 160×90 | 160×90 |
| Finite camera poses | 230 | 252 |
| IMU messages / unique timestamps | 12,273 / 6,138 | 13,404 / 6,707 |
| Largest RGB timestamp interval | 133.31 ms | 199.93 ms |
| Nonfinite point records | 0 / 406 | **15,023 / 18,821** |

The second capture's depth changes throughout and ranges from 384 to 2733 in the writer's millimetre convention. It passes freshness-by-content checks; accuracy and projection alignment remain unmeasured. Point-cloud invalidity affects 250 of 252 cloud messages, and those messages incorrectly advertise `is_dense=True`. Filtering invalid values can prevent numerical failures but does not establish the accuracy of the surviving points.

The first depth freeze is not explained conclusively. Source inspection found that the writer discards the independent `depthImage.timestamp` and assigns the AR frame timestamp to depth. ARCore can return an earlier depth image, so equal RGB/depth timestamps do not establish sensor synchronization or freshness. A diagnostic build should retain native depth timestamps and source/packed/output hashes to localize future freezes. [Official ARCore Frame reference](https://developers.google.com/ar/reference/java/com/google/ar/core/Frame#acquireDepthImage()).

## Visual framing observation

The thumbnail and RGB frames 60, 125 and 210 were inspected locally. The working hand/tool are visible in some samples, but the hand falls below the lower image boundary when the camera aims higher. This is a sampled visual observation, not an automated hand-visibility rate or a full temporal annotation.

A mount should aim at the working area with enough margin for near-body and sideways reaches. First compare downward tilt, then field of view; do not require a collector to contort normal movements to stay centered. A wider lens still cannot see a contact point hidden behind an object or another hand, and trades coverage against image detail per object.

## What public collection systems document

- **EgoVerse:** its phone setup uses an iPhone ultrawide camera on a head strap at 1080p/30 fps. The project includes Mecka and Scale AI collaborators; its unnamed partner rig examples must not be attributed to either company. [Paper, collection setup and appendix](https://arxiv.org/html/2604.07607v2).
- **Ego4D:** explicitly reports that a downward-pointed head-mounted GoPro captures hands well, whereas an eye-aligned Vuzix camera misses near-body interactions. No universal mount tilt is prescribed. [Paper, section 3.3/Figure 5](https://openaccess.thecvf.com/content/CVPR2022/papers/Grauman_Ego4D_Around_the_World_in_3000_Hours_of_Egocentric_Video_CVPR_2022_paper.pdf).
- **Dexset:** describes head-mounted context, wrist-mounted close-ups, active-object framing and hand-visibility protocols. This is the company's stated service design, not independent performance verification. [Official capture page](https://dexset.ai/data-collection/egocentric-capture/).

Google specifies 82° field of view for the Pixel 9 Pro XL wide camera and 123° for the ultrawide; delivered video framing can differ with crop/mode. [Google specifications](https://fi.google.com/about/phones/pixel-9-pro-specs).

The current Android Stera code chooses an ARCore camera configuration by target frame rate and resolution. It has no implemented 0.5×/ultrawide selector. Pixel ultrawide availability through the stock camera does not establish that ARCore exposes it with the required pose/depth support; that requires runtime enumeration and validation. [ARCore camera configuration](https://developers.google.com/ar/develop/java/camera-configs).

## Next focused tests

1. At the intended head position, compare 10-second stock-camera clips at 1× and 0.5× while reaching naturally across the same workspace. Treat these as framing tests; they do not provide Stera's sensor streams.
2. Adjust downward mount tilt until active hands, the object and contact area remain visible across the reach. Inspect saved footage, including its bottom boundary.
3. Before enabling ultrawide in Stera, enumerate supported ARCore camera IDs/configurations and verify saved intrinsics, pose behavior and depth alignment for the selected lens. Do not reuse main-camera calibration for another lens.
4. For contributor onboarding, prototype a brief framing check with spoken guidance for sustained loss of the active hand/object. Assess task-relevant visibility rather than requiring both idle hands in every frame.

Artifacts: [first QA](../captures/session_20261021_203504/inspection/QA.md), [second QA](../captures/session_20261021_210417/inspection/QA.md), [second preview](../captures/session_20261021_210417/inspection/preview.mp4). Both previews use constant 15 fps and are retimed; native CSV/MCAP timestamps are authoritative.
