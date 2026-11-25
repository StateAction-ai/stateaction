"""Provider definition and billing checks through the pinned Modal control-plane stub."""

import asyncio
import base64
import hashlib
import math
import re
from dataclasses import dataclass
from importlib.metadata import version
from urllib.parse import urlsplit

import aiohttp
from modal_proto import api_pb2 as wire
from stateaction_contracts import request_sha256

SDK_VERSION = "1.6.4"
PROTO_DESCRIPTOR_SHA256 = (
    "d6be35f6fe733666b203c1b6189f66980c6585016ac0f266c513509504e4bac2"
)
DIGEST_FORMAT = "modal-proto-binding-v1"
MAX_MANIFEST_BYTES = 64 * 1024
FUNCTION_TYPE = 2
FILE_DEFINITION = 2

ALTERNATES = (
    "is_class",
    "is_method",
    "is_server",
    "is_sessioned",
    "web_url",
    "custom_domain_info",
    "method_definitions",
    "routing_region",
    "flash_service_label",
    "flash_service_urls",
    "worker_id",
    "_experimental_group_size",
    "_experimental_fabric_size",
    "_experimental_custom_scaling",
    "_experimental_enable_gpu_snapshot",
    "experimental_options",
)
VARIANT_FEATURES = (
    "cloud_provider",
    "cloud_provider_str",
    "proxy_id",
    "i6pn_enabled",
    "_experimental_task_templates_enabled",
    "_experimental_task_templates",
    "is_builder_function",
    "is_auto_snapshot",
    "is_checkpointing_function",
    "checkpointing_enabled",
    "enable_gpu_snapshot",
    "batch_max_size",
    "batch_linger_ms",
    "function_serialized",
    "class_serialized",
)


class DefinitionRejected(ValueError):
    """The reason is a fixed check label, safe for an operator receipt."""


class ModalProtocolChanged(RuntimeError):
    """The trusted Python SDK and exact wire descriptor must be reviewed together."""


@dataclass(frozen=True)
class Bounds:
    app_name: str
    environment: str
    object_tag: str
    module: str
    gpu: str
    max_containers: int
    max_cpu_milli: int
    max_memory_mib: int
    max_billed_seconds: int
    micro_usd_per_cpu_second: int
    micro_usd_per_gpu_second: int


@dataclass(frozen=True)
class Inspection:
    function_id: str
    definition_id: str
    definition_sha256: str
    image_id: str
    cpu_milli: int
    memory_mib: int
    billed_seconds: int


def require(condition, check):
    if not condition:
        raise DefinitionRejected(check)


def check_sdk():
    if (
        version("modal") != SDK_VERSION
        or hashlib.sha256(wire.DESCRIPTOR.serialized_pb).hexdigest()
        != PROTO_DESCRIPTOR_SHA256
    ):
        raise ModalProtocolChanged("Modal version or protobuf descriptor changed")


def immutable_app_name(module, code_revision, params_sha256):
    stage = module.split("@")[0].replace("_", "-")[:23]
    digest = request_sha256(
        {
            "module": module,
            "codeRevision": code_revision,
            "paramsSha256": params_sha256,
        }
    )
    return f"stateaction-{stage}-{digest[:24]}"


def alternates_or_bounds(fn, limit):
    scaling = fn.autoscaler_settings
    return (
        any(getattr(fn, field) for field in ALTERNATES)
        or fn.webhook_config.type
        or fn.function_type not in (0, FUNCTION_TYPE)
        or fn.concurrency_limit > limit
        or scaling.max_containers > limit
        or fn.warm_pool_size
        or fn._experimental_buffer_containers
        or scaling.min_containers
        or scaling.buffer_containers
    )


def check_outer(response, bounds):
    definition = response.function
    handle = response.handle_metadata
    require(
        response.function_id
        and handle.app_id
        and definition.module_name
        and definition.function_name == bounds.object_tag
        and len(definition.ranked_functions) == 1,
        "function_identity",
    )
    require(
        not (
            alternates_or_bounds(definition, bounds.max_containers)
            or definition.schedule.HasField("cron")
            or definition.schedule.HasField("period")
            or definition.http_config.port
            or definition.http_config.proxy_regions
            or definition.http_config.HasField("lift_and_shift_config")
            or handle.web_url
            or handle.is_method
            or handle.use_method_name
            or handle._experimental_flash_urls
            or handle.method_handle_metadata
            or handle.function_type not in (0, FUNCTION_TYPE)
            or (handle.function_name and handle.function_name != bounds.object_tag)
            or (
                handle.base_function_id
                and handle.base_function_id != response.function_id
            )
        ),
        "execution_handle",
    )


