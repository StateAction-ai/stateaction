import "dart:ui" as ui;

import "package:flutter/material.dart";

/// Rotation belongs to presentation. The decoded image retains native pixels.
class McapFrameView extends StatelessWidget {
  const McapFrameView({super.key, required this.image, this.quarterTurns = 0});

  final ui.Image? image;
  final int quarterTurns;

  @override
  Widget build(BuildContext context) {
    final image = this.image;
    if (image == null) return const SizedBox.shrink();
    final width = image.width.toDouble();
    final height = image.height.toDouble();
    return FittedBox(
      fit: BoxFit.contain,
      child: RotatedBox(
        quarterTurns: quarterTurns,
        child: SizedBox(
          width: width,
          height: height,
          child: RawImage(image: image, width: width, height: height),
        ),
      ),
    );
  }
}
