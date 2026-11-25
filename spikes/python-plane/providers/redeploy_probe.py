"""One authorized Modal-only identity experiment. The apps accept no inputs."""

import asyncio
import json
import os
import signal
import sys
import traceback
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path
from urllib.parse import urlsplit

import modal
from modal.config import config
from modal.exception import NotFoundError

SPEND = Path("/home/wearaway/flora-work/SPEND-LOG.md")
RECEIPT = Path("/home/wearaway/flora-work/handoff/python-plane-modal-window.json")
ENVIRONMENT = "main"
TAG = "identity_probe"
CUTOFF = Decimal("22")
ALLOWANCE = Decimal("0.25")
CLI = Path(sys.executable).with_name("modal")


def v1() -> str:
    return "identity-probe-v1"


def v2() -> str:
    return "identity-probe-v2"


def log(message):
    timestamp = datetime.now(UTC).isoformat(timespec="seconds")
    with SPEND.open("a") as output:
        output.write(f"{timestamp} Python-plane {message}\n")


async def gross():
    proc = await asyncio.create_subprocess_exec(
        str(CLI),
        "billing",
        "summary",
        "--json",
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL,
    )
    try:
        async with asyncio.timeout(15):
            stdout, _ = await proc.communicate()
    except BaseException:
        if proc.returncode is None:
            proc.kill()
        await proc.wait()
        raise
    if proc.returncode:
        raise RuntimeError("gross meter failed")
    value = Decimal(str(json.loads(stdout)["metered_cost"]))
    if not value.is_finite() or value < 0:
        raise RuntimeError("gross meter returned an invalid value")
    return value


async def deploy(client, name, revision, same_name):
    app = modal.App(name, include_source=False)
    image = modal.Image.debian_slim(python_version="3.12").env(
        {"STATEACTION_SPIKE_REVISION": str(revision)}
    )
    app.function(
        name=TAG,
        image=image,
        serialized=True,
        cpu=(0.5, 0.5),
        memory=(256, 256),
        gpu=None,
        min_containers=0,
        max_containers=1,
        buffer_containers=0,
        scaledown_window=5,
        retries=0,
        timeout=60,
        startup_timeout=60,
        single_use_containers=True,
    )(v1 if revision == 1 else v2)
    await app.deploy.aio(environment_name=ENVIRONMENT, client=client)
    found = modal.Function.from_name(
        name, TAG, environment_name=ENVIRONMENT, client=client
    )
    await found.hydrate.aio()
    info = await found.info.aio()
    app_info = await (await modal.App.lookup.aio(app.app_id, client=client)).info.aio()
    if (
        app_info.functions.get(TAG) != found.object_id
        or info.gpus
        or info.secrets
        or info.volumes
        or not info.image_info.image_id
    ):
        raise RuntimeError("deployed identity or CPU-only attachment check failed")
    return {
        "name": name,
        "appId": app.app_id,
        "functionId": found.object_id,
        "imageId": info.image_info.image_id,
        "version": app_info.lifecycle.version,
        "revision": revision,
        "sameName": same_name,
    }


async def restore(client, name, exact_app_id):
    try:
        app = await modal.App.lookup.aio(
            exact_app_id or name, environment_name=ENVIRONMENT, client=client
        )
    except NotFoundError:
        if exact_app_id is not None:
            raise
        return {"name": name, "active": False, "lookup": "not_found"}

    exact_app_id = app.app_id
    if (await app.info.aio()).lifecycle.state.name not in ("STOPPING", "STOPPED"):
        await app.stop.aio(client=client)
    for _ in range(30):
        exact = await modal.App.lookup.aio(exact_app_id, client=client)
        if (await exact.info.aio()).lifecycle.state.name == "STOPPED":
            try:
                await modal.App.lookup.aio(
                    name, environment_name=ENVIRONMENT, client=client
                )
            except NotFoundError:
                fn = modal.Function.from_name(
                    name, TAG, environment_name=ENVIRONMENT, client=client
                )
                try:
                    await fn.hydrate.aio()
                except NotFoundError:
                    return {
                        "name": name,
                        "appId": exact_app_id,
                        "state": "STOPPED",
                        "active": False,
                        "lookup": "not_found",
                    }
        await asyncio.sleep(2)
    raise RuntimeError("stop or removal could not be verified")


