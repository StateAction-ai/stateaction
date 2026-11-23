from __future__ import annotations

import struct
from collections import OrderedDict
from dataclasses import dataclass
from types import ModuleType
from typing import Any

CAMERA_METADATA = "/stateaction/camera_metadata"
DEPTH_EVENTS = "/stateaction/depth_events"
DEPTH_STREAMS = ("depth_raw", "depth_dense")
CALIBRATION_LIMIT = 64


class SensorEvidenceError(ValueError):
    def __init__(self, code: str, detail: object = None):
        super().__init__(code if detail is None else f"{code}: {detail}")
        self.code = code
        self.detail = detail


def _require(ok: bool, code: str, detail: object = None) -> None:
    if not ok:
        raise SensorEvidenceError(code, detail)


@dataclass
class _RecentFrame:
    clock: str
    timestamp: str
    has_metadata: bool = False


@dataclass
class _FutureFrame:
    acquisition: bool = False
    measurement: tuple[str, str] | None = None
    has_metadata: bool = False
    metadata_timestamp: str | None = None


@dataclass(frozen=True)
class _Plane:
    width: int
    height: int
    step: int
    data_bytes: int
    encoding: str
    timestamp_ns: int


@dataclass
class _DepthStream:
    last_id: int = -1
    last_stamp: tuple[int, int] | None = None
    events: int = 0
    distinct_timestamps: int = 0
    confidence_images: int = 0
    repeated: bool = False


