"""End to end with the real models: start the sidecar, replay recordings, expect finals and a barge-in cut.

Skipped unless EAR_INTEGRATION=1 (needs the GPU stack and the wav files from the old project).
"""
from __future__ import annotations

import os
import re
import subprocess
import sys
import time
from pathlib import Path

import pytest

SIDECAR = Path(__file__).resolve().parent.parent
WAV = Path(os.environ.get("EAR_WAV", r"D:\Downloads\voiceAgent\audio\handy-1787878656.wav"))
BARGE = Path(os.environ.get("EAR_BARGE_WAV", r"D:\Downloads\voiceAgent\audio\handy-1787881187.wav"))

pytestmark = pytest.mark.integration


@pytest.mark.skipif(os.environ.get("EAR_INTEGRATION") != "1", reason="set EAR_INTEGRATION=1 to run against real models")
def test_replay_with_barge_in():
    if not WAV.exists() or not BARGE.exists():
        pytest.skip("recordings not found")
    proc = subprocess.Popen([sys.executable, "-m", "ear", "--port", "0"], cwd=SIDECAR, stdout=subprocess.PIPE,
                            stderr=subprocess.DEVNULL, text=True)
    try:
        line = proc.stdout.readline() if proc.stdout else ""
        m = re.match(r"EAR_PORT (\d+)", line)
        assert m, f"no EAR_PORT line, got {line!r}"
        result = subprocess.run(
            [sys.executable, str(SIDECAR / "tests" / "replay_client.py"), "--port", m.group(1), str(WAV), "--bargein", str(BARGE), "--fast"],
            cwd=SIDECAR, capture_output=True, text=True, timeout=300)
        assert result.returncode == 0, result.stdout + result.stderr
        assert "bargein stages:" in result.stdout and "cut" in result.stdout
    finally:
        proc.kill()
        proc.wait(timeout=10)
        time.sleep(0.2)
