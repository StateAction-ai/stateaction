"""SA-45: bounded, allowlisted worker resource facts and non-masking emission."""

from __future__ import annotations

import contextlib
import io
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import uuid
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from unittest import mock

from stateaction_processing import resource_probe as rp
from stateaction_processing import run_job
from stateaction_processing.resource_probe import ResourceProbe, walk_bytes

JOB = str(uuid.uuid4())
LOCAL_REF = f"local-{uuid.uuid4()}"
MODAL_REF = "fc-01HZABCDEF1234567890XYZ"


def _probe(**kw: str) -> ResourceProbe:
    return ResourceProbe(
        job_id=kw.get("job_id", JOB),
        backend=kw.get("backend", "local"),
        execution_ref=kw.get("execution_ref", LOCAL_REF),
    )


def _line(stream: io.StringIO) -> dict[str, Any]:
    text = stream.getvalue()
    assert text.startswith("sa_metrics ") and text.count("\n") == 1
    return dict(json.loads(text[len("sa_metrics ") :]))


class WalkTests(unittest.TestCase):
    def test_walk_never_follows_symlinks_and_reports_lower_bound(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw) / "scratch"
            root.mkdir()
            (root / "a.bin").write_bytes(b"x" * 100)
            (root / "sub").mkdir()
            (root / "sub" / "b.bin").write_bytes(b"y" * 50)
            outside = Path(raw) / "outside-secret.bin"
            outside.write_bytes(b"z" * 10_000)
            (root / "link").symlink_to(outside)
            (root / "dirlink").symlink_to(raw, target_is_directory=True)
            self.assertEqual(walk_bytes(root), (150, True))

    def test_entry_and_depth_bounds_mark_incomplete(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            for i in range(5):
                (root / f"f{i}").write_bytes(b"1")
            with mock.patch.object(rp, "MAX_WALK_ENTRIES", 3):
                self.assertFalse(walk_bytes(root)[1])
            (root / "d1" / "d2").mkdir(parents=True)
            with mock.patch.object(rp, "MAX_WALK_DEPTH", 1):
                self.assertFalse(walk_bytes(root)[1])


class ScratchTests(unittest.TestCase):
    def test_only_the_registered_directory_is_measured_never_the_temp_tree(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as raw:
            tmp = Path(raw)
            # Unrelated and pre-existing look-alikes in the same parent must not count.
            (tmp / "sa28-worker-other").mkdir()
            (tmp / "sa28-worker-other" / "f").write_bytes(b"o" * 9_000)
            (tmp / "unrelated").mkdir()
            (tmp / "unrelated" / "f").write_bytes(b"u" * 7_000)
            probe = _probe()
            mine = tmp / "sa28-worker-mine"
            mine.mkdir()
            (mine / "frames.bin").write_bytes(b"m" * 4_096)
            with mock.patch("os.scandir", wraps=os.scandir) as scan:
                self.assertTrue(probe.register_scratch(mine))
                record = probe.record(0, "returned")
            scanned = {str(c.args[0]) for c in scan.call_args_list}
            self.assertEqual(scanned, {str(mine)})
            self.assertEqual(record["scratchHighWaterBytes"], 4_096)
            self.assertEqual(record["scratchStatus"], "sampled_lower_bound")

    def test_unregistered_probe_reports_unknown_not_zero(self) -> None:
        record = _probe().record(None, "raised")
        self.assertIsNone(record["scratchHighWaterBytes"])
        self.assertEqual(record["scratchStatus"], "unknown")
        self.assertIsNone(record["exitCode"])
        self.assertEqual(record["bytes"], {})
        self.assertNotIn("peakRssBytes", record)
        self.assertEqual(record["rssScope"], "process_high_water_not_aggregate")

    def test_registration_rejects_symlinks_relative_missing_and_excess(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            real = Path(raw) / "real"
            real.mkdir()
            link = Path(raw) / "link"
            link.symlink_to(real, target_is_directory=True)
            probe = _probe()
            self.assertFalse(probe.register_scratch(link))
            self.assertFalse(probe.register_scratch("relative/dir"))
            self.assertFalse(probe.register_scratch(Path(raw) / "missing"))
            for i in range(rp.MAX_SCRATCH_DIRS):
                d = Path(raw) / f"d{i}"
                d.mkdir()
                self.assertTrue(probe.register_scratch(d))
            extra = Path(raw) / "extra"
            extra.mkdir()
            self.assertFalse(probe.register_scratch(extra))
            probe.record(0, "returned")
            self.assertFalse(
                probe.register_scratch(real)
            )  # finished probes accept nothing

    def test_high_water_survives_cleanup_and_sampler_thread_stops(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            mine = Path(raw) / "sa28-worker-x"
            mine.mkdir()
            (mine / "a").write_bytes(b"a" * 2_048)
            probe = _probe()
            probe.register_scratch(mine)
            (mine / "a").unlink()
            mine.rmdir()  # pipeline cleaned up before emit
            before = threading.active_count()
            record = probe.record(0, "returned")
            self.assertEqual(record["scratchHighWaterBytes"], 2_048)
            deadline = time.monotonic() + 3
            while threading.active_count() >= before and time.monotonic() < deadline:
                time.sleep(0.01)
            self.assertNotIn("sa-probe", [t.name for t in threading.enumerate()])
            probe.record(0, "returned")  # idempotent teardown

    def test_sampling_failure_never_raises_and_marks_incomplete(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            mine = Path(raw) / "s"
            mine.mkdir()
            probe = _probe()
            probe.register_scratch(mine)
            with mock.patch.object(rp, "walk_bytes", side_effect=RuntimeError("boom")):
                probe.sample_now()
                record = probe.record(0, "returned")
            self.assertEqual(record["scratchStatus"], "sampled_incomplete")


class EmitTests(unittest.TestCase):
    def test_hostile_identifiers_and_bytes_are_dropped_not_escaped(self) -> None:
        secret = (
            "https://r2.example/obj?X-Amz-Signature=deadbeef&token=sa_svc_" + "A" * 43
        )
        probe = _probe(
            job_id=secret, backend="evil", execution_ref=f"/home/u/.tokens/{secret}"
        )
        probe.note_bytes("source", "declared", -1)
        probe.note_bytes("source", "uploaded", True)
        probe.note_bytes("../etc/passwd", "verified", 5)
        probe.note_bytes("output", "claimed", 5)
        probe.note_bytes("output", "verified", 123)
        out = io.StringIO()
        probe.emit(0, "returned\nforged", stream=out)
        record = _line(out)
        self.assertIsNone(record["jobId"])
        self.assertIsNone(record["backend"])
        self.assertIsNone(record["executionRef"])
        self.assertIsNone(record["outcome"])
        self.assertEqual(record["bytes"], {"output": {"verified": 123}})
        for needle in ("X-Amz", "sa_svc_", "/home/u", "passwd", "forged", "deadbeef"):
            self.assertNotIn(needle, out.getvalue())

    def test_execution_ref_must_match_the_backend_form(self) -> None:
        for backend, ref, ok in (
            ("local", LOCAL_REF, True),
            ("modal", MODAL_REF, True),
            ("modal", LOCAL_REF, False),
            ("local", MODAL_REF, False),
            ("local", "local-" + "A" * 40, False),
            ("local", LOCAL_REF + "\n", False),
            ("modal", "fc-" + "A" * 78, False),
        ):
            record = _probe(backend=backend, execution_ref=ref).record(0, "returned")
            self.assertEqual(
                record["executionRef"], ref if ok else None, (backend, ref)
            )

    def test_emit_is_bounded_and_failures_are_swallowed(self) -> None:
        probe = _probe()

        class Broken:
            def write(self, _: str) -> None:
                raise OSError("closed")

            def flush(self) -> None:
                raise OSError("closed")

        probe.emit(0, "returned", stream=Broken())  # must not raise
        out = io.StringIO()
        with mock.patch.object(rp, "MAX_LINE_BYTES", 10):
            probe.emit(0, "returned", stream=out)
        self.assertEqual(
            out.getvalue(), ""
        )  # over-cap lines are dropped, never truncated

    def test_measures_a_real_local_cpu_child_high_water(self) -> None:
        """A real waited-for child: its ru_maxrss is reported separately from ours."""
        probe = _probe()
        subprocess.run(  # noqa: S603 - fixed argv, no shell
            [
                sys.executable,
                "-c",
                "b = bytearray(96 * 1024 * 1024); b[::4096] = b'x' * len(b[::4096])",
            ],
            check=True,
            env={"PATH": os.environ.get("PATH", ""), "PYTHONNOUSERSITE": "1"},
        )
        record = probe.record(0, "returned")
        self.assertGreaterEqual(record["peakRssChildrenBytes"], 64 * 1024 * 1024)
        self.assertGreater(record["peakRssSelfBytes"], 0)
        self.assertGreaterEqual(record["wallSeconds"], 0)


def _boot() -> dict[str, Any]:
    return {
        "jobId": JOB,
        "pipeline": "hand_pose_cpu_v1",
        "executorKind": "local",
        "apiUrl": "http://127.0.0.1:1",
        "bootstrapToken": "sa_svc_" + "A" * 43,
    }


def _grant(body: dict[str, Any]) -> dict[str, Any]:
    return {
        "jobId": JOB,
        "invocationNonce": body["invocationNonce"],
        "capability": {"token": "sa_svc_" + "B" * 43},
    }


class RunJobEmissionTests(unittest.TestCase):
    """The probe wraps the import and the processing and can never change the result."""

    def _run(
        self,
        module_run: Any = None,
        import_error: Exception | None = None,
        emit_error: bool = False,
    ) -> tuple[Any, BaseException | None, str]:
        stderr = io.StringIO()

        def post(_url: str, _token: str, body: dict[str, Any]) -> dict[str, Any]:
            return _grant(body)

        def fake_import(_name: str) -> Any:
            if import_error is not None:
                raise import_error
            return SimpleNamespace(run=module_run)

        patches = [
            mock.patch.object(run_job, "_read_bootstrap", return_value=_boot()),
            mock.patch.object(run_job, "_post", side_effect=post),
            mock.patch.object(
                run_job.importlib, "import_module", side_effect=fake_import
            ),
            mock.patch.object(run_job, "_pipeline_present", return_value=True),
        ]
        if emit_error:
            patches.append(
                mock.patch.object(
                    ResourceProbe, "emit", side_effect=RuntimeError("emit failed")
                )
            )
        result: Any = None
        error: BaseException | None = None
        with contextlib.ExitStack() as stack, contextlib.redirect_stderr(stderr):
            for p in patches:
                stack.enter_context(p)
            try:
                result = run_job.run(LOCAL_REF)
            except BaseException as raised:  # noqa: BLE001 - the test inspects the original
                error = raised
        return result, error, stderr.getvalue()

    @staticmethod
    def _metrics(text: str) -> dict[str, Any]:
        lines = [x for x in text.splitlines() if x.startswith("sa_metrics ")]
        assert len(lines) == 1, text
        return dict(json.loads(lines[0][len("sa_metrics ") :]))

    def test_return_code_is_kept_and_one_line_is_emitted(self) -> None:
        result, error, err = self._run(module_run=lambda _g, _c: 7)
        self.assertEqual((result, error), (7, None))
        record = self._metrics(err)
        self.assertEqual((record["outcome"], record["exitCode"]), ("returned", 7))
        self.assertEqual(record["jobId"], JOB)
        self.assertEqual(record["backend"], "local")
        self.assertEqual(record["executionRef"], LOCAL_REF)
        self.assertIsNotNone(record["importSeconds"])

    def test_sampler_start_failure_preserves_result_and_resource_receipt(self) -> None:
        with tempfile.TemporaryDirectory() as scratch:

            def run(_grant: Any, context: dict[str, Any]) -> int:
                self.assertFalse(context["metrics"].register_scratch(scratch))
                return 7

            with mock.patch.object(threading.Thread, "start", side_effect=RuntimeError):
                result, error, err = self._run(module_run=run)

        self.assertEqual((result, error), (7, None))
        record = self._metrics(err)
        self.assertEqual(record["exitCode"], 7)
        self.assertEqual(record["scratchStatus"], "unknown")
        self.assertIsNone(record["scratchHighWaterBytes"])
        self.assertGreater(record["peakRssSelfBytes"], 0)

    def test_pipeline_exception_propagates_unchanged_and_is_recorded(self) -> None:
        original = ValueError("pipeline failed")

        def boom(_g: Any, _c: Any) -> int:
            raise original

        result, error, err = self._run(module_run=boom)
        self.assertIsNone(result)
        self.assertIs(error, original)
        record = self._metrics(err)
        self.assertEqual((record["outcome"], record["exitCode"]), ("raised", None))

    def test_import_failure_is_covered_and_unchanged(self) -> None:
        original = ImportError("missing heavy dependency")
        result, error, err = self._run(import_error=original)
        self.assertIsNone(result)
        self.assertIs(error, original)
        record = self._metrics(err)
        self.assertEqual((record["outcome"], record["exitCode"]), ("raised", None))
        self.assertIsNone(record["importSeconds"])

    def test_emit_raising_never_masks_the_return_code_or_the_exception(self) -> None:
        result, error, _ = self._run(module_run=lambda _g, _c: 9, emit_error=True)
        self.assertEqual((result, error), (9, None))
        original = RuntimeError("pipeline failed")

        def boom(_g: Any, _c: Any) -> int:
            raise original

        result, error, _ = self._run(module_run=boom, emit_error=True)
        self.assertIs(error, original)
        original_import = ImportError("x")
        _, error, _ = self._run(import_error=original_import, emit_error=True)
        self.assertIs(error, original_import)

    def test_probe_construction_failure_changes_nothing(self) -> None:
        with mock.patch.object(run_job, "_start_probe", return_value=None):
            result, error, err = self._run(module_run=lambda _g, _c: 3)
        self.assertEqual((result, error), (3, None))
        self.assertNotIn("sa_metrics", err)


class HandPoseRegistrationTests(unittest.TestCase):
    """The real hand_pose_cpu_v1.run registers ITS scratch dir and samples before cleanup."""

    def test_run_registers_its_own_scratch_and_cleanup_keeps_the_high_water(
        self,
    ) -> None:
        from stateaction_processing import hand_pose_cpu_v1 as hp

        seen: dict[str, Path] = {}

        def fake_process(
            _api: Any,
            _sink: Any,
            _beater: Any,
            _grant: Any,
            _task: Any,
            scratch: Path,
            _ctx: Any,
        ) -> int:
            seen["scratch"] = scratch
            (scratch / "frames.bin").write_bytes(b"f" * 6_000)
            return 0

        class FakeApi:
            def __init__(self, _context: Any) -> None: ...
            def heartbeat(self, _phase: str) -> None: ...
            def call(self, _method: str, _path: str) -> dict[str, Any]:
                return {}

        class FakeBeater:
            def __init__(self, _api: Any) -> None: ...
            def start(self) -> None: ...
            def stop(self) -> None: ...

        probe = _probe()
        with (
            mock.patch.object(hp, "Api", FakeApi),
            mock.patch.object(hp, "_Beater", FakeBeater),
            mock.patch.object(hp, "ServerOutputSink", lambda *_a: None),
            mock.patch.object(hp, "_process", fake_process),
        ):
            self.assertEqual(hp.run({}, {"metrics": probe}), 0)
        self.assertFalse(seen["scratch"].exists())  # the pipeline's own cleanup ran
        record = probe.record(0, "returned")
        self.assertGreaterEqual(record["scratchHighWaterBytes"], 6_000)
        self.assertEqual(record["scratchStatus"], "sampled_lower_bound")

    def test_a_broken_probe_cannot_change_the_pipeline_result(self) -> None:
        from stateaction_processing import hand_pose_cpu_v1 as hp

        class Hostile:
            def register_scratch(self, _p: Path) -> None:
                raise RuntimeError("no")

            def sample_now(self) -> None:
                raise RuntimeError("no")

        class FakeApi:
            def __init__(self, _context: Any) -> None: ...
            def heartbeat(self, _phase: str) -> None: ...
            def call(self, _method: str, _path: str) -> dict[str, Any]:
                return {}

        class FakeBeater:
            def __init__(self, _api: Any) -> None: ...
            def start(self) -> None: ...
            def stop(self) -> None: ...

        with (
            mock.patch.object(hp, "Api", FakeApi),
            mock.patch.object(hp, "_Beater", FakeBeater),
            mock.patch.object(hp, "ServerOutputSink", lambda *_a: None),
            mock.patch.object(hp, "_process", lambda *_a: 5),
        ):
            self.assertEqual(hp.run({}, {"metrics": Hostile()}), 5)


if __name__ == "__main__":
    unittest.main()
