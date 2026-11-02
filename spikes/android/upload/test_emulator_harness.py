import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from emulator_harness import EMULATOR_SERIAL, Harness, SafetyError  # noqa: E402


class HarnessSafety(unittest.TestCase):
    def test_refuses_anything_but_an_emulator_serial(self) -> None:
        for serial in (
            "R58M123ABC",
            "192.168.1.5:5555",
            "emulator-",
            "emulator-5554 ",
            "all",
        ):
            with self.assertRaises(SafetyError, msg=serial):
                Harness(serial, 0, "adb")

    def test_accepts_emulator_serial_without_running_adb(self) -> None:
        self.assertTrue(EMULATOR_SERIAL.fullmatch("emulator-5580"))
        Harness("emulator-5580", 0, "adb")


if __name__ == "__main__":
    unittest.main()
