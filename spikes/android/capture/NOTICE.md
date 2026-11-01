# Third-party source provenance

`MCAPWriter.kt` is adapted from the cloned Stera app, copyright 2026 FPV Labs,
Apache-2.0. The original license is retained as `LICENSE-STERA`.
The original writer is not changed by this spike. Modifications are marked in its header.
ARCore is a pinned Maven dependency (`com.google.ar:core:1.44.0`); this is reuse of
an already installed dependency, not a claim that every current ARCore feature is supported.
Foxglove descriptor provenance is recorded separately in `app/src/main/assets/schema-provenance.json`.

The copied `foxglove.CompressedVideo` descriptor is from `foxglove-schemas-protobuf==0.4.0` (Foxglove schemas, MIT). The MIT text is preserved in `LICENSE-FOXGLOVE-SCHEMAS`. It includes Google's protobuf Timestamp descriptor; the protobuf license is retained in `LICENSE-PROTOBUF` (source: https://raw.githubusercontent.com/protocolbuffers/protobuf/main/LICENSE). This is a descriptor, not a redistributed protobuf runtime.
