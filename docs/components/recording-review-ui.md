# Clip review

The application serves a single review and playback page at `/clips/<clipId>`. Staff reach it through the Data browser and can open the clip's processing details. A customer can open a clip from a dataset they can access after every current member has been approved.

The page shows the accepted result's video range, caption cards, hand overlay and timeline. Source artifacts remain immutable. Caption corrections are append-only and apply to the selected job, manifest digest and selection revision. Dataset search, playback and exports use the effective caption.

See [Recordings, clip processing and dataset review](clip-review-and-datasets.md) for routes, review actions and access rules. See [Segment marks](segment-marks.md) for boundary and hand-pose checks.
