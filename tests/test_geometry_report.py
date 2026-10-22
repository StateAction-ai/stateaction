"""Separate-clock reporting must never fabricate elapsed time or accuracy."""
from copy import deepcopy
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from geometry_report import write_geometry_report, VERSION


class GeometryReportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.output = Path(self.temp.name)
        self.geometry = []
        for i in range(2):
            self.geometry.append({
                'tracking': True, 'calibration_contract_verified': True,
                'source': {'capture_geometry_version': VERSION,
                    'frame_timestamp_ns': 10_000_000_000 + i*20_000_000,
                    'rgb_timestamp_ns': 1_000_000_000_000 + i*20_000_000,
                    'android_camera_timestamp_ns': 1_000_000_000_000 + i*20_000_000,
                    'depth_timestamp_ns': 7_000_000_000_000 + i*33_000_000,
                    'depth_available': True}})
        self.timestamps = [1000., 1000.02]
        self.summary = {'frames': 2, 'detected_hands': 2,
                        'geometry_consistent_hands': 0, 'fully_observed_consistent_hands': 0}

    def write(self):
        return write_geometry_report(self.output, self.geometry, self.timestamps, self.summary)

    def test_disjoint_clocks_remain_separate_and_rgb_span_is_local(self):
        result = self.write()
        clocks = result['native_clocks']
        self.assertEqual(clocks['arcore_frame']['minimum_ns'], 10_000_000_000)
        self.assertEqual(clocks['rgb_image']['minimum_ns'], 1_000_000_000_000)
        self.assertEqual(clocks['depth_image']['maximum_ns'], 7_000_033_000_000)
        self.assertAlmostEqual(clocks['rgb_image']['span_s_within_rgb_clock'], .02)
        self.assertIsNone(result['cross_stream_elapsed_s'])
        self.assertIsNone(result['rgb_depth_age_s'])
        self.assertFalse(result['absolute_time_mapping_available'])
        self.assertFalse(result['cross_stream_clock_verified'])

    def test_report_contains_no_epoch_calendar_or_health_accuracy_claim(self):
        self.summary['health_score'] = 97
        self.summary['metric_accuracy_validated'] = True
        result = self.write()
        document = (self.output / 'evaluation.html').read_text()
        self.assertNotIn('1970-', document)
        self.assertNotIn('Start (ISO)', document)
        self.assertNotIn('97', document)
        self.assertIn('SDK health score is not hand-pose accuracy', document)
        self.assertFalse(result['metric_accuracy_validated'])
        self.assertFalse(result['summary']['metric_accuracy_validated'])
        self.assertNotIn('health_score', result['summary'])
        self.assertFalse(result['visibility']['independent_joint_visibility_supplied'])

    def test_native_evidence_and_upstream_files_are_preserved(self):
        before = deepcopy(self.geometry)
        upstream = {name: ('unaltered '+name).encode() for name in
                    ('evaluation_metrics.upstream.json', 'evaluation.upstream.html')}
        for name, content in upstream.items(): (self.output/name).write_bytes(content)
        result = self.write()
        self.assertEqual(self.geometry, before)
        for name, content in upstream.items(): self.assertEqual((self.output/name).read_bytes(), content)
        self.assertEqual(json.loads((self.output/'evaluation_metrics.json').read_text()), result)

    def test_missing_depth_has_no_invented_native_bounds(self):
        for frame in self.geometry:
            frame['source']['depth_available'] = False
            frame['source']['depth_timestamp_ns'] = None
        result = self.write()
        depth = result['native_clocks']['depth_image']
        self.assertEqual(depth['count'], 0)
        self.assertEqual(depth['missing_count'], 2)
        self.assertIsNone(depth['minimum_ns']); self.assertIsNone(depth['maximum_ns'])
        self.assertEqual(result['stream_counts']['depth_available_frames'], 0)

    def test_wrong_version_and_misaligned_frame_counts_rejected(self):
        self.geometry[0]['source']['capture_geometry_version'] = 'android_arcore_cpu_v1'
        with self.assertRaisesRegex(ValueError, 'v2 capture contract'): self.write()
        self.geometry[0]['source']['capture_geometry_version'] = VERSION
        self.timestamps.pop()
        with self.assertRaisesRegex(ValueError, 'frame counts'): self.write()


if __name__ == '__main__': unittest.main()