def check_variant(definition, bounds):
    rank = definition.ranked_functions[0]
    variant = getattr(rank, "function")
    placement = variant.scheduler_placement
    cpu_only = bounds.gpu.upper() == "NONE"
    require(
        rank.rank == 0
        and rank.HasField("function")
        and variant.HasField("resources")
        and variant.app_name == bounds.app_name
        and variant.image_id
        and variant.timeout_secs
        and variant.function_name in ("", bounds.object_tag)
        and variant.definition_type in (0, FILE_DEFINITION),
        "variant_identity",
    )
    require(
        (
            placement.nonpreemptible
            if cpu_only
            else not variant.HasField("scheduler_placement")
        )
        and not (
            placement.regions
            or placement._instance_types
            or placement._zone
            or placement._lifecycle
        )
        and not variant.HasField("pty_info")
        and not variant.HasField("checkpoint")
        and not any(getattr(variant, field) for field in VARIANT_FEATURES)
        and max(
            variant.max_concurrent_inputs,
            variant.target_concurrent_inputs,
            variant.max_inputs,
        )
        <= 1
        and variant.retry_policy.retries == 0
        and not alternates_or_bounds(variant, bounds.max_containers),
        "variant_execution",
    )
    return variant


def check_resources(resources, bounds):
    gpu = bounds.gpu.upper()
    gpu_config = resources.gpu_config
    disk = resources.ephemeral_disk_mb
    cpu = max(resources.milli_cpu, resources.milli_cpu_max)
    memory = max(resources.memory_mb, resources.memory_mb_max, (disk + 19) // 20)
    require(
        resources.milli_cpu_max > 0
        and resources.memory_mb_max > 0
        and 0 < cpu <= bounds.max_cpu_milli
        and 0 < memory <= bounds.max_memory_mib
        and disk >= 0
        and not resources.rdma
        and not gpu_config.type,
        "cpu_memory_disk",
    )
    if gpu == "NONE":
        require(
            not gpu_config.count
            and not gpu_config.gpu_type
            and not bounds.micro_usd_per_gpu_second,
            "gpu_resources",
        )
    else:
        require(
            gpu == "RTX-PRO-6000"
            and gpu_config.count == 1
            and gpu_config.gpu_type.upper() == gpu
            and bounds.micro_usd_per_gpu_second >= 842,
            "gpu_resources",
        )
    # Same list-rate constants as the current TS policy, in micro USD per second.
    rate = cpu / 1000 * 13.1 + memory / 1024 * 2.22
    require(
        bounds.micro_usd_per_cpu_second
        >= math.ceil(rate * (3 if gpu == "NONE" else 1)),
        "cpu_rate",
    )
    return cpu, memory


def check_scheduling(autoscaler, definition, variant, bounds):
    settings = autoscaler.settings
    require(
        settings.HasField("max_containers")
        and 0 < settings.max_containers <= bounds.max_containers
        and not settings.min_containers
        and not settings.buffer_containers
        and settings.HasField("scaledown_window")
        and settings.scaledown_window >= 0
        and not autoscaler.override_settings.ListFields()
        and not autoscaler.override_events,
        "effective_autoscaler",
    )
    timeout = max(definition.timeout_secs, variant.timeout_secs)
    startup = (
        max(definition.startup_timeout_secs, variant.startup_timeout_secs) or timeout
    )
    idle = max(
        settings.scaledown_window,
        definition.task_idle_timeout_secs,
        variant.task_idle_timeout_secs,
        definition.autoscaler_settings.scaledown_window,
        variant.autoscaler_settings.scaledown_window,
    )
    total = timeout + startup + idle + 60
    require(total <= bounds.max_billed_seconds, "billed_wall")
    return total


async def read_manifest(url, size):
    async with aiohttp.ClientSession(
        timeout=aiohttp.ClientTimeout(total=3),
        trust_env=False,
        auto_decompress=False,
    ) as session:
        async with session.get(url, allow_redirects=False) as response:
            require(response.status == 200, "volume_http_status")
            content = await response.content.readexactly(size)
            require(not await response.content.read(1), "volume_manifest_size")
            return content


async def inspect_volumes(stub, variant, bounds, pins, reader):
    match = re.fullmatch(r"flora_(captioner|tempseg)_(?:vllm_fp8|hf)@1", bounds.module)
    if not match:
        require(not variant.volume_mounts, "unexpected_volume")
        return []
    require(len(variant.volume_mounts) == 1, "volume_mount")
    mount = variant.volume_mounts[0]
    require(
        re.fullmatch(r"vo-[A-Za-z0-9]+", mount.volume_id)
        and mount.mount_path == "/models"
        and mount.read_only
        and not mount.sub_path,
        "volume_mount",
    )
    checkpoint = pins["checkpoints"][match[1]]
    listing = await stub.VolumeList(
        wire.VolumeListRequest(environment_name=bounds.environment)
    )
    found = next(
        (item for item in listing.items if item.volume_id == mount.volume_id), None
    )
    require(
        listing.environment_name in ("", bounds.environment)
        and found is not None
        and found.metadata.name == pins["volumeName"]
        and found.metadata.version == pins["volumeVersion"],
        "volume_identity",
    )
    path = f"flora/{checkpoint['checkpointId']}/MANIFEST.json"
    descriptor = await stub.VolumeGetFile2(
        wire.VolumeGetFile2Request(volume_id=mount.volume_id, path=path)
    )
    require(
        0 < descriptor.size <= MAX_MANIFEST_BYTES
        and descriptor.start == 0
        and descriptor.len == descriptor.size
        and len(descriptor.get_urls) == 1,
        "volume_descriptor",
    )
    url = urlsplit(descriptor.get_urls[0])
    require(
        url.scheme == "https"
        and url.hostname
        and not url.username
        and not url.password,
        "volume_url",
    )
    content = await reader(descriptor.get_urls[0], descriptor.size)
    require(
        len(content) == descriptor.size
        and hashlib.sha256(content).hexdigest() == checkpoint["manifestSha256"],
        "volume_digest",
    )
    return [
        {
            "volumeId": mount.volume_id,
            "name": found.metadata.name,
            "environment": bounds.environment,
            "version": found.metadata.version,
            "mountPath": mount.mount_path,
            "subPath": mount.sub_path,
            "readOnly": mount.read_only,
            "allowBackgroundCommits": mount.allow_background_commits,
            "manifestPath": path,
            "manifestSha256": checkpoint["manifestSha256"],
            "modelRevision": checkpoint["modelRevision"],
        }
    ]


def wire_b64(message):
    return base64.b64encode(message.SerializeToString(deterministic=True)).decode(
        "ascii"
    )


async def inspect(
    client, bounds, pins, *, reader=read_manifest, timeout=5.0, observer=None
):
    check_sdk()
    async with asyncio.timeout(timeout):
        stub = client.stub
        response = await stub.FunctionGet(
            wire.FunctionGetRequest(
                app_name=bounds.app_name,
                object_tag=bounds.object_tag,
                environment_name=bounds.environment,
                app_version=0,
            )
        )
        if observer is not None:
            observer("FunctionGet", response)
        check_outer(response, bounds)
        definition = response.function
        variant = check_variant(definition, bounds)
        cpu, memory = check_resources(variant.resources, bounds)
        response2 = await stub.FunctionGetSchedulingParams(
            wire.FunctionGetSchedulingParamsRequest(function_id=response.function_id)
        )
        if observer is not None:
            observer("FunctionGetSchedulingParams", response2)
        autoscaler = response2.autoscaler_configuration
        billed_seconds = check_scheduling(autoscaler, definition, variant, bounds)
        handle = response.handle_metadata
        require(
            (handle.definition_id or not variant.secret_ids)
            and not (
                variant.shared_volume_mounts
                or variant.cloud_bucket_mounts
                or variant.s3_mounts
            ),
            "attachment_closure",
        )
        volumes = await inspect_volumes(stub, variant, bounds, pins, reader)
        stable_handle = wire.FunctionHandleMetadata()
        stable_handle.CopyFrom(handle)
        stable_handle.ClearField("input_plane_url")
        stable_handle.ClearField("input_plane_region")
        digest = request_sha256(
            {
                "format": DIGEST_FORMAT,
                "appName": bounds.app_name,
                "appId": handle.app_id,
                "environment": bounds.environment,
                "objectTag": bounds.object_tag,
                "functionId": response.function_id,
                "definition": wire_b64(definition),
                "handle": wire_b64(stable_handle),
                "autoscaler": wire_b64(autoscaler),
                "volumeMounts": volumes,
            }
        )
        return Inspection(
            response.function_id,
            handle.definition_id or f"definition-sha256-{digest}",
            digest,
            variant.image_id,
            cpu,
            memory,
            billed_seconds,
        )


async def verify_binding(
    client,
    bounds,
    pins,
    *,
    code_revision,
    params_sha256,
    function_id,
    definition_id,
    definition_sha256,
    reader=read_manifest,
    timeout=5.0,
):
    require(
        bounds.app_name
        == immutable_app_name(bounds.module, code_revision, params_sha256),
        "immutable_app_name",
    )
    verified = await inspect(client, bounds, pins, reader=reader, timeout=timeout)
    require(
        (verified.function_id, verified.definition_id, verified.definition_sha256)
        == (function_id, definition_id, definition_sha256),
        "bound_deployment_drift",
    )
    return verified


async def probe_gpu_watch(client, function_id, call_id=None, *, timeout=5.0):
    """Same exact-call container-ID observation as the TS watchdog, without call-graph inference."""
    check_sdk()
    async with asyncio.timeout(timeout):
        reply = await client.stub.FunctionCallFetch(
            wire.FunctionCallFetchRequest(
                function_id=function_id,
                all_variants=True,
                tail=wire.FunctionCallFetchRequest.Tail(count=10),
            )
        )
    return [
        item.container_id
        for item in reply.function_call_inputs
        if call_id is not None
        and item.function_call_id == call_id
        and item.container_id
    ]
