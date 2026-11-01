"""Independent decode of golden MCAP: official `mcap` reader + official Protobuf runtime + ffmpeg H.264 decoder.

None of this uses capture_conformance's MCAP/protobuf/Annex B parsing. Run via verify.py or:
  uv run --no-project --with mcap==1.6.0 --with protobuf==6.33.0 python independent_decode.py golden/valid.mcap
"""

from __future__ import annotations

import hashlib
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from google.protobuf import descriptor_pb2, descriptor_pool, message_factory
from mcap.reader import make_reader


def decode(path: Path) -> dict:
    out = {
        "profile": None,
        "video": [],
        "json_counts": {},
        "cdr_bytes": 0,
        "schema_sha256": {},
    }
    with path.open("rb") as f:
        reader = make_reader(f)
        out["profile"] = reader.get_header().profile
        stream = bytearray()
        cls = None
        for schema, channel, msg in reader.iter_messages():
            out["schema_sha256"][schema.name] = hashlib.sha256(schema.data).hexdigest()
            if schema.name == "foxglove.CompressedVideo":
                if cls is None:
                    fds = descriptor_pb2.FileDescriptorSet.FromString(schema.data)
                    pool = descriptor_pool.DescriptorPool()
                    for fd in fds.file:  # dependency order: timestamp first
                        pool.Add(fd)
                    cls = message_factory.GetMessageClass(
                        pool.FindMessageTypeByName("foxglove.CompressedVideo")
                    )
                v = cls.FromString(msg.data)
                out["video"].append(
                    {
                        "sequence": msg.sequence,
                        "log_time": msg.log_time,
                        "capture_ns": v.timestamp.seconds * 10**9 + v.timestamp.nanos,
                        "frame_id": v.frame_id,
                        "format": v.format,
                        "bytes": len(v.data),
                    }
                )
                stream += v.data
            elif channel.message_encoding == "json":
                json.loads(msg.data)
                out["json_counts"][channel.topic] = (
                    out["json_counts"].get(channel.topic, 0) + 1
                )
            elif channel.message_encoding == "cdr":
                out["cdr_bytes"] += len(msg.data)
    ffmpeg = shutil.which("ffmpeg")
    out["decoded_frames"] = None
    if ffmpeg and stream:
        with tempfile.TemporaryDirectory() as d:
            raw = Path(d) / "in.h264"
            raw.write_bytes(stream)
            r = subprocess.run(
                [ffmpeg, "-v", "error", "-i", str(raw), "-f", "null", "-"],
                capture_output=True,
                text=True,
            )
            probe = subprocess.run(
                [
                    shutil.which("ffprobe"),
                    "-v",
                    "error",
                    "-count_frames",
                    "-select_streams",
                    "v:0",
                    "-show_entries",
                    "stream=nb_read_frames",
                    "-of",
                    "csv=p=0",
                    str(raw),
                ],
                capture_output=True,
                text=True,
            )
            out["decoded_frames"] = int(probe.stdout.strip() or 0)
            out["ffmpeg_errors"] = r.stderr.strip()
    return out


if __name__ == "__main__":
    print(json.dumps(decode(Path(sys.argv[1])), indent=1))
