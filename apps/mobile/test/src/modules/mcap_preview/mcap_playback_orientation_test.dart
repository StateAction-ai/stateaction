import "dart:io";
import "dart:convert";
import "dart:math" as math;
import "dart:ui" as ui;

import "package:flutter/material.dart";
import "package:flutter/rendering.dart";
import "package:flutter_test/flutter_test.dart";
import "package:stera/src/core/common/widgets/video_thumbnail/video_thumbnail.dart";
import "package:stera/src/modules/mcap_preview/helpers/mcap_playback_orientation.dart";
import "package:stera/src/modules/mcap_preview/providers/mcap_topic_player_provider.dart";
import "package:stera/src/modules/mcap_preview/ui/widgets/player/mcap_frame_view.dart";
import "package:stera/src/services/mcap_reader/cdr/scene3d.dart";
import "package:stera/src/services/mcap_reader/mcap_reader.dart";
import "package:stera/src/modules/upload/ui/widgets/upload_file_tile/mcap_recording_thumbnail.dart";

Pose3D roll(double radians) => Pose3D(
  x: 0,
  y: 0,
  z: 0,
  qz: math.sin(radians / 2),
  qw: math.cos(radians / 2),
);

void main() {
  test("known camera rolls produce all four display rotations", () {
    for (var turn = 0; turn < 4; turn++) {
      expect(
        McapPlaybackOrientation.quarterTurnsForPose(roll(-turn * math.pi / 2)),
        turn,
      );
    }
  });

  test("observed Pixel upside-down camera orientations need 180 degrees", () {
    const poses = [
      Pose3D(
        x: 0,
        y: 0,
        z: 0,
        qx: .09033998717933872,
        qy: .4154365345979473,
        qz: .903696837055068,
        qw: -.05082518208872001,
      ),
      Pose3D(
        x: 0,
        y: 0,
        z: 0,
        qx: -.015472746324119603,
        qy: .36591127207264146,
        qz: .9304438751211425,
        qw: -.011988758940058283,
      ),
    ];
    for (final pose in poses) {
      expect(McapPlaybackOrientation.quarterTurnsForPose(pose), 2);
    }
  });

  test(
    "ambiguous, vertical, invalid and inconsistent evidence leaves native view",
    () {
      expect(
        McapPlaybackOrientation.quarterTurnsForPose(roll(math.pi / 4)),
        isNull,
      );
      expect(
        McapPlaybackOrientation.quarterTurnsForPose(
          Pose3D(
            x: 0,
            y: 0,
            z: 0,
            qx: math.sin(math.pi / 4),
            qw: math.cos(math.pi / 4),
          ),
        ),
        isNull,
      );
      expect(
        McapPlaybackOrientation.quarterTurnsForPose(
          const Pose3D(x: 0, y: 0, z: 0, qw: 2),
        ),
        isNull,
      );
      expect(
        McapPlaybackOrientation.stableQuarterTurns([roll(0), roll(0)]),
        isNull,
      );
      expect(
        McapPlaybackOrientation.stableQuarterTurns([
          roll(0),
          roll(0),
          roll(0),
          roll(math.pi),
          roll(math.pi),
          roll(math.pi),
        ]),
        isNull,
      );
      expect(
        McapPlaybackOrientation.stableQuarterTurns(
          List.filled(4, roll(math.pi)),
        ),
        2,
      );
    },
  );

  test(
    "actual native MCAP metadata and exact pose events select an upright default",
    () async {
      final reader = await McapReader.open(
        "test/fixtures/mcap/native_cpu_v3.mcap",
      );
      addTearDown(reader.close);
      for (final name in ["/camera/rgb/compressed", "/camera/depth"]) {
        final topic = reader.topics.firstWhere((value) => value.topic == name);
        final index = await reader.buildTopicIndex(topic.channel.id);
        expect(
          await McapPlaybackOrientation.readInitialQuarterTurns(
            reader,
            topic,
            index,
          ),
          0,
        );
        // The provider exposes a view control without changing the reader index.
        final player = McapTopicPlayerProvider(reader: reader, topic: topic);
        var changes = 0;
        player.addListener(() => changes++);
        for (var i = 0; i < 4; i++) {
          player.rotateViewClockwise();
        }
        expect(player.viewQuarterTurns, 0);
        expect(changes, 4);
        expect(player.current, isNull);
        expect(
          (await reader.buildTopicIndex(
            topic.channel.id,
          )).map((ref) => ref.logTimeNs),
          index.map((ref) => ref.logTimeNs),
        );
        player.dispose();
      }
    },
  );

  test(
    "recording thumbnail uses the playback default and ignores plain videos",
    () async {
      expect(
        await McapPlaybackOrientation.readRecordingQuarterTurns(
          "test/fixtures/mcap/native_cpu_v3.mcap",
        ),
        0,
      );
      expect(
        await McapPlaybackOrientation.readRecordingQuarterTurns("video.mp4"),
        isNull,
      );
    },
  );

  testWidgets(
    "thumbnail rotation preserves pixels and leaves overlays upright",
    (tester) async {
      final recorder = ui.PictureRecorder();
      final canvas = Canvas(recorder);
      const colors = [Colors.red, Colors.green, Colors.blue, Colors.yellow];
      for (var i = 0; i < 4; i++) {
        canvas.drawRect(
          Rect.fromLTWH((i % 2) * 40, (i ~/ 2) * 20, 40, 20),
          Paint()..color = colors[i],
        );
      }
      final picture = recorder.endRecording();
      final original = (await tester.runAsync(() => picture.toImage(80, 40)))!;
      picture.dispose();
      final png = (await tester.runAsync(
        () => original.toByteData(format: ui.ImageByteFormat.png),
      ))!.buffer.asUint8List();
      final encoded = base64Encode(png);
      const order = [
        [0, 1, 2, 3],
        [2, 0, 3, 1],
        [3, 2, 1, 0],
        [1, 3, 0, 2],
      ];
      Offset? overlayPosition;
      for (var turn = 0; turn < 4; turn++) {
        final boundaryKey = GlobalKey();
        await tester.pumpWidget(
          MaterialApp(
            home: Center(
              child: RepaintBoundary(
                key: boundaryKey,
                child: VideoThumbnail(
                  imageUrl: encoded,
                  width: 80,
                  height: 40,
                  showDuration: false,
                  imageQuarterTurns: turn,
                  overlay: const Positioned(
                    top: 0,
                    left: 0,
                    child: Text("UP", style: TextStyle(fontSize: 4)),
                  ),
                ),
              ),
            ),
          ),
        );
        final imageProvider = tester.widget<Image>(find.byType(Image)).image;
        await tester.runAsync(
          () =>
              precacheImage(imageProvider, tester.element(find.byType(Image))),
        );
        await tester.pumpAndSettle();
        overlayPosition ??= tester.getTopLeft(find.text("UP"));
        expect(tester.getTopLeft(find.text("UP")), overlayPosition);
        expect(
          find.descendant(
            of: find.byType(RotatedBox),
            matching: find.text("UP"),
          ),
          findsNothing,
        );
        final boundary =
            boundaryKey.currentContext!.findRenderObject()!
                as RenderRepaintBoundary;
        final rendered = (await tester.runAsync(() => boundary.toImage()))!;
        final rgba = (await tester.runAsync(
          () => rendered.toByteData(),
        ))!.buffer.asUint8List();
        const samples = [(20, 10), (60, 10), (20, 30), (60, 30)];
        for (var i = 0; i < samples.length; i++) {
          final offset = (samples[i].$2 * rendered.width + samples[i].$1) * 4;
          final color = colors[order[turn][i]];
          expect(rgba.sublist(offset, offset + 3), [
            (color.r * 255).round(),
            (color.g * 255).round(),
            (color.b * 255).round(),
          ]);
        }
        rendered.dispose();
        final provider = tester.widget<Image>(find.byType(Image)).image;
        final memory = provider is ResizeImage
            ? provider.imageProvider
            : provider;
        expect(memory, isA<MemoryImage>());
        expect((memory as MemoryImage).bytes, png);
      }
      await tester.pumpWidget(const SizedBox.shrink());
      original.dispose();
    },
  );

  testWidgets("missing MCAP thumbnail falls back without an unhandled error", (
    tester,
  ) async {
    await tester.pumpWidget(
      const MaterialApp(
        home: McapRecordingThumbnail(
          recordingPath: "missing.mcap",
          filePath: "missing.jpg",
        ),
      ),
    );
    await tester.runAsync(() async {
      await Future<void>.delayed(const Duration(milliseconds: 20));
    });
    await tester.pump();
    expect(tester.takeException(), isNull);
    expect(
      tester
          .widget<VideoThumbnail>(find.byType(VideoThumbnail))
          .imageQuarterTurns,
      0,
    );
  });

  testWidgets(
    "quarter turns swap display bounds while retaining the same decoded pixels",
    (tester) async {
      final recorder = ui.PictureRecorder();
      final canvas = Canvas(recorder);
      const colors = [Colors.red, Colors.green, Colors.blue, Colors.yellow];
      for (var i = 0; i < 4; i++) {
        canvas.drawRect(
          Rect.fromLTWH((i % 2) * 20, (i ~/ 2) * 10, 20, 10),
          Paint()..color = colors[i],
        );
      }
      final picture = recorder.endRecording();
      final image = (await tester.runAsync(() => picture.toImage(40, 20)))!;
      picture.dispose();
      final before = (await tester.runAsync(
        () => image.toByteData(),
      ))!.buffer.asUint8List().toList();
      for (var turn = 0; turn < 4; turn++) {
        final boundaryKey = GlobalKey();
        await tester.pumpWidget(
          MaterialApp(
            home: Center(
              child: RepaintBoundary(
                key: boundaryKey,
                child: SizedBox(
                  width: 80,
                  height: 80,
                  child: McapFrameView(image: image, quarterTurns: turn),
                ),
              ),
            ),
          ),
        );
        final size = tester.getSize(find.byType(RotatedBox));
        expect(size, turn.isEven ? const Size(40, 20) : const Size(20, 40));
        expect(
          tester.widget<RawImage>(find.byType(RawImage)).image,
          same(image),
        );
        expect(
          (await tester.runAsync(
            () => image.toByteData(),
          ))!.buffer.asUint8List().toList(),
          before,
        );
        final boundary =
            boundaryKey.currentContext!.findRenderObject()!
                as RenderRepaintBoundary;
        final rendered = (await tester.runAsync(() => boundary.toImage()))!;
        final rgba = (await tester.runAsync(
          () => rendered.toByteData(),
        ))!.buffer.asUint8List();
        final samples = turn.isEven
            ? [(20, 30), (60, 30), (20, 50), (60, 50)]
            : [(30, 20), (50, 20), (30, 60), (50, 60)];
        const order = [
          [0, 1, 2, 3],
          [2, 0, 3, 1],
          [3, 2, 1, 0],
          [1, 3, 0, 2],
        ];
        for (var i = 0; i < samples.length; i++) {
          final offset = (samples[i].$2 * rendered.width + samples[i].$1) * 4;
          final color = colors[order[turn][i]];
          expect(rgba.sublist(offset, offset + 3), [
            (color.r * 255).round(),
            (color.g * 255).round(),
            (color.b * 255).round(),
          ]);
        }
        rendered.dispose();
      }
      await tester.pumpWidget(const SizedBox.shrink());
      image.dispose();
    },
  );

  // Optional read-only integration check against a locally pulled recording.
  // Personal capture paths and payloads never enter the repository fixture.
  final local = Platform.environment["STERA_LOCAL_CAPTURE_MCAP"];
  if (local != null) {
    test(
      "local Pixel RGB and depth choose the same 180-degree presentation",
      () async {
        expect(
          await McapPlaybackOrientation.readRecordingQuarterTurns(local),
          2,
        );
        final reader = await McapReader.open(local);
        addTearDown(reader.close);
        for (final name in ["/camera/rgb/compressed", "/camera/depth"]) {
          final topic = reader.topics.firstWhere(
            (value) => value.topic == name,
          );
          final index = await reader.buildTopicIndex(topic.channel.id);
          expect(
            await McapPlaybackOrientation.readInitialQuarterTurns(
              reader,
              topic,
              index,
            ),
            2,
          );
        }
      },
    );
    testWidgets(
      "actual Pixel recording thumbnail receives 180-degree rotation",
      (tester) async {
        await tester.pumpWidget(
          MaterialApp(
            home: McapRecordingThumbnail(
              recordingPath: local,
              filePath: "${File(local).parent.path}/thumbnail.jpg",
            ),
          ),
        );
        for (var i = 0; i < 1000; i++) {
          await tester.runAsync(
            () => Future<void>.delayed(const Duration(milliseconds: 10)),
          );
          await tester.pump();
          if (tester
                  .widget<VideoThumbnail>(find.byType(VideoThumbnail))
                  .imageQuarterTurns ==
              2) {
            break;
          }
        }
        expect(tester.takeException(), isNull);
        expect(
          tester
              .widget<VideoThumbnail>(find.byType(VideoThumbnail))
              .imageQuarterTurns,
          2,
        );
      },
    );
  }
}
