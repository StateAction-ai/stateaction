"""Append-only JSONL checkpoint of per-window results."""

import hashlib
import json
import os
import threading
from pathlib import Path


def sha256_json(value):
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


def sha256_text(text):
    return hashlib.sha256(text.encode()).hexdigest()


class CheckpointMismatch(RuntimeError):
    pass


class Checkpoint:
    """Rows: one header, then window rows. Latest row per key wins."""

    def __init__(self, path, header):
        self.path = Path(path)
        self.header = dict(header, kind="header")
        self.rows = {}
        self._lock = threading.Lock()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        if self.path.exists() and self.path.stat().st_size:
            with self.path.open() as f:
                lines = f.read().splitlines()
            first = json.loads(lines[0])
            for key in ("source_sha256", "run_config_sha256"):
                if first.get(key) != self.header.get(key):
                    raise CheckpointMismatch(
                        f"checkpoint {key} differs: {first.get(key)} != {self.header.get(key)}"
                    )
            for line in lines[1:]:
                try:
                    row = json.loads(line)
                except json.JSONDecodeError:  # torn final line after a kill
                    continue
                self.rows[self.key_of(row)] = row
            self._f = self.path.open("a")
        else:
            self._f = self.path.open("a")
            self._write(self.header)

    @staticmethod
    def key(source_sha256, window_id, prompt_sha256, input_digest):
        return (source_sha256, window_id, prompt_sha256, input_digest)

    @classmethod
    def key_of(cls, row):
        return cls.key(
            row["source_sha256"],
            row["window_id"],
            row["prompt_sha256"],
            row["input_digest"],
        )

    def _write(self, row):
        self._f.write(json.dumps(row, separators=(",", ":")) + "\n")
        self._f.flush()
        os.fsync(self._f.fileno())

    def get(self, key):
        return self.rows.get(key)

    def put(self, row):
        with self._lock:
            self._write(row)
            self.rows[self.key_of(row)] = row

    def close(self):
        self._f.close()
