"""Keep a durable submission fence without persisting the claim credential."""

import json
import os
import tempfile
from pathlib import Path
from uuid import UUID


class Journal:
    def __init__(self, root: Path, job_id: str):
        self.directory = root / str(UUID(job_id))
        self.path = self.directory / "journal.json"

    def reserve(self, run_ref: str) -> bool:
        try:
            self.directory.mkdir(mode=0o700)
        except FileExistsError:
            # Even an empty directory can be evidence of a process that crashed.
            return False
        self._sync(self.directory.parent)
        self.write(run_ref, "intent")
        return True

    def write(self, run_ref: str, phase: str, call_id: str | None = None) -> None:
        with tempfile.NamedTemporaryFile(dir=self.directory, delete=False) as tmp:
            name = Path(tmp.name)
            try:
                tmp.write(
                    json.dumps(
                        {"runRef": run_ref, "phase": phase, "callId": call_id}
                    ).encode()
                )
                tmp.flush()
                os.fsync(tmp.fileno())
                name.replace(self.path)
                self._sync(self.directory)
            finally:
                name.unlink(missing_ok=True)

    @staticmethod
    def _sync(path: Path) -> None:
        fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
