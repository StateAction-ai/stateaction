"""Streaming `h264_mcap_v1` capture reader (SA-29): contract rules + bounded frame join.

Layers: `mcap_stream.McapStream` (container, hashing) -> this module (contract rules, join) ->
`h264_decode` (one persistent decoder). Nothing here holds the whole session: state is O(in-flight
frames + join window), all bounded by `StreamLimits`.

PROVISIONAL RULE: access units are yielded as soon as their identity is joined, but the capture is
accepted only after the iterator is exhausted without error (footer, data CRC, summary, full
SHA-256 and the contract Close counts verified). A consumer may process provisionally with bounded
temporary artifacts. Publication also requires `report.auto_admissible`.

Unsupported on purpose (explicit error, nothing is repaired or re-timed):
legacy `jpeg_mcap_v1`, compressed MCAP chunks, flat/unchunked layouts, non-increasing source frame
ids or encoder PTS, duplicate/unknown frame lifecycles, B-frames/partial/multi-AU messages, missing
SPS/PPS on IDR, first AU not IDR, joins/sensor associations outside the bounded windows.
"""

from __future__ import annotations

import hashlib
import struct
from collections import OrderedDict, deque
from collections.abc import Iterator
from dataclasses import dataclass, field
from typing import Any, BinaryIO

from . import contract
from .capture_v12_sensors import (
    CAMERA_METADATA,
    DEPTH_EVENTS,
    SensorEvidenceError,
    V12Sensors,
)
from .mcap_stream import (
    ChannelDef,
    Limits,
    McapStream,
    McapStreamError,
    Message,
    SchemaDef,
    SourceReport,
)
from .mcap_stream import Header as McapHeader

VIDEO_TOPIC = "/camera/rgb/video"
LEGACY_JPEG_TOPIC = "/camera/rgb/image/compressed"
T_PROFILE = "/stateaction/capture_profile"
T_CLOCKS = "/stateaction/clocks"
T_INVENTORY = "/stateaction/inventory"
T_FRAMES = "/stateaction/frame_events"
T_SENSOR = "/stateaction/sensor_events"
T_CLOSE = "/stateaction/close"
T_CALIBRATIONS = "/stateaction/calibrations"
T_ACCEL, T_GYRO, T_POSE = (
    "/stateaction/imu/accel",
    "/stateaction/imu/gyro",
    "/tracking/pose",
)
# The native recorder writes Profile and Clocks first and Inventory/Close at stop; the golden
# fixtures put Inventory first. Both orders are accepted; Inventory-dependent checks run at the end.
PRE_FRAME = (T_PROFILE, T_CLOCKS)
SHARED_DECLARATIONS = (T_CLOCKS, T_INVENTORY)
WIRE_V11 = "stateaction.capture.v1.1"
WIRE_V12 = "stateaction.capture.v1.2"
MAX_CALIBRATIONS = 64


class CaptureStreamError(ValueError):
    def __init__(self, code: str, detail: object = None):
        super().__init__(code if detail is None else f"{code}: {detail}")
        self.code = code
        self.detail = detail


def _req(ok: bool, code: str, detail: object = None) -> None:
    if not ok:
        raise CaptureStreamError(code, detail)


@dataclass(frozen=True)
class StreamLimits:
    mcap: Limits = field(default_factory=Limits)
    max_pending_video: int = (
        8  # video messages waiting for `written` events or earlier joins
    )
    max_join_window_ns: int = 5_000_000_000  # log-time distance video <-> written event
    max_inflight_frames: int = 256  # acquired frames without a terminal event
    sensor_hold_videos: int = (
        2  # later video messages a joined AU waits for sensor evidence
    )
    max_pending_sensor_events: int = 64  # events naming a not-yet-acquired frame
    max_sensor_events_per_frame: int = 16
    max_drop_reasons: int = 64
    max_access_unit_bytes: int = 16 * 1024 * 1024
    max_raster_side: int = 16384  # contract maximum
    max_pixels: int = 3840 * 2160
    max_frames: int = 10_000_000


