/// The source RGB encoding, independent of any review-video format.
enum RgbVideoCodec {
  jpeg,
  h264;

  static RgbVideoCodec fromBuildValue(String value) => switch (value) {
    "jpeg" => jpeg,
    "h264" => h264,
    _ => throw ArgumentError.value(
      value,
      "STATEACTION_RGB_CODEC",
      "Use jpeg or h264",
    ),
  };
}
