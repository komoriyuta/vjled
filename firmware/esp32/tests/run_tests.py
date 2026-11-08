#!/usr/bin/env python3
"""Run portable firmware tests with address/undefined-behavior sanitizers."""
from pathlib import Path
import os
import subprocess
import tempfile

root = Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(prefix="vjled-firmware-tests-") as tmp:
    executable = str(Path(tmp) / "test_firmware")
    subprocess.run([
        os.environ.get("CXX", "c++"), "-std=c++11", "-Wall", "-Wextra", "-Werror",
        "-fsanitize=address,undefined", "-fno-omit-frame-pointer",
        "-I", str(root / "include"), str(root / "tests/test_firmware.cpp"),
        "-o", executable,
    ], check=True)
    subprocess.run([executable], check=True)