@dataclass(frozen=True)
class AccessUnit:
    """One accepted, joined, complete Annex B access unit with its original identities."""

    index: int  # video message ordinal (decode order)
    sequence: int  # MCAP video channel sequence == FrameEvent.output_sequence
    source_frame_id: str  # original acquisition id, never renumbered
    encoder_pts_us: int  # original encoder PTS, time base 1/1_000_000
    capture_time_ns: str  # mapped capture time (derived evidence)
    log_time_ns: str
    native_clock_id: str
    native_timestamp_ns: str
    native_timestamps: dict[str, Any]
    calibration_id: str
    clock_mapping_revision: str
    stream_id: str
    frame_id: str  # optical coordinate frame name, NOT an image id
    is_idr: bool
    sha256: str
    data: bytes
    sensor_events: tuple[dict[str, Any], ...] = ()
    calibration_raster: tuple[int, int] | None = None


@dataclass
class CaptureReport:
    source: SourceReport
    recording_id: str | None = None
    profile: dict[str, Any] | None = None
    close: dict[str, Any] | None = None
    wire_contract_revision: str | None = None
    native_evidence_counts: dict[str, int] = field(default_factory=dict)
    rgb_only: bool = False
    excluded_messages_by_domain: dict[str, int] = field(default_factory=dict)
    frame_counts: dict[str, int] = field(
        default_factory=lambda: {
            "acquired": 0,
            "submitted": 0,
            "written": 0,
            "dropped": 0,
        }
    )
    video_messages: int = 0
    motion_events: dict[str, int] = field(
        default_factory=lambda: {"accel": 0, "gyro": 0}
    )
    sensor_events: int = 0
    pose_messages: int = 0
    unassociated_sensor_events: int = 0
    sensor_events_for_dropped_frames: int = 0
    sensor_events_unmatched: int = (
        0  # name a frame id that never appeared (contract-legal)
    )
    unresolved_frames: int = 0
    peak_pending_video: int = 0
    peak_inflight_frames: int = 0
    peak_held_access_units: int = 0
    accepted: bool = False

    @property
    def auto_admissible(self) -> bool:
        return self.accepted and (
            self.rgb_only
            or (self.close is not None and self.close["outcome"] == "completed")
        )

    def require_auto_admissible(self) -> None:
        _req(self.accepted, "E_NOT_ACCEPTED")
        _req(
            self.auto_admissible,
            "E_OUTCOME_NOT_ADMISSIBLE",
            (self.close or {}).get("outcome"),
        )


class _Joined:
    """Mutable record for one video message waiting for join / sensor evidence."""

    __slots__ = ("au", "log_time", "released_after", "sensors")

    def __init__(self, au: AccessUnit, log_time: int):
        self.au, self.log_time = au, log_time
        self.sensors: list[dict[str, Any]] = []
        self.released_after = 0


