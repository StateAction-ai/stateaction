import asyncio
import json
import tarfile

import pytest
from stateaction_controller.diagnostics import collect, scrub_text, write_bundle
from stateaction_controller.journal import JournalStore
from stateaction_controller.replay import replay
from test_recipe import FIXTURES, JOB

TOKEN = "sa_svc_" + "FAKE" * 11
FILE = "00000000-0000-4000-8000-000000000200"


class Api:
    async def status(self, job):
        return {"jobId": job, "state": "failed"}

    async def recipe(self, job):
        fixture = json.loads((FIXTURES / "jobs.recipe.v1.json").read_bytes())
        return fixture["cases"][1]["input"]["document"]

    async def dag(self, job):
        return {"jobId": job}

    async def prior_stages(self, job):
        return {
            "stages": [
                {
                    "stage": "segment",
                    "outputs": [
                        {
                            "fileId": FILE,
                            "role": "diagnostic_blob",
                            "slot": "diagnostics/segment/log.txt",
                            "sizeBytes": "30",
                        }
                    ],
                }
            ]
        }


def test_diagnostic_archive_redacts_journal_log_and_cached_blob(tmp_path):
    store = JournalStore(tmp_path / "state")
    store._write(
        JOB, "segment", "journal.json", json.dumps({"bootstrapToken": TOKEN}).encode()
    )
    store._write(
        JOB, "segment", "child.log", f"Authorization: Bearer {TOKEN}\n".encode()
    )
    root = tmp_path / "cache"
    blob = root / JOB / "outputs/diagnostics/segment/log.txt"
    blob.parent.mkdir(parents=True)
    blob.write_text(
        f"ok line\nbootstrapToken={TOKEN}\nhttps://s3.test/k?X-Amz-Signature=abc123\n"
    )
    entries = asyncio.run(collect(Api(), store, JOB, root))
    path = tmp_path / "bundle.tgz"
    result = write_bundle(entries, path)
    assert 0 < result["bytes"] < 8 * 1024 * 1024
    with tarfile.open(path) as archive:
        assert "job-status.json" in archive.getnames()
        contents = b"".join(
            archive.extractfile(name).read() for name in archive.getnames()
        )
    for bad in (TOKEN, "abc123"):
        assert bad.encode() not in contents
    assert b'"unreadable": true' in contents
    assert b"ok line" in contents
    assert b"[redacted]" in contents


@pytest.mark.parametrize(
    "pattern",
    [
        "bootstrapToken={}",
        'clientSecret":"{}"',
        "S3_SECRET_ACCESS_KEY={}",
        "api_key: {}",
        "AWS_ACCESS_KEY_ID={}",
        "Authorization: Basic {}",
        "db_password='{}'",
        "sessionCookie={}",
    ],
)
def test_unprefixed_secrets_are_redacted(pattern):
    out = scrub_text("pre " + pattern.format("Zx9Qw7Lm") + " post")
    assert "Zx9Qw7Lm" not in out
    assert "[redacted]" in out
    assert scrub_text("window 3 captions ok") == "window 3 captions ok"


def test_scrub_removes_capabilities_bearer_password_and_signed_url():
    contents = scrub_text(
        f"a {TOKEN} Bearer abc.def password: hunter2 https://h/x?token=zzz"
    )
    assert all(bad not in contents for bad in (TOKEN, "abc.def", "hunter2", "zzz"))


@pytest.fixture
def cached(tmp_path):
    root = tmp_path / "cache"
    job = root / JOB
    (job / "outputs").mkdir(parents=True)
    (job / "source.mcap").write_bytes(b"synthetic")
    (job / "task-input.json").write_text(json.dumps({"schemaVersion": 3, "jobId": JOB}))
    return root


def test_replay_local_caption_copies_exact_segments_and_reports_failure(
    tmp_path, cached
):
    segments = cached / JOB / "outputs/segments.json"
    segments.write_bytes(b"{}")
    io = tmp_path / "caption"

    async def run(argv, env):
        assert argv[-3:] == ["run-stage", "--io-dir", str(io)]
        assert env["APP_ENV"] == "local"
        (io / "receipt.json").write_text('{"status":"failed","errorCode":"fixture"}')
        return 3

    result = asyncio.run(
        replay(
            Api(),
            JOB,
            "caption",
            io,
            cached,
            "python",
            module="stub_captioner",
            run=run,
        )
    )
    assert result == {
        "module": "stub_captioner@1",
        "exitCode": 3,
        "receipt": {"status": "failed", "errorCode": "fixture"},
    }
    boot = json.loads((io / "bootstrap.json").read_bytes())
    assert boot["stage"] == "caption" and len(boot["segmentsSha256"]) == 64
    assert boot["taskInput"]["recipe"]["stages"][1]["params"]["fail_captions"] == "1"
    assert (io / "segments.json").read_bytes() == b"{}"


def test_flora_is_refused_and_local_segment_needs_no_segments_file(tmp_path, cached):
    async def run(_argv, _env):
        return 0

    for allow in (False, True):
        with pytest.raises(ValueError, match="Modal harness"):
            asyncio.run(
                replay(
                    Api(),
                    JOB,
                    "segment",
                    tmp_path / "paid",
                    cached,
                    "python",
                    module="flora_tempseg_vllm_fp8@1",
                    allow_spend=allow,
                    run=run,
                )
            )
    io = tmp_path / "segment"
    assert (
        asyncio.run(replay(Api(), JOB, "segment", io, cached, "python", run=run))[
            "exitCode"
        ]
        == 0
    )
    assert not (io / "segments.json").exists()
