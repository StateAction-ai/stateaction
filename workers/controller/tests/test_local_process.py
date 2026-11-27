import asyncio
from dataclasses import replace

import pytest
from stateaction_controller.local_process import Process, boot_id, inspect


@pytest.fixture
def recorded():
    return {
        "bootId": boot_id(),
        "pid": 1000,
        "pgid": 1000,
        "sid": 1000,
        "startTicks": "10",
        "executionRef": "local-test",
        "singleProcess": True,
    }


LIVE = Process("S", 1, 1000, 1000, "10")
ZOMBIE = replace(LIVE, state="Z")
REUSED = replace(LIVE, ticks="11")


async def no_sleep(_):
    pass


@pytest.mark.parametrize("exited", [None, ZOMBIE], ids=["missing", "zombie"])
def test_unreadable_command_then_exited(recorded, exited):
    stats = iter([LIVE, exited])
    assert (
        asyncio.run(
            inspect(recorded, read=lambda _: next(stats), command=lambda *_: False)
        )
        == "gone"
    )


def test_identity_becomes_readable_again(recorded):
    commands = iter([False, True])
    assert (
        asyncio.run(
            inspect(recorded, read=lambda _: LIVE, command=lambda *_: next(commands))
        )
        == "alive"
    )


def test_unreadable_command_rechecks_are_bounded(recorded):
    reads = []

    def read(pid):
        reads.append(pid)
        return LIVE

    assert (
        asyncio.run(
            inspect(recorded, read=read, command=lambda *_: False, sleep=no_sleep)
        )
        == "leader_identity_unconfirmed"
    )
    assert reads == [recorded["pid"]] * 12


def test_changed_identity_during_recheck_is_not_gone(recorded):
    stats = iter([LIVE, REUSED])
    assert (
        asyncio.run(
            inspect(recorded, read=lambda _: next(stats), command=lambda *_: False)
        )
        == "leader_identity_changed"
    )


def test_unavailable_proc_during_recheck_is_not_gone(recorded):
    first = True

    def read(_):
        nonlocal first
        if first:
            first = False
            return LIVE
        raise OSError()

    assert (
        asyncio.run(inspect(recorded, read=read, command=lambda *_: False))
        == "proc_unavailable"
    )


def test_miss_without_isolation_is_not_gone(recorded):
    del recorded["singleProcess"]
    assert (
        asyncio.run(inspect(recorded, read=lambda _: None))
        == "execution_isolation_unproven"
    )


def test_live_matching_command_needs_one_read(recorded):
    stats = iter([LIVE])
    assert (
        asyncio.run(
            inspect(recorded, read=lambda _: next(stats), command=lambda *_: True)
        )
        == "alive"
    )
