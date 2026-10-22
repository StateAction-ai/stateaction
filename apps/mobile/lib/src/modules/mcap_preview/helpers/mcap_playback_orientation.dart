import "dart:math" as math;

import "package:stera/src/services/mcap_reader/cdr/ros2_message_decoder.dart";
import "package:stera/src/services/mcap_reader/cdr/scene3d.dart";
import "package:stera/src/services/mcap_reader/data/models/mcap_records.dart";
import "package:stera/src/services/mcap_reader/mcap_reader.dart";

/// Presentation rotation for known native Android captures. Never transforms
/// stored pixels, calibration, depth, timestamps or camera poses.
class McapPlaybackOrientation {
  const McapPlaybackOrientation._();

  static const _nativeVersions = {
    "android_arcore_cpu_v1",
    "android_arcore_cpu_v2",
    "android_arcore_cpu_v3",
  };

  /// ARCore world is Y-up; physical camera is right/up/back. Saved optical
  /// pixels are right/down/forward, so optical-to-physical is diag(1,-1,-1).
  /// Choose a right-angle display rotation that brings projected world-up up.
  /// A nearly vertical optical axis has no reliable image-plane gravity cue.
  static int? quarterTurnsForPose(Pose3D pose) {
    final q = [pose.qx, pose.qy, pose.qz, pose.qw];
    if (q.any((value) => !value.isFinite)) return null;
    final norm = q.fold<double>(0, (sum, value) => sum + value * value);
    if ((norm - 1).abs() > 1e-4) return null;
    final upX = pose.rotate(1, 0, 0).$2;
    final upY = -pose.rotate(0, 1, 0).$2;
    final projectedLength = math.sqrt(upX * upX + upY * upY);
    if (projectedLength < 0.25) return null;
    final alignment = [-upY, -upX, upY, upX];
    var best = 0;
    for (var i = 1; i < alignment.length; i++) {
      if (alignment[i] > alignment[best]) best = i;
    }
    // Near a diagonal, an arbitrary quarter-turn is not a reliable default.
    if (alignment[best] / projectedLength < 0.85) return null;
    return best;
  }

  static int? stableQuarterTurns(Iterable<Pose3D> poses) {
    final votes = [0, 0, 0, 0];
    for (final pose in poses) {
      final turn = quarterTurnsForPose(pose);
      if (turn != null) votes[turn]++;
    }
    final total = votes.fold<int>(0, (sum, count) => sum + count);
    var best = 0;
    for (var i = 1; i < votes.length; i++) {
      if (votes[i] > votes[best]) best = i;
    }
    return votes[best] >= 3 && votes[best] / total >= 0.8 ? best : null;
  }

  /// The recorder saves the native first RGB frame as thumbnail.jpg. Reuse the
  /// playback default for that image, including recordings made before the fix.
  /// Read only the MCAP summary/index and initial poses, never decode video.
  static Future<int?> readRecordingQuarterTurns(String path) async {
    if (!path.toLowerCase().endsWith(".mcap")) return null;
    final reader = await McapReader.open(path);
    try {
      final rgb = reader.topics
          .where((value) => value.topic == "/camera/rgb/compressed")
          .firstOrNull;
      if (rgb == null) return null;
      final index = await reader.buildTopicIndex(rgb.channel.id);
      return await readInitialQuarterTurns(reader, rgb, index);
    } finally {
      await reader.close();
    }
  }

  static Future<int?> readInitialQuarterTurns(
    McapReader reader,
    McapTopicInfo topic,
    List<McapMessageRef> visualIndex,
  ) async {
    if (topic.topic != "/camera/rgb/compressed" &&
        topic.topic != "/camera/depth") {
      return null;
    }
    final metadataIndex = reader.metadataIndexes
        .where((value) => value.name == "session_metadata")
        .firstOrNull;
    if (metadataIndex == null) return null;
    final metadata = await reader.readMetadata(metadataIndex);
    if (!_nativeVersions.contains(metadata["capture_geometry_version"]) ||
        metadata["capture_geometry.rgb_orientation"] !=
            "native_cpu_unrotated" ||
        metadata["capture_geometry.pose"] !=
            "camera.pose_physical_camera_to_world" ||
        metadata["capture_geometry.camera_axes"] != "x_right_y_up_z_backward" ||
        metadata["capture_geometry.optical_axes"] !=
            "x_right_y_down_z_forward") {
      return null;
    }
    final poseTopic = reader.topics
        .where(
          (value) =>
              value.topic == "/camera/pose" &&
              value.schemaName == "geometry_msgs/msg/PoseStamped",
        )
        .firstOrNull;
    if (poseTopic == null) return null;
    final events = visualIndex.take(30).map((value) => value.logTimeNs).toSet();
    final poseIndex = await reader.buildTopicIndex(poseTopic.channel.id);
    final poses = <Pose3D>[];
    for (final ref in poseIndex) {
      if (!events.contains(ref.logTimeNs)) continue;
      final message = await reader.readMessage(ref);
      final decoded = Ros2MessageDecoder.decode(
        poseTopic.schemaName,
        message.payload,
      );
      final pose = decoded.scene?.poses.firstOrNull;
      if (pose != null) poses.add(pose);
      if (poses.length >= 12) break;
    }
    return stableQuarterTurns(poses);
  }
}
