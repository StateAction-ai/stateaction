import unittest

from stateaction_processing.hand_pose_cpu_v1 import ApiError, _error_code


class ErrorCodeTest(unittest.TestCase):
    def test_runtime_error_reports_its_stable_reason(self):
        self.assertEqual(
            _error_code(RuntimeError("api_unavailable")), "api_unavailable"
        )
        self.assertEqual(_error_code(RuntimeError("short_read")), "short_read")

    def test_free_text_runtime_error_and_other_classes_keep_the_class_name(self):
        self.assertEqual(_error_code(RuntimeError("Boom at /tmp/x")), "runtimeerror")
        self.assertEqual(_error_code(RuntimeError("boom")), "runtimeerror")
        self.assertEqual(_error_code(BlockingIOError("x")), "blockingioerror")

    def test_coded_errors_keep_their_code(self):
        self.assertEqual(_error_code(ApiError(409, "conflict")), "conflict")


if __name__ == "__main__":
    unittest.main()
