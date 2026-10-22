"""Temporal, calibration-aware replay for the local capture geometry audit.

Image landmarks and externally logged 3D candidates are estimates. This viewer
does not infer a body, promote confidence scores to accuracy, or reuse a missing
frame's camera/depth data. All camera calibration is logged on the frame timeline.
"""
from __future__ import annotations

from pathlib import Path
import shutil

import numpy as np
import rerun as rr
import rerun.blueprint as rrb


HAND_EDGES = (
    (0, 1), (1, 2), (2, 3), (3, 4),
    (0, 5), (5, 6), (6, 7), (7, 8),
    (5, 9), (9, 10), (10, 11), (11, 12),
    (9, 13), (13, 14), (14, 15), (15, 16),
    (13, 17), (0, 17), (17, 18), (18, 19), (19, 20),
)


def registered_depth_cloud(depth, rgb, depth_k, rgb_to_depth, *, max_points=2500):
    """Backproject native depth and sample RGB through the inverse recorded map.

Depth values are uint16 millimetres. Pixel coordinates use the recorded ARCore
mapping; resizing RGB to depth dimensions would silently discard its crop.
Returns optical-frame points and matching uint8 colors, never fitted geometry.
"""
    empty = (np.empty((0, 3), dtype=np.float32), np.empty((0, 3), dtype=np.uint8))
    if max_points <= 0:
        return empty
    depth = np.asarray(depth)
    rgb = np.asarray(rgb)
    k = np.asarray(depth_k, dtype=float)
    h = np.asarray(rgb_to_depth, dtype=float)
    if depth.ndim != 2 or rgb.ndim != 3 or rgb.shape[2] != 3:
        raise ValueError("Expected native depth HxW and RGB HxWx3")
    if k.shape != (3, 3) or h.shape != (3, 3) or not np.isfinite(k).all() or not np.isfinite(h).all():
        raise ValueError("Depth cloud needs finite per-frame K and RGB-to-depth mapping")
    yy, xx = np.nonzero(np.isfinite(depth) & (depth > 0))
    if not len(xx):
        return empty
    pixels = np.column_stack((xx, yy, np.ones(len(xx))))
    rgb_h = pixels @ np.linalg.inv(h).T
    valid = np.isfinite(rgb_h).all(axis=1) & (np.abs(rgb_h[:, 2]) > 1e-12)
    rgb_xy = np.full((len(xx), 2), np.nan)
    rgb_xy[valid] = rgb_h[valid, :2] / rgb_h[valid, 2, None]
    # Reject out-of-view coordinates before nearest-neighbor sampling.
    valid &= (rgb_xy[:, 0] >= 0) & (rgb_xy[:, 0] <= rgb.shape[1] - 1)
    valid &= (rgb_xy[:, 1] >= 0) & (rgb_xy[:, 1] <= rgb.shape[0] - 1)
    indices = np.flatnonzero(valid)
    if len(indices) > max_points:
        indices = indices[np.linspace(0, len(indices) - 1, max_points, dtype=int)]
    if not len(indices):
        return empty
    rays = pixels[indices] @ np.linalg.inv(k).T
    points = rays * (depth[yy[indices], xx[indices]].astype(float) / 1000)[:, None]
    xy = np.rint(rgb_xy[indices]).astype(int)
    colors = rgb[xy[:, 1], xy[:, 0], :]
    finite = np.isfinite(points).all(axis=1)
    return points[finite].astype(np.float32), colors[finite].astype(np.uint8)