async def main():
    urls = [urlsplit(part) for part in config["server_url"].split(",")]
    if any(
        url.scheme != "https"
        or url.hostname not in {"api.modal.com", "api.modal2.com"}
        or url.username
        for url in urls
    ):
        raise RuntimeError("expected the official Modal control plane")
    observed = await gross()
    original = RECEIPT.with_name("python-plane-modal-window-preflight.json")
    baseline = (
        Decimal(json.loads(original.read_text())["baselineGrossUsd"])
        if original.exists()
        else observed
    )
    if (
        observed >= CUTOFF
        or observed - baseline > ALLOWANCE
        or baseline + ALLOWANCE >= CUTOFF
    ):
        raise RuntimeError("missing gross headroom")
    if RECEIPT.exists():
        raise RuntimeError("this authorized window already has a receipt")
    nonce = os.urandom(5).hex()
    names = [f"zz-spike-{nonce}-a", f"zz-spike-{nonce}-b"]
    client = await modal.Client.from_env.aio()
    for name in names:
        try:
            await modal.App.lookup.aio(
                name, environment_name=ENVIRONMENT, client=client
            )
        except NotFoundError:
            continue
        raise RuntimeError("spike name collision")
    log(
        f"HOSTED WINDOW START, Modal-only identity probe, gross USD {baseline}, cap USD {ALLOWANCE}, zero GPU, no inputs."
    )
    receipt = {
        "baselineGrossUsd": str(baseline),
        "names": names,
        "deployments": [],
        "restoration": [],
    }

    def persist():
        temp = RECEIPT.with_suffix(".tmp")
        temp.write_text(json.dumps(receipt, indent=2) + "\n")
        temp.replace(RECEIPT)

    async def checked_gross():
        observed = await gross()
        if observed >= CUTOFF or observed - baseline > ALLOWANCE:
            raise RuntimeError("gross cut-off exceeded")
        return observed

    async def monitor():
        while True:
            await asyncio.sleep(10)
            await checked_gross()

    async def run_deploys():
        for name, rev, same in [
            (names[0], 1, False),
            (names[0], 2, True),
            (names[1], 2, False),
        ]:
            await checked_gross()
            async with asyncio.timeout(105):
                observation = await deploy(client, name, rev, same)
            receipt["deployments"].append(observation)
            persist()
            await checked_gross()

    loop = asyncio.get_running_loop()
    task = asyncio.create_task(run_deploys())
    loop.add_signal_handler(signal.SIGTERM, task.cancel)
    watcher = asyncio.create_task(monitor())
    try:
        done, _ = await asyncio.wait(
            [task, watcher], return_when=asyncio.FIRST_COMPLETED
        )
        for item in done:
            item.result()
    except BaseException as error:
        receipt["error"] = type(error).__name__
        receipt["frames"] = [
            f"{Path(f.filename).name}:{f.lineno}:{f.name}"
            for f in traceback.extract_tb(error.__traceback__)[-6:]
        ]
        known_reasons = (
            "startup_timeout",
            "timeout",
            "cpu",
            "memory",
            "permission",
            "profile",
            "deploy",
            "image",
            "serialized",
            "invalid environment",
            "deprecated",
        )
        receipt["errorKeywords"] = [
            word for word in known_reasons if word in str(error).lower()
        ]
        if isinstance(error, RuntimeError) and str(error) == "gross cut-off exceeded":
            receipt["error"] = "gross_cutoff"
    finally:
        for item in [task, watcher]:
            item.cancel()
        await asyncio.gather(task, watcher, return_exceptions=True)
        known = {row["name"]: row["appId"] for row in receipt["deployments"]}

        async def stop_owned(name):
            try:
                async with asyncio.timeout(75):
                    return await restore(client, name, known.get(name))
            except Exception as error:
                return {"name": name, "error": type(error).__name__}

        receipt["restoration"] = await asyncio.gather(
            *(stop_owned(name) for name in names)
        )
        try:
            final = await gross()
            receipt.update(finalGrossUsd=str(final), deltaUsd=str(final - baseline))
            if final >= CUTOFF or final - baseline > ALLOWANCE:
                receipt["error"] = "gross_cutoff"
        except Exception as error:
            receipt["meterError"] = type(error).__name__
        persist()
        active = any(row.get("active") is not False for row in receipt["restoration"])
        final_value = receipt.get("finalGrossUsd", "unavailable")
        log(
            f"HOSTED WINDOW END, Modal-only identity probe, gross USD {baseline} to {final_value}, zero GPU, no invocations, active app uncertainty {active}."
        )
        print(json.dumps(receipt, indent=2))
    return int(
        active
        or "error" in receipt
        or "meterError" in receipt
        or len(receipt["deployments"]) != 3
    )


if __name__ == "__main__":
    if sys.argv[1:] != ["--authorized-modal-only"]:
        sys.exit("This script requires an authorized Modal-only window")
    try:
        sys.exit(asyncio.run(main()))
    except Exception as exc:
        sys.exit(f"Modal preflight failed ({type(exc).__name__})")
