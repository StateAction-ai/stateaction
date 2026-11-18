#!/usr/bin/env python3
"""Deterministic synthetic source bytes shared by the SA-57 emulator harness and its host driver.

The device (`NativeUploadOsQualificationTest.materialize`) and the host derive identical bytes from a seed
(FNV-1a 64 seeding a SplitMix64 stream, little-endian words), so the host can reserve a server upload with the
exact size and SHA-256 before the file exists on the emulator. Synthetic data only; nothing is a capture.
"""

from __future__ import annotations

import hashlib
import sys

MASK = (1 << 64) - 1


def fnv64(seed: str) -> int:
    h = 0xCBF29CE484222325
    for b in seed.encode():
        h = ((h ^ b) * 0x100000001B3) & MASK
    return h


def stream(seed: str, size: int):
    """Yield the bytes in chunks of at most 64 KiB."""
    state = fnv64(seed)
    produced = 0
    buf = bytearray()
    while produced < size:
        state = (state + 0x9E3779B97F4A7C15) & MASK
        z = state
        z = ((z ^ (z >> 30)) * 0xBF58476D1CE4E5B9) & MASK
        z = ((z ^ (z >> 27)) * 0x94D049BB133111EB) & MASK
        z ^= z >> 31
        word = z.to_bytes(8, "little")
        take = min(8, size - produced)
        buf += word[:take]
        produced += take
        if len(buf) >= 65536:
            yield bytes(buf)
            buf.clear()
    if buf:
        yield bytes(buf)


def sha256(seed: str, size: int) -> str:
    digest = hashlib.sha256()
    for chunk in stream(seed, size):
        digest.update(chunk)
    return digest.hexdigest()


if __name__ == "__main__":
    print(sha256(sys.argv[1], int(sys.argv[2])))