class GeometryVisualizer:
    """Rerun 0.22 viewer with no static camera transforms or pinholes.

    ``session.export(..., visualizer=viz)`` calls ``export(path)``. The caller
    should close the Rerun stream before hashing its final RRD, as usual.
    """

    def __init__(self, session, output):
        self._session = session
        self._output = Path(output)
        self._output.parent.mkdir(parents=True, exist_ok=True)
        rr.init("Stera geometry audit — estimated hands", spawn=False)
        rr.save(self._output)
        rr.log("world", rr.ViewCoordinates.RIGHT_HAND_Y_UP, static=True)
        rr.send_blueprint(rrb.Blueprint(
            rrb.Horizontal(
                rrb.Vertical(
                    rrb.Spatial2DView(origin="camera/rgb", name="RGB — native pixels"),
                    rrb.Spatial2DView(origin="camera/rgb_overlay", name="RGB + estimated 2D landmarks"),
                    rrb.Spatial2DView(origin="camera/depth", name="Depth — native raster (mm)"),
                ),
                rrb.Vertical(
                    rrb.Spatial3DView(origin="world", name="3D — estimates, no body inference"),
                    rrb.TextDocumentView(origin="quality", name="Frame quality"),
                    row_shares=[0.78, 0.22],
                ), column_shares=[0.4, 0.6],
            ), auto_layout=False, auto_views=False,
        ))

    def log_frame(self, frame, hands=None, skeleton=None, enable_pointcloud=False):
        if skeleton is not None:
            raise ValueError("This geometry viewer does not display inferred body skeletons")
        rr.set_time_seconds("time", float(frame.timestamp))
        rr.set_time_sequence("frame", int(frame.index))
        rgb_image = rr.Image(frame.rgb).compress(jpeg_quality=80)
        rr.log("camera/rgb", rgb_image)
        rr.log("camera/rgb_overlay", rgb_image)
        geometry = getattr(frame, "geometry", {}) or {}

        # Never leave the previous frame's hand landmarks visible.
        for side in ("left", "right"):
            rr.log(f"camera/rgb_overlay/hand_{side}", rr.Clear(recursive=True))
        for hand in hands or []:
            points = getattr(hand, "_kpts_2d_rgb", None)
            if points is None:
                kps = np.array([[p.x, p.y, p.z] for p in hand.all_keypoints])
                if kps.shape == (21, 3) and np.all(kps[:, 2] == 0):
                    points = kps[:, :2]
            points = np.asarray(points) if points is not None else None
            if points is None or points.shape != (21, 2) or not np.isfinite(points).all():
                continue
            side = hand.hand_side
            if side not in ("left", "right"):
                continue
            color = [255, 120, 120] if side == "left" else [120, 255, 120]
            path = f"camera/rgb_overlay/hand_{side}"
            rr.log(path + "/joints", rr.Points2D(points, colors=[color], radii=2.5))
            rr.log(path + "/bones", rr.LineStrips2D(
                [[points[a], points[b]] for a, b in HAND_EDGES], colors=[color], radii=1.2,
            ))

        if frame.depth is None:
            rr.log("camera/depth", rr.Clear(recursive=True))
        else:
            # Clear the previous pinhole as well as pixels before logging this frame.
            rr.log("camera/depth", rr.Clear(recursive=True))
            rr.log("camera/depth", rr.DepthImage(frame.depth, meter=1000.0))
            if self._valid_k(frame.depth_K):
                rr.log("camera/depth", rr.Pinhole(
                    image_from_camera=frame.depth_K,
                    resolution=frame.depth.shape[1::-1], camera_xyz=rr.ViewCoordinates.RDF,
                ))

        pose = frame.camera_pose
        valid_pose = pose is not None and np.isfinite(pose.rotation).all() and np.isfinite(pose.translation).all()
        if not valid_pose or not self._valid_k(frame.rgb_K):
            rr.log("world/camera", rr.Clear(recursive=True))
            rr.log("world/live_pointcloud", rr.Clear(recursive=True))
        else:
            optical_rotation = pose.rotation @ self._session.R_optical_to_link
            rr.log("world/camera", rr.Transform3D(
                translation=pose.translation, mat3x3=optical_rotation,
            ), rr.Pinhole(
                image_from_camera=frame.rgb_K, resolution=frame.rgb.shape[1::-1],
                camera_xyz=rr.ViewCoordinates.RDF, image_plane_distance=0.15,
            ))
            # RGB under this temporal pinhole provides the exact current frustum image.
            rr.log("world/camera/image", rgb_image)
            cloud_allowed = (enable_pointcloud and frame.depth is not None
                             and self._valid_k(frame.depth_K)
                             and geometry.get("depth_registered", False)
                             and geometry.get("depth_time_verified", False)
                             and geometry.get("rgb_to_depth") is not None)
            if cloud_allowed:
                points, colors = registered_depth_cloud(
                    frame.depth, frame.rgb, frame.depth_K, geometry["rgb_to_depth"],
                )
                if len(points):
                    world = points @ optical_rotation.T + pose.translation
                    rr.log("world/live_pointcloud", rr.Points3D(world, colors=colors, radii=0.003))
                else:
                    rr.log("world/live_pointcloud", rr.Clear(recursive=True))
            else:
                rr.log("world/live_pointcloud", rr.Clear(recursive=True))

        delta = geometry.get("depth_dt_s")
        timing = "unavailable" if delta is None else f"{delta * 1000:.3f} ms"
        text = (
            f"Frame {frame.index}; native timestamp {frame.timestamp:.6f} s\n"
            f"Camera pose: {'available' if valid_pose else 'MISSING — cleared'}\n"
            f"Calibration contract checked: {bool(geometry.get('calibration_contract_verified'))}\n"
            f"Depth registered: {bool(geometry.get('depth_registered'))}; "
            f"time checked: {bool(geometry.get('depth_time_verified'))}; offset: {timing}\n"
            "Hand landmarks / 3D candidates are ESTIMATES.\n"
            "Metric accuracy has not been validated. Body inference is disabled."
        )
        rr.log("quality", rr.TextDocument(text))

    @staticmethod
    def _valid_k(k):
        if k is None:
            return False
        k = np.asarray(k)
        return k.shape == (3, 3) and np.isfinite(k).all() and k[0, 0] > 0 and k[1, 1] > 0

    def export(self, path):
        """Flush the backing recording; exporting to another path ends its sink."""
        recording = rr.get_data_recording()
        if recording is not None:
            recording.flush(blocking=True)
        destination = Path(path)
        if destination.resolve() != self._output.resolve():
            # A copied RRD must include the finalized footer, not a live partial file.
            rr.disconnect()
            rr.rerun_shutdown()
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(self._output, destination)
        return str(destination)

    save = export