class V12Sensors:
    """Verify optional records without retaining image payloads or an all-frame index.

    Associations can reach back to recently acquired frames or forward to pending
    acquisitions. Event IDs and image sequences must increase within each stream.
    """

    def __init__(self, ref: ModuleType, max_pending: int):
        self._ref = ref
        self._limit = max_pending
        self._recent: OrderedDict[str, _RecentFrame] = OrderedDict()
        self._future: dict[str, _FutureFrame] = {}
        self._last_frame_id = -1
        self._metadata_count = 0
        self._streams = {stream: _DepthStream() for stream in DEPTH_STREAMS}
        self._calibrations: dict[str, str] = {}
        self._last_image = dict.fromkeys(ref.DEPTH_IMAGE_TOPICS, -1)
        self._last_declaration = self._last_image.copy()
        self._planes: dict[tuple[str, int], _Plane] = {}

    def acquired(self, frame: dict[str, Any]) -> None:
        sid = frame["source_frame_id"]
        self._last_frame_id = int(sid)
        current = _RecentFrame(frame["native_clock_id"], frame["native_timestamp_ns"])
        if (pending := self._future.pop(sid, None)) is not None:
            _require(
                pending.measurement is None
                or pending.measurement == (current.clock, current.timestamp),
                "E_DEPTH_ASSOCIATION",
                sid,
            )
            _require(
                pending.metadata_timestamp is None
                or pending.metadata_timestamp == current.timestamp,
                "E_CAMERA_METADATA",
                sid,
            )
            current.has_metadata = pending.has_metadata
        self._recent[sid] = current
        if len(self._recent) > self._limit:
            self._recent.popitem(last=False)

    def _future_frame(self, sid: str, code: str) -> _FutureFrame:
        _require(int(sid) > self._last_frame_id, code, sid)
        if sid not in self._future:
            _require(
                len(self._future) < self._limit,
                "E_SENSOR_BOUND",
                "pending v1.2 frame associations",
            )
            self._future[sid] = _FutureFrame()
        return self._future[sid]

    def metadata(self, value: dict[str, Any]) -> None:
        sid = value["source_frame_id"]
        timestamp = value["native_timestamp_ns"]
        if (frame := self._recent.get(sid)) is not None:
            _require(
                timestamp is None or timestamp == frame.timestamp,
                "E_CAMERA_METADATA",
                sid,
            )
            _require(not frame.has_metadata, "E_CAMERA_METADATA", sid)
            frame.has_metadata = True
        else:
            pending = self._future_frame(sid, "E_CAMERA_METADATA")
            _require(not pending.has_metadata, "E_CAMERA_METADATA", sid)
            pending.has_metadata = True
            pending.metadata_timestamp = timestamp
        self._metadata_count += 1

    def depth(self, value: dict[str, Any], clocks_message: dict[str, Any]) -> None:
        stream = value["stream_id"]
        state = self._streams[stream]
        event_id = int(value["event_id"])
        _require(event_id > state.last_id, "E_DEPTH_EVIDENCE", "depth event order")
        state.last_id = event_id

        clocks, transport = (
            clocks_message["stream_clocks"],
            clocks_message["recorder_transport"],
        )
        clock = value["native_clock_id"]
        timestamp = int(value["native_timestamp_ns"])
        capture_ns = int(value["capture_time_ns"])
        _require(
            clocks.get(stream) == clock
            and value["clock_mapping_revision"] == transport["revision"],
            "E_CLOCK_MISMATCH",
            stream,
        )
        receipt = value["receipt_native_timestamp_ns"]
        if value["capture_time_basis"] == "transport_mapping":
            _require(clock == transport["clock_id"], "E_CLOCK_MISMATCH", stream)
            mapped_from = timestamp
        else:
            _require(receipt is not None, "E_CLOCK_MISMATCH", stream)
            mapped_from = int(receipt)
        offset = int(transport["epoch_anchor_ns"]) - int(transport["native_anchor_ns"])
        _require(capture_ns == mapped_from + offset, "E_CLOCK_MISMATCH", stream)

        epoch = value["clock_epoch"]
        stamp = (epoch, timestamp)
        relation = value["timestamp_relation"]
        last = state.last_stamp
        if last is None:
            expected = "first"
        elif epoch > last[0]:
            expected = "clock_reset"
        elif epoch == last[0] and timestamp > last[1]:
            expected = "advanced"
        elif stamp == last:
            expected = "repeated"
        else:
            raise SensorEvidenceError("E_DEPTH_CADENCE", stream)
        _require(relation == expected, "E_DEPTH_CADENCE", stream)
        repeated = relation == "repeated"
        provenance = value["estimate_provenance"]
        _require(
            not (
                (repeated and provenance == "new_estimate")
                or (not repeated and provenance == "api_repeat")
            ),
            "E_DEPTH_CADENCE",
            stream,
        )
        state.last_stamp = stamp
        state.events += 1
        state.distinct_timestamps += int(not repeated)
        state.repeated |= repeated
        self._associate_depth(value)

        if (calibration_id := value["calibration_id"]) is not None:
            _require(
                self._calibrations.get(calibration_id, stream) == stream,
                "E_CALIBRATION_UNKNOWN",
                calibration_id,
            )
            if calibration_id not in self._calibrations:
                _require(
                    len(self._calibrations) < CALIBRATION_LIMIT,
                    "E_SENSOR_BOUND",
                    "depth calibrations",
                )
                self._calibrations[calibration_id] = stream

        depth, confidence = value["depth"], value["confidence"]
        self._declare_plane(depth, capture_ns, 2)
        if confidence["state"] == "separate_image":
            _require(
                all(
                    confidence[key] == depth[key]
                    for key in (
                        "native_width",
                        "native_height",
                        "stored_width",
                        "stored_height",
                        "crop",
                    )
                ),
                "E_DEPTH_EVIDENCE",
                "confidence dimensions differ",
            )
            native_stamp = confidence["native_timestamp"]
            _require(
                native_stamp["state"] != "reported"
                or native_stamp["native_clock_id"]
                == clocks.get("depth_raw_confidence"),
                "E_CLOCK_MISMATCH",
                "depth_raw_confidence",
            )
            self._declare_plane(confidence, capture_ns, 1)
            state.confidence_images += 1

    def _associate_depth(self, value: dict[str, Any]) -> None:
        acquisition = value["acquisition_source_frame_id"]
        if acquisition is not None and acquisition not in self._recent:
            self._future_frame(acquisition, "E_DEPTH_ASSOCIATION").acquisition = True
        measurement = value["measurement_source_frame_id"]
        if measurement is None:
            return
        clock_and_stamp = (value["native_clock_id"], value["native_timestamp_ns"])
        if (frame := self._recent.get(measurement)) is not None:
            _require(
                clock_and_stamp == (frame.clock, frame.timestamp),
                "E_DEPTH_ASSOCIATION",
                measurement,
            )
        else:
            pending = self._future_frame(measurement, "E_DEPTH_ASSOCIATION")
            _require(
                pending.measurement is None or pending.measurement == clock_and_stamp,
                "E_DEPTH_ASSOCIATION",
                measurement,
            )
            pending.measurement = clock_and_stamp

    def _declare_plane(self, plane: dict[str, Any], time_ns: int, sample: int) -> None:
        topic, sequence = plane["output_channel"], plane["output_sequence"]
        _require(self._ref.plane_ok(plane, sample), "E_DEPTH_EVIDENCE", topic)
        width, height = plane["stored_width"], plane["stored_height"]
        step = width * sample
        self._join_plane(
            topic,
            sequence,
            _Plane(width, height, step, step * height, plane["encoding"], time_ns),
            declaration=True,
        )

    def image(self, topic: str, sequence: int, payload: bytes) -> None:
        try:
            image = self._ref.decode_raw_image(payload)
        except (ValueError, IndexError, struct.error):
            raise SensorEvidenceError("E_MALFORMED_MESSAGE", topic) from None
        _require(
            image["frame_id"] == self._ref.DEPTH_FRAME_ID, "E_DEPTH_EVIDENCE", topic
        )
        self._join_plane(
            topic,
            sequence,
            _Plane(
                image["width"],
                image["height"],
                image["step"],
                len(image["data"]),
                image["encoding"],
                image["capture_ns"],
            ),
            declaration=False,
        )

    def _join_plane(
        self, topic: str, sequence: int, plane: _Plane, *, declaration: bool
    ) -> None:
        own = self._last_declaration if declaration else self._last_image
        other = self._last_image if declaration else self._last_declaration
        key = (topic, sequence)
        _require(sequence > own[topic], "E_DEPTH_EVIDENCE", key)
        own[topic] = sequence
        partner = self._planes.pop(key, None)
        if partner is not None:
            _require(partner == plane, "E_DEPTH_EVIDENCE", key)
        else:
            _require(sequence > other[topic], "E_DEPTH_EVIDENCE", key)
            _require(
                len(self._planes) < self._limit,
                "E_SENSOR_BOUND",
                "pending depth image associations",
            )
            self._planes[key] = plane

    def finish(
        self, inventory: dict[str, Any], close: dict[str, Any]
    ) -> dict[str, int]:
        for sid, pending in self._future.items():
            code = (
                "E_DEPTH_ASSOCIATION"
                if pending.acquisition or pending.measurement is not None
                else "E_CAMERA_METADATA"
            )
            raise SensorEvidenceError(code, sid)
        _require(not self._planes, "E_DEPTH_EVIDENCE", "unmatched depth image evidence")

        calibrations = {
            cal["calibration_id"]: cal["stream_id"] for cal in inventory["calibrations"]
        }
        for calibration_id, stream in self._calibrations.items():
            _require(
                calibrations.get(calibration_id) == stream,
                "E_CALIBRATION_UNKNOWN",
                calibration_id,
            )
        counts = {stream: state.events for stream, state in self._streams.items()}
        counts["camera_metadata"] = self._metadata_count
        self._check_inventory(inventory, counts)

        for stream, state in self._streams.items():
            actual = close["depth"][stream]
            _require(
                actual["events"] == str(state.events)
                and actual["distinct_native_timestamps"]
                == str(state.distinct_timestamps),
                "E_COUNT_MISMATCH",
                stream,
            )
            _require(
                not (
                    (
                        actual["retention_policy"] == "native_updates_only"
                        and state.repeated
                    )
                    or (
                        actual["retention_policy"] == "all_returned_images"
                        and actual["skipped_repeats"] != "0"
                    )
                ),
                "E_DEPTH_CADENCE",
                stream,
            )
        confidence = self._streams["depth_raw"].confidence_images
        _require(
            close["depth"]["depth_raw"]["confidence_images"] == str(confidence)
            and close["camera_metadata"] == str(self._metadata_count),
            "E_COUNT_MISMATCH",
            "confidence or camera metadata",
        )
        return {**counts, "depth_raw_confidence": confidence}

    @staticmethod
    def _check_inventory(inventory: dict[str, Any], counts: dict[str, int]) -> None:
        declarations = ("mesh", "point_cloud")
        entries = {}
        for entry in inventory["sensors"]:
            sensor = entry["sensor_id"]
            if sensor not in counts and sensor not in declarations:
                continue
            _require(sensor not in entries, "E_COUNT_MISMATCH", sensor)
            entries[sensor] = entry
        for sensor in declarations:
            if (entry := entries.get(sensor)) is not None:
                _require(
                    entry["observed"] != "yes"
                    and entry["enabled"] != "yes"
                    and entry["observed_count"] in (None, "0"),
                    "E_UNSUPPORTED_STREAM",
                    sensor,
                )
        for sensor, count in counts.items():
            entry = entries.get(sensor)
            if count:
                valid = (
                    entry is not None
                    and (entry["supported"], entry["enabled"], entry["observed"])
                    == ("yes", "yes", "yes")
                    and entry["observed_count"] == str(count)
                )
            else:
                valid = entry is None or (
                    entry["observed"] != "yes"
                    and entry["observed_count"] in (None, "0")
                )
            _require(valid, "E_COUNT_MISMATCH", sensor)
