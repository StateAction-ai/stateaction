"""Streaming `h264_mcap_v1` capture reader (SA-29): contract rules + bounded frame join.

Layers: `mcap_stream.McapStream` (container, hashing) -> this module (contract rules, join) ->
`h264_decode` (one persistent decoder). Nothing here holds the whole session: state is O(in-flight
frames + join window), all bounded by `StreamLimits`.

PROVISIONAL RULE: access units are yielded as soon as their identity is joined, but the capture is
accepted only after the iterator is exhausted without error (footer, data CRC, summary, full
SHA-256 and the contract Close counts verified). A consumer may process provisionally with bounded
temporary artifacts; it must not publish or report success before `CaptureStream.accepted`.

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
T_ACCEL, T_GYRO, T_POSE = (
    "/stateaction/imu/accel",
    "/stateaction/imu/gyro",
    "/tracking/pose",
)
# The native recorder writes Profile and Clocks first and Inventory/Close at stop; the golden
# fixtures put Inventory first. Both orders are accepted; Inventory-dependent checks run at the end.
PRE_FRAME = (T_PROFILE, T_CLOCKS)
INT64_MAX = 2**63 - 1


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
    max_pending_video: int = 8  # video messages waiting for their `written` FrameEvent
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


@dataclass
class CaptureReport:
    source: SourceReport
    recording_id: str | None = None
    profile: dict[str, Any] | None = None
    close: dict[str, Any] | None = None
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


class _Joined:
    """Mutable record for one video message waiting for join / sensor evidence."""

    __slots__ = ("au", "log_time", "released_after", "sensors")

    def __init__(self, au: AccessUnit, log_time: int):
        self.au, self.log_time = au, log_time
        self.sensors: list[dict[str, Any]] = []
        self.released_after = 0


class CaptureStream:
    """Iterate accepted-so-far `AccessUnit`s; `report.accepted` only after clean exhaustion."""

    def __init__(self, raw: BinaryIO, limits: StreamLimits | None = None):
        self.limits = limits or StreamLimits()
        self._mcap = McapStream(raw, self.limits.mcap)
        self.report = CaptureReport(self._mcap.report)
        self._ref = contract.reference()
        self._schema_mod = contract.strict_schema()
        self._manifest = contract.manifest()

    @property
    def accepted(self) -> bool:
        return self.report.accepted

    def __iter__(self) -> Iterator[AccessUnit]:
        try:
            yield from self._run()
        except McapStreamError as e:
            raise CaptureStreamError(e.code, e.detail) from None

    # ------------------------------------------------------------------------------------
    def _run(self) -> Iterator[AccessUnit]:
        ref, lim, rep = self._ref, self.limits, self.report
        schemas: dict[int, SchemaDef] = {}
        topics: dict[int, str] = {}
        seen_pre: set[str] = set()
        clocks: dict[str, str] = {}
        calibrations: set[str] = set()
        used_calibrations: set[str] = set()
        profile_limits: dict[str, Any] = {}
        profile_raster: tuple[int, int] | None = None
        closed = False
        # frame lifecycle (bounded): in-flight frames only, plus a short terminal memory
        inflight: dict[str, dict[str, Any]] = {}
        inflight_state: dict[str, str] = {}
        submitted: set[str] = set()
        recent_terminal: OrderedDict[str, str] = OrderedDict()
        last_acquired_id = -1
        last_id_by_cal: dict[str, int] = {}
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
        counts: dict[str, int] = {k: 0 for k in (T_FRAMES, T_SENSOR, T_ACCEL, T_GYRO)}
        legacy = False
        profile_seen_header = False

        def add_recording(v: dict[str, Any]) -> None:
            recording_ids.add(v["recording_id"])
            _req(len(recording_ids) == 1, "E_RECORDING_ID", sorted(recording_ids))
            rep.recording_id = v["recording_id"]

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
            joined = AccessUnit(
                **{
                    **video.__dict__,
                    "source_frame_id": ev["source_frame_id"],
                    "encoder_pts_us": int(ev["encoder_pts_us"]),
                    "native_clock_id": ev["native_clock_id"],
                    "native_timestamp_ns": ev["native_timestamp_ns"],
                    "native_timestamps": ev["native_timestamps"],
                    "calibration_id": ev["calibration_id"],
                    "clock_mapping_revision": ev["clock_mapping_revision"],
                    "stream_id": ev["stream_id"],
                }
            )
            j.au = joined
            j.released_after = n_video
            pending_video.remove(j)
            pending_by_seq.pop(video.sequence, None)
            held.append(j)
            held_by_id[joined.source_frame_id] = j
            sensors = pending_sensor.pop(joined.source_frame_id, [])
            j.sensors.extend(sensors)
            rep.peak_held_access_units = max(rep.peak_held_access_units, len(held))

        for item in self._mcap:
            if isinstance(item, McapHeader):
                _req(item.profile == "", "E_PROFILE_NOT_EMPTY", item.profile)
                profile_seen_header = True
            elif isinstance(item, SchemaDef):
                schemas[item.id] = item
                self._check_schema(item)
            elif isinstance(item, ChannelDef):
                topics[item.id] = item.topic
                if item.topic == LEGACY_JPEG_TOPIC:
                    legacy = True
                    raise CaptureStreamError(
                        "E_LEGACY_JPEG_UNSUPPORTED",
                        "jpeg_mcap_v1 is an explicit legacy profile; this reader is h264_mcap_v1 only",
                    )
                self._check_channel(item, schemas)
            elif isinstance(item, Message):
                topic = topics[item.channel_id]
                _req(not closed, "E_ORDER", "message after Close")
                _req(profile_seen_header, "E_ORDER")
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
                    except (ValueError, IndexError, UnicodeDecodeError):
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
                elif topic in (
                    T_ACCEL,
                    T_GYRO,
                    T_FRAMES,
                    T_SENSOR,
                    T_PROFILE,
                    T_CLOCKS,
                    T_INVENTORY,
                    T_CLOSE,
                ):
                    value = self._json(topic, item.data)
                    add_recording(value)
                    if topic == T_PROFILE:
                        _req(T_PROFILE not in seen_pre, "E_CHANNEL_CARDINALITY", topic)
                        rep.profile = value
                        profile_limits = value.get("limits", {})
                        enc = value.get("encoder", {})
                        if "width" in enc and "height" in enc:
                            profile_raster = (enc["width"], enc["height"])
                        seen_pre.add(topic)
                    elif topic == T_CLOCKS:
                        _req(T_CLOCKS not in seen_pre, "E_CHANNEL_CARDINALITY", topic)
                        clocks = value["stream_clocks"]
                        seen_pre.add(topic)
                    elif topic == T_INVENTORY:
                        _req(
                            T_INVENTORY not in seen_pre, "E_CHANNEL_CARDINALITY", topic
                        )
                        calibrations = {
                            c["calibration_id"] for c in value.get("calibrations", [])
                        }
                        seen_pre.add(topic)
                    elif topic in (T_ACCEL, T_GYRO):
                        _req(
                            clocks.get(topic.rsplit("/", 1)[1])
                            == value["native_clock_id"],
                            "E_CLOCK_MISMATCH",
                            topic,
                        )
                        rep.motion_events[topic.rsplit("/", 1)[1]] += 1
                    elif topic == T_FRAMES:
                        counts[T_FRAMES] += 1
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
                            used_calibrations.add(e["calibration_id"])
                            _req(
                                len(used_calibrations) <= 64,
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
                                clocks.get(e["stream_id"]) == e.get("native_clock_id"),
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
                                _req(
                                    len(early_written) < lim.max_pending_video,
                                    "E_JOIN_WINDOW",
                                    "written events without video",
                                )
                                early_written[seq] = (ev, item.log_time)
                    elif topic == T_SENSOR:
                        rep.sensor_events += 1
                        counts[T_SENSOR] += 1
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
                                    len(reset_at) < 64,
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
                            or any(p.au.source_frame_id == assoc for p in pending_video)
                        ):
                            _req(
                                sum(map(len, pending_sensor.values()))
                                < lim.max_pending_sensor_events,
                                "E_SENSOR_BOUND",
                                lim.max_pending_sensor_events,
                            )
                            pending_sensor.setdefault(assoc, []).append(value)
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
                else:
                    raise CaptureStreamError("E_CHANNEL_ENCODING", topic)
        _ = legacy
        _req(
            used_calibrations <= calibrations,
            "E_CALIBRATION_UNKNOWN",
            sorted(used_calibrations - calibrations),
        )
        # ---- container fully verified (iterator ended); now end-of-capture contract rules
        _req(
            all(t in seen_pre for t in (*PRE_FRAME, T_INVENTORY))
            and rep.close is not None,
            "E_CHANNEL_CARDINALITY",
            "Profile, Clocks, Inventory and Close are required exactly once",
        )
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
        _ = profile_raster
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

    def _check_schema(self, s: SchemaDef) -> None:
        ref = self._ref
        digest = hashlib.sha256(s.data).hexdigest()
        if s.name == ref.VIDEO_SCHEMA:
            _req(
                digest == self._manifest["foxglove-compressed-video.desc"],
                "E_DESCRIPTOR_HASH",
            )
        elif s.name in ref.CUSTOM:
            _req(
                digest == self._manifest[ref.CUSTOM[s.name]],
                "E_SCHEMA_MISMATCH",
                s.name,
            )
        elif s.name == ref.POSE_SCHEMA:
            _req(
                digest == self._manifest[ref.POSE_SCHEMA_FILE],
                "E_CHANNEL_ENCODING",
                s.name,
            )
        elif s.name == "sensor_msgs/msg/CompressedImage":
            raise CaptureStreamError("E_LEGACY_JPEG_UNSUPPORTED", s.name)

    def _check_channel(self, c: ChannelDef, schemas: dict[int, SchemaDef]) -> None:
        want = self._ref.CHANNELS.get(c.topic)
        s = schemas.get(c.schema_id)
        _req(
            s is not None
            and want is not None
            and (s.name, s.encoding, c.message_encoding) == want,
            "E_CHANNEL_ENCODING",
            c.topic,
        )

    def _json(self, topic: str, data: bytes) -> dict[str, Any]:
        ss = self._schema_mod
        try:
            value = ss.parse_json(data)
        except (ss.MalformedJson, ValueError, UnicodeDecodeError):
            raise CaptureStreamError("E_MALFORMED_MESSAGE", topic) from None
        schema_name = self._ref.CHANNELS[topic][0]
        violations = self._ref.contract_schema(schema_name).validate(value)
        _req(
            not violations,
            "E_SCHEMA_MALFORMED",
            [f"{topic}{v}" for v in violations[:20]],
        )
        assert isinstance(value, dict)
        return value
