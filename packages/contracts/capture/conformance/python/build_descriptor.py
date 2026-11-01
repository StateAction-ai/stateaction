"""Rebuild foxglove-compressed-video.desc from the pinned upstream wheel and print its SHA-256.

  uv run --no-project --with foxglove-schemas-protobuf==0.4.0 --with protobuf==6.33.0 \\
      python packages/contracts/capture/conformance/python/build_descriptor.py [--write]

The wheel itself is pinned by sha256 in schema-provenance.json (upstream_artifacts). The descriptor is the
transitive FileDescriptorSet [google/protobuf/timestamp.proto, foxglove/CompressedVideo.proto] serialized
deterministically. Exit status 1 when the rebuilt bytes differ from the committed descriptor.
"""

from __future__ import annotations

import hashlib
import sys
from pathlib import Path

from foxglove_schemas_protobuf.CompressedVideo_pb2 import CompressedVideo
from google.protobuf import descriptor_pb2

CAPTURE = Path(__file__).resolve().parents[2]


def build() -> bytes:
    fds = descriptor_pb2.FileDescriptorSet()
    video = CompressedVideo.DESCRIPTOR.file
    for dependency in video.dependencies:  # timestamp.proto first: dependency order
        dependency.CopyToProto(fds.file.add())
    video.CopyToProto(fds.file.add())
    return fds.SerializeToString(deterministic=True)


if __name__ == "__main__":
    data = build()
    committed = (CAPTURE / "foxglove-compressed-video.desc").read_bytes()
    print(hashlib.sha256(data).hexdigest(), "rebuilt")
    print(hashlib.sha256(committed).hexdigest(), "committed")
    if "--write" in sys.argv:
        (CAPTURE / "foxglove-compressed-video.desc").write_bytes(data)
    sys.exit(0 if data == committed else 1)