class CaptureStream:
    """Iterate accepted-so-far `AccessUnit`s; `report.accepted` only after clean exhaustion."""

    def __init__(
        self,
        raw: BinaryIO,
        limits: StreamLimits | None = None,
        *,
        expected_profile: str | None = None,
    ):
        self.limits = limits or StreamLimits()
        self._expected_profile = expected_profile
        self._mcap = McapStream(raw, self.limits.mcap)
        self.report = CaptureReport(self._mcap.report)
        self._ref = contract.reference()
        self._schema_mod = contract.strict_schema()

    @property
    def accepted(self) -> bool:
        return self.report.accepted

    def __iter__(self) -> Iterator[AccessUnit]:
        try:
            yield from self._run()
        except (McapStreamError, SensorEvidenceError) as e:
            raise CaptureStreamError(e.code, e.detail) from None

    # ------------------------------------------------------------------------------------
    def _run(self) -> Iterator[AccessUnit]:
        ref, lim, rep = self._ref, self.limits, self.report
        schemas: dict[int, SchemaDef] = {}
        channels: dict[int, ChannelDef] = {}
        topics: dict[str, tuple[str, str, str]] = {}
        schema_hashes: dict[str, Any] = {}
        optional: V12Sensors | None = None
        seen_pre: set[str] = set()
        early_declarations: dict[str, bytes] = {}
        clocks: dict[str, Any] = {}
        inventory: dict[str, Any] = {}
        last_id_by_cal: dict[str, int] = {}
        calibration_revisions: dict[str, dict[str, Any]] = {}
        profile_limits: dict[str, Any] = {}
        closed = False
        # frame lifecycle (bounded): in-flight frames only, plus a short terminal memory
        inflight: dict[str, dict[str, Any]] = {}
        inflight_state: dict[str, str] = {}
        submitted: set[str] = set()
        recent_terminal: OrderedDict[str, str] = OrderedDict()
        last_acquired_id = -1
        reset_at: dict[str, int] = {}
        last_pts = -1
        drop_reasons: dict[str, int] = {}
        # video join
        pending_video: deque[_Joined] = deque()  # arrival order
        pending_by_seq: dict[int, _Joined] = {}
        early_written: dict[
            int, tuple[dict[str, Any], int]
        ] = {}  # written before the video
        held: deque[_Joined] = (
            deque()
        )  # joined, waiting for sensor evidence / release order
        held_by_id: dict[str, _Joined] = {}
        pending_sensor: dict[str, list[dict[str, Any]]] = {}
        last_video_seq = -1
        last_video_log = -1
        n_video = 0
        video_index = 0
        released_ids: OrderedDict[str, None] = OrderedDict()
        recording_ids: set[str] = set()
        profile_seen_header = False

        def add_recording(v: dict[str, Any]) -> None:
            recording_ids.add(v["recording_id"])
            _req(len(recording_ids) == 1, "E_RECORDING_ID", sorted(recording_ids))
            rep.recording_id = v["recording_id"]

        def add_declaration(topic: str, value: dict[str, Any]) -> None:
            nonlocal clocks, inventory
            _req(topic not in seen_pre, "E_CHANNEL_CARDINALITY", topic)
            if topic == T_CLOCKS:
                clocks = value
            else:
                inventory = value
            seen_pre.add(topic)

        def release_ready(final: bool) -> Iterator[AccessUnit]:
            # Release in video order once joined and the sensor-hold window elapsed.
            while held:
                head = held[0]
                if not final and n_video - head.released_after < lim.sensor_hold_videos:
                    break
                held.popleft()
                held_by_id.pop(head.au.source_frame_id, None)
                released_ids[head.au.source_frame_id] = None
                if len(released_ids) > 256:
                    released_ids.popitem(last=False)
                au = head.au
                if head.sensors:
                    au = AccessUnit(
                        **{**au.__dict__, "sensor_events": tuple(head.sensors)}
                    )
                yield au

        def try_join(j: _Joined, ev: dict[str, Any], ev_log: int) -> None:
            video = j.au  # holds provisional fields; rebuilt with event identity below
            _req(
                abs(ev_log - j.log_time) <= lim.max_join_window_ns,
                "E_JOIN_WINDOW",
                {"sequence": video.sequence, "limit_ns": lim.max_join_window_ns},
            )
            _req(
                ev["mapped_capture_time_ns"] == video.capture_time_ns
                and bool(ev["is_idr"]) == video.is_idr,
                "E_VIDEO_TIMESTAMP_MISMATCH",
                video.sequence,
            )
            calibration = calibration_revisions.get(ev["calibration_id"])
            joined = AccessUnit(
                **{
                    **video.__dict__,
                    "source_frame_id": ev["source_frame_id"],
                    "encoder_pts_us": int(ev["encoder_pts_us"]),
                    "native_clock_id": ev["native_clock_id"],
                    "native_timestamp_ns": ev["native_timestamp_ns"],
                    "native_timestamps": ev["native_timestamps"],
                    "calibration_id": ev["calibration_id"],
                    "calibration_raster": (
                        calibration["saved_width"],
                        calibration["saved_height"],
                    )
                    if calibration is not None
                    else None,
                    "clock_mapping_revision": ev["clock_mapping_revision"],
                    "stream_id": ev["stream_id"],
                }
            )
            j.au = joined
            j.released_after = n_video
            pending_by_seq.pop(video.sequence, None)
            held_by_id[joined.source_frame_id] = j
            sensors = pending_sensor.pop(joined.source_frame_id, [])
            j.sensors.extend(sensors)
            while pending_video and pending_video[0].au.source_frame_id:
                held.append(pending_video.popleft())
            rep.peak_held_access_units = max(rep.peak_held_access_units, len(held))

        for item in self._mcap:
            if isinstance(item, McapHeader):
                _req(item.profile == "", "E_PROFILE_NOT_EMPTY", item.profile)
                profile_seen_header = True
            elif isinstance(item, SchemaDef):
                schemas[item.id] = item
                if item.name == "sensor_msgs/msg/CompressedImage":
                    raise CaptureStreamError("E_LEGACY_JPEG_UNSUPPORTED", item.name)
                if topics:
                    self._check_schema(item, schema_hashes)
            elif isinstance(item, ChannelDef):
                channels[item.id] = item
                if item.topic == LEGACY_JPEG_TOPIC:
                    raise CaptureStreamError(
                        "E_LEGACY_JPEG_UNSUPPORTED",
                        "jpeg_mcap_v1 is an explicit legacy profile; this reader is h264_mcap_v1 only",
                    )
                if topics:
                    self._check_channel(item, schemas, topics)
                elif item.topic == T_PROFILE:
                    schema = schemas.get(item.schema_id)
                    name = schema.name if schema is not None else None
                    _req(
                        name in (ref.CHANNELS[T_PROFILE][0], ref.PROFILE_V2),
                        "E_CHANNEL_ENCODING",
                        T_PROFILE,
                    )
                    v12 = name == ref.PROFILE_V2
                    rep.wire_contract_revision = WIRE_V12 if v12 else WIRE_V11
                    topics = ref.CHANNELS12 if v12 else ref.CHANNELS
                    schema_hashes = contract.manifest(v12=v12)
                    for schema in schemas.values():
                        self._check_schema(schema, schema_hashes)
                    for channel in channels.values():
                        self._check_channel(channel, schemas, topics)
                    if v12:
                        optional = V12Sensors(ref, lim.max_pending_sensor_events)
                    for topic, payload in early_declarations.items():
                        value = self._json(topic, topics[topic][0], payload, v12)
                        add_recording(value)
                        add_declaration(topic, value)
                    early_declarations.clear()
            elif isinstance(item, Message):
                topic = channels[item.channel_id].topic
                _req(not closed, "E_ORDER", "message after Close")
                _req(profile_seen_header, "E_ORDER")
                if not topics:
                    _req(
                        topic in SHARED_DECLARATIONS,
                        "E_ORDER",
                        "message before Profile channel",
                    )
                    _req(
                        topic not in early_declarations, "E_CHANNEL_CARDINALITY", topic
                    )
                    early_declarations[topic] = item.data
                    continue
                _req(
                    topic in PRE_FRAME
                    or topic == T_INVENTORY
                    or all(t in seen_pre for t in PRE_FRAME),
                    "E_ORDER",
                    f"{topic} before Profile/Clocks",
                )
                if topic == VIDEO_TOPIC:
                    rep.video_messages += 1
                    n_video += 1
                    _req(n_video <= lim.max_frames, "E_FRAME_LIMIT", lim.max_frames)
                    _req(
                        item.sequence > last_video_seq,
                        "E_ORDER_UNSUPPORTED",
                        "video sequence",
                    )
                    _req(
                        item.log_time >= last_video_log,
                        "E_ORDER_UNSUPPORTED",
                        "video log_time",
                    )
                    last_video_seq, last_video_log = item.sequence, item.log_time
                    try:
                        v = ref.decode_video(item.data)
                    except (ValueError, IndexError, struct.error, UnicodeDecodeError):
                        raise CaptureStreamError(
                            "E_MALFORMED_MESSAGE", VIDEO_TOPIC
                        ) from None
                    _req(
                        len(v["data"]) <= lim.max_access_unit_bytes
                        and len(v["data"])
                        <= profile_limits.get("access_unit_bytes", 2**62),
                        "E_ACCESS_UNIT_BOUND",
                        len(v["data"]),
                    )
                    _req(
                        v["frame_id"] == ref.FRAME_ID and v["format"] == "h264",
                        "E_VIDEO_FIELDS",
                    )
                    au_errors, idr = ref.classify_au(v["data"])
                    _req(
                        not au_errors,
                        "E_ACCESS_UNIT",
                        {"index": video_index, "errors": au_errors},
                    )
                    _req(idr or video_index > 0, "E_FIRST_NOT_IDR")
                    ts_ns = v["sec"] * 1_000_000_000 + v["nanos"]
                    au = AccessUnit(
                        index=video_index,
                        sequence=item.sequence,
                        source_frame_id="",
                        encoder_pts_us=-1,
                        capture_time_ns=str(ts_ns),
                        log_time_ns=str(item.log_time),
                        native_clock_id="",
                        native_timestamp_ns="",
                        native_timestamps={},
                        calibration_id="",
                        clock_mapping_revision="",
                        stream_id="",
                        frame_id=v["frame_id"],
                        is_idr=idr,
                        sha256=hashlib.sha256(v["data"]).hexdigest(),
                        data=v["data"],
                    )
                    video_index += 1
                    j = _Joined(au, item.log_time)
                    _req(
                        len(pending_video) < lim.max_pending_video,
                        "E_JOIN_WINDOW",
                        {
                            "pending_video": len(pending_video),
                            "limit": lim.max_pending_video,
                        },
                    )
                    pending_video.append(j)
                    pending_by_seq[item.sequence] = j
                    rep.peak_pending_video = max(
                        rep.peak_pending_video, len(pending_video)
                    )
                    early = early_written.pop(item.sequence, None)
                    if early is not None:
                        try_join(j, early[0], early[1])
                    yield from release_ready(False)
                elif topics[topic][2] == "json":
                    value = self._json(
                        topic, topics[topic][0], item.data, optional is not None
                    )
                    add_recording(value)
                    if topic == T_PROFILE:
                        _req(T_PROFILE not in seen_pre, "E_CHANNEL_CARDINALITY", topic)
                        _req(
                            self._expected_profile is None
                            or value["rgb_profile"] == self._expected_profile,
                            "E_SOURCE_PROFILE",
                            value["rgb_profile"],
                        )
                        rep.profile = value
                        profile_limits = value.get("limits", {})
                        seen_pre.add(topic)
                    elif topic in SHARED_DECLARATIONS:
                        add_declaration(topic, value)
                    elif topic == T_CALIBRATIONS:
                        cid = value["calibration_id"]
                        _req(
                            cid not in last_id_by_cal, "E_CALIBRATION_ASSOCIATION", cid
                        )
                        _req(
                            cid not in calibration_revisions
                            and len(calibration_revisions) < MAX_CALIBRATIONS,
                            "E_CALIBRATION_VALUES",
                            cid,
                        )
                        _req(
                            ref.calibration_values_ok(
                                value, (rep.profile or {}).get("encoder", {})
                            ),
                            "E_CALIBRATION_VALUES",
                            cid,
                        )
                        calibration_revisions[cid] = value
                    elif topic == CAMERA_METADATA and optional is not None:
                        optional.metadata(value)
                    elif topic == DEPTH_EVENTS and optional is not None:
                        optional.depth(value, clocks)
                    elif topic in (T_ACCEL, T_GYRO):
                        _req(
                            clocks["stream_clocks"].get(topic.rsplit("/", 1)[1])
                            == value["native_clock_id"],
                            "E_CLOCK_MISMATCH",
                            topic,
                        )
                        rep.motion_events[topic.rsplit("/", 1)[1]] += 1
                    elif topic == T_FRAMES:
                        e = value
                        sid, st = e["source_frame_id"], e["state"]
                        if st == "acquired":
                            _req(
                                sid not in inflight and sid not in recent_terminal,
                                "E_FRAME_IDENTITY",
                                sid,
                            )
                            _req(
                                int(sid) > last_acquired_id,
                                "E_ORDER_UNSUPPORTED",
                                {"source_frame_id": sid},
                            )
                            _req(
                                int(e["encoder_pts_us"]) > last_pts,
                                "E_ORDER_UNSUPPORTED",
                                {"encoder_pts_us": e["encoder_pts_us"]},
                            )
                            cid = e["calibration_id"]
                            if optional is not None:
                                _req(
                                    e["clock_mapping_revision"]
                                    == clocks["recorder_transport"]["revision"],
                                    "E_CLOCK_MISMATCH",
                                    sid,
                                )
                                calibration = calibration_revisions.get(cid)
                                if (
                                    calibration is not None
                                    and cid not in last_id_by_cal
                                ):
                                    _req(
                                        (
                                            sid,
                                            e["native_timestamp_ns"],
                                            e["native_clock_id"],
                                            e["stream_id"],
                                        )
                                        == (
                                            calibration["first_source_frame_id"],
                                            calibration["first_native_timestamp_ns"],
                                            calibration["native_clock_id"],
                                            calibration["stream_id"],
                                        ),
                                        "E_CALIBRATION_ASSOCIATION",
                                        cid,
                                    )
                                optional.acquired(e)
                            _req(
                                cid in last_id_by_cal
                                or len(last_id_by_cal) < MAX_CALIBRATIONS,
                                "E_SENSOR_BOUND",
                                "calibrations",
                            )
                            _req(
                                e["calibration_id"] not in reset_at
                                or int(sid) < reset_at[e["calibration_id"]],
                                "E_CALIBRATION_RESET_UNMARKED",
                                sid,
                            )
                            last_id_by_cal[e["calibration_id"]] = int(sid)
                            last_acquired_id, last_pts = (
                                int(sid),
                                int(e["encoder_pts_us"]),
                            )
                            _req(
                                len(inflight) < lim.max_inflight_frames,
                                "E_INFLIGHT_BOUND",
                                lim.max_inflight_frames,
                            )
                            inflight[sid] = e
                            inflight_state[sid] = st
                            rep.peak_inflight_frames = max(
                                rep.peak_inflight_frames, len(inflight)
                            )
                        else:
                            orig = inflight.get(sid)
                            _req(
                                orig is not None
                                and inflight_state[sid] not in ("written", "dropped")
                                and not (st == "submitted" and sid in submitted),
                                "E_FRAME_IDENTITY",
                                sid,
                            )
                            assert orig is not None
                            _req(
                                all(e.get(k) == orig.get(k) for k in ref.IDENTITY_KEYS),
                                "E_FRAME_IDENTITY",
                                sid,
                            )
                        if st in ("acquired", "written"):
                            _req(
                                clocks["stream_clocks"].get(e["stream_id"])
                                == e.get("native_clock_id"),
                                "E_CLOCK_MISMATCH",
                                sid,
                            )
                        rep.frame_counts[st] += 1
                        if st == "submitted":
                            submitted.add(sid)
                            inflight_state[sid] = st
                        elif st == "dropped":
                            drop_reasons[e["reason"]] = (
                                drop_reasons.get(e["reason"], 0) + 1
                            )
                            _req(
                                len(drop_reasons) <= lim.max_drop_reasons,
                                "E_DROP_REASON_BOUND",
                            )
                            self._terminal(
                                sid,
                                "dropped",
                                inflight,
                                inflight_state,
                                submitted,
                                recent_terminal,
                            )
                        elif st == "written":
                            full = inflight[sid]
                            ev = {**full, **{k: e[k] for k in e}}
                            seq = ev["output_sequence"]
                            self._terminal(
                                sid,
                                "written",
                                inflight,
                                inflight_state,
                                submitted,
                                recent_terminal,
                            )
                            waiting = pending_by_seq.get(seq)
                            if waiting is not None:
                                try_join(waiting, ev, item.log_time)
                                yield from release_ready(False)
                            else:
                                _req(seq > last_video_seq, "E_SEQUENCE", seq)
                                _req(seq not in early_written, "E_SEQUENCE", seq)
                                _req(
                                    len(early_written) < lim.max_pending_video,
                                    "E_JOIN_WINDOW",
                                    "written events without video",
                                )
                                early_written[seq] = (ev, item.log_time)
                    elif topic == T_SENSOR:
                        rep.sensor_events += 1
                        _req(
                            value["source_kind"] != "arcore_pose"
                            or value.get("tracking_state") == "tracking"
                            or not value.get("pose_valid"),
                            "E_TRACKING_LOSS_UNMARKED",
                        )
                        assoc = value.get("association_source_frame_id")
                        if value["source_kind"] == "calibration_reset":
                            sup = value["supersedes_calibration_id"]
                            if assoc is not None:
                                _req(
                                    last_id_by_cal.get(sup, -1) < int(assoc),
                                    "E_CALIBRATION_RESET_UNMARKED",
                                    sup,
                                )
                                _req(
                                    len(reset_at) < MAX_CALIBRATIONS,
                                    "E_SENSOR_BOUND",
                                    "calibration resets",
                                )
                                reset_at[sup] = int(assoc)
                        if assoc is None:
                            rep.unassociated_sensor_events += 1
                        elif assoc in held_by_id:
                            h = held_by_id[assoc]
                            _req(
                                len(h.sensors) < lim.max_sensor_events_per_frame,
                                "E_SENSOR_BOUND",
                                assoc,
                            )
                            h.sensors.append(value)
                        elif recent_terminal.get(assoc) == "dropped":
                            rep.sensor_events_for_dropped_frames += 1
                        elif assoc in released_ids:
                            raise CaptureStreamError("E_SENSOR_ASSOCIATION_LATE", assoc)
                        elif (
                            assoc in inflight
                            or int(assoc) > last_acquired_id
                            or any(
                                ev["source_frame_id"] == assoc
                                for ev, _ in early_written.values()
                            )
                        ):
                            _req(
                                sum(map(len, pending_sensor.values()))
                                < lim.max_pending_sensor_events,
                                "E_SENSOR_BOUND",
                                lim.max_pending_sensor_events,
                            )
                            waiting_sensors = pending_sensor.setdefault(assoc, [])
                            _req(
                                len(waiting_sensors) < lim.max_sensor_events_per_frame,
                                "E_SENSOR_BOUND",
                                assoc,
                            )
                            waiting_sensors.append(value)
                        else:
                            raise CaptureStreamError("E_SENSOR_ASSOCIATION_LATE", assoc)
                    elif topic == T_CLOSE:
                        closed = True
                        rep.close = value
                elif topic == T_POSE:
                    try:
                        ref.decode_cdr_pose(item.data)
                    except (ValueError, IndexError, struct.error, UnicodeDecodeError):
                        raise CaptureStreamError("E_MALFORMED_MESSAGE", topic) from None
                    rep.pose_messages += 1
                elif optional is not None and topic in ref.DEPTH_IMAGE_TOPICS:
                    optional.image(topic, item.sequence, item.data)
                else:
                    raise CaptureStreamError("E_CHANNEL_ENCODING", topic)
        _req(
            all(t in seen_pre for t in (*PRE_FRAME, T_INVENTORY))
            and rep.close is not None,
            "E_CHANNEL_CARDINALITY",
            "Profile, Clocks, Inventory and Close are required exactly once",
        )
        calibration_inventory = inventory.get("calibrations", [])
        calibrations = {
            entry["calibration_id"]: entry for entry in calibration_inventory
        }
        unknown = last_id_by_cal.keys() - calibrations.keys()
        _req(not unknown, "E_CALIBRATION_UNKNOWN", sorted(unknown))
        _req(
            not pending_video and not early_written,
            "E_SEQUENCE",
            "video/written mismatch",
        )
        rep.sensor_events_unmatched = sum(map(len, pending_sensor.values()))
        yield from release_ready(True)
        unresolved = len(inflight)
        rep.unresolved_frames = unresolved
        close = rep.close
        assert close is not None
        expect = {k: str(v) for k, v in rep.frame_counts.items()}
        expect["unresolved"] = str(unresolved)
        expect_drops = sorted(
            ({"reason": r, "count": str(n)} for r, n in drop_reasons.items()),
            key=lambda d: d["reason"],
        )
        _req(
            close["frames"] == expect
            and close["video_messages"] == str(rep.video_messages)
            and close["motion_events"]
            == {k: str(v) for k, v in rep.motion_events.items()}
            and close["sensor_events"] == str(rep.sensor_events)
            and sorted(close["drops"], key=lambda d: d["reason"]) == expect_drops,
            "E_COUNT_MISMATCH",
        )
        if close["outcome"] == "completed":
            _req(unresolved == 0, "E_OUTCOME_MISMATCH")
        elif close["outcome"] == "failed":
            _req(close.get("failure_reason") is not None, "E_OUTCOME_MISMATCH")
        _req(rep.frame_counts["written"] == rep.video_messages, "E_SEQUENCE")
        if optional is not None:
            _req(
                len(calibrations) == len(calibration_inventory),
                "E_CALIBRATION_VALUES",
                "duplicate inventory calibration",
            )
            unknown = calibration_revisions.keys() - calibrations.keys()
            _req(not unknown, "E_CALIBRATION_UNKNOWN", sorted(unknown))
            present = {
                cid for cid, entry in calibrations.items() if entry["state"] == "yes"
            }
            _req(
                present == calibration_revisions.keys(),
                "E_CALIBRATION_VALUES",
                "inventory disagrees with calibration records",
            )
            for cid in present:
                _req(
                    calibrations[cid]["stream_id"] == "rgb", "E_CALIBRATION_VALUES", cid
                )
                _req(cid in last_id_by_cal, "E_CALIBRATION_ASSOCIATION", cid)
            _req(
                close["calibrations"] == str(len(present)),
                "E_COUNT_MISMATCH",
                T_CALIBRATIONS,
            )
            self._check_v12_outcome(close)
            rep.native_evidence_counts = {
                "calibrations": len(present),
                **optional.finish(inventory, close),
            }
        rep.accepted = True

    # ------------------------------------------------------------------------------------
    @staticmethod
    def _terminal(
        sid: str,
        state: str,
        inflight: dict[str, dict[str, Any]],
        inflight_state: dict[str, str],
        submitted: set[str],
        recent: OrderedDict[str, str],
    ) -> None:
        # `written`/`dropped` frames leave the in-flight table; a bounded memory remains.
        # `unresolved` at Close counts only frames that never reached a terminal state.
        inflight.pop(sid, None)
        inflight_state.pop(sid, None)
        submitted.discard(sid)
        recent[sid] = state
        if len(recent) > 256:
            recent.popitem(last=False)

    @staticmethod
    def _check_v12_outcome(close: dict[str, Any]) -> None:
        outcome, reason, drain = (
            close["outcome"],
            close["stop_reason"],
            close["encoder_drain"],
        )
        _req(
            outcome != "completed"
            or (
                drain == "eos_reached"
                and reason in ("user_requested", "duration_limit")
            ),
            "E_OUTCOME_MISMATCH",
        )
        _req(
            outcome == "failed"
            or (
                reason not in ("writer_error", "encoder_error")
                and drain != "encoder_failed"
            ),
            "E_OUTCOME_MISMATCH",
        )
        _req(
            outcome in ("aborted", "failed")
            or reason
            not in (
                "low_storage_reserve",
                "thermal_critical",
                "session_interrupted",
                "camera_lost",
                "app_terminating",
            ),
            "E_OUTCOME_MISMATCH",
        )
        _req(
            drain != "not_started" or close["video_messages"] == "0",
            "E_OUTCOME_MISMATCH",
        )
        _req(outcome != "unknown" or reason == "unknown", "E_OUTCOME_MISMATCH")

    def _check_schema(self, s: SchemaDef, hashes: dict[str, Any]) -> None:
        ref = self._ref
        digest = hashlib.sha256(s.data).hexdigest()
        if s.name == ref.VIDEO_SCHEMA:
            _req(
                digest == hashes["foxglove-compressed-video.desc"],
                "E_DESCRIPTOR_HASH",
            )
        elif s.name == ref.RAW_IMAGE_SCHEMA and ref.RAW_IMAGE_DESC in hashes:
            _req(digest == hashes[ref.RAW_IMAGE_DESC], "E_DESCRIPTOR_HASH", s.name)
        elif s.name in ref.CUSTOM or s.name in ref.CUSTOM12:
            filename = ref.CUSTOM.get(s.name) or ref.CUSTOM12[s.name]
            _req(
                digest == hashes.get(filename),
                "E_SCHEMA_MISMATCH",
                s.name,
            )
        elif s.name == ref.POSE_SCHEMA:
            _req(
                digest == hashes[ref.POSE_SCHEMA_FILE],
                "E_CHANNEL_ENCODING",
                s.name,
            )

    @staticmethod
    def _check_channel(
        c: ChannelDef,
        schemas: dict[int, SchemaDef],
        topics: dict[str, tuple[str, str, str]],
    ) -> None:
        want = topics.get(c.topic)
        s = schemas.get(c.schema_id)
        _req(
            s is not None
            and want is not None
            and (s.name, s.encoding, c.message_encoding) == want,
            "E_CHANNEL_ENCODING",
            c.topic,
        )

    def _json(
        self, topic: str, schema_name: str, data: bytes, v12: bool
    ) -> dict[str, Any]:
        ss = self._schema_mod
        _req(
            not v12 or len(data) <= self._ref.JSON_MESSAGE_MAX,
            "E_MALFORMED_MESSAGE",
            topic,
        )
        try:
            value = ss.parse_json(data)
        except (ss.MalformedJson, ValueError, UnicodeDecodeError):
            raise CaptureStreamError("E_MALFORMED_MESSAGE", topic) from None
        violations = self._ref.contract_schema(schema_name).validate(value)
        _req(
            not violations,
            "E_SCHEMA_MALFORMED",
            [f"{topic}{v}" for v in violations[:20]],
        )
        assert isinstance(value, dict)
        return value
