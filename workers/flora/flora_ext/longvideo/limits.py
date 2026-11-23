import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Limits:
    """Input limits. Reference values: 120 s, 256 MiB, 4096 px, 7200 frames."""

    max_duration_s: float = 6 * 3600
    max_upload_bytes: int = 8 * 1024**3
    max_dimension: int = 4096
    max_frame_count: int = 2_000_000
    min_fps: int = 4  # model needs >= 4 source fps; not relaxed

    @classmethod
    def reference(cls):
        return cls(120, 256 * 1024 * 1024, 4096, 7200)

    @classmethod
    def from_env(cls, prefix="FLORA_LONG_"):
        d = cls()
        kw = {}
        for name in (
            "max_duration_s",
            "max_upload_bytes",
            "max_dimension",
            "max_frame_count",
        ):
            v = os.environ.get(prefix + name.upper())
            if v:
                kw[name] = (
                    type(getattr(d, name))(float(v))
                    if name != "max_duration_s"
                    else float(v)
                )
        return cls(**{**d.__dict__, **kw})
