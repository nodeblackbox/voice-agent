"""Start the local SearXNG instance in the foreground (the app normally does this itself).

    python search/run_searxng.py
"""
from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
SRC = HERE / "searxng-src"
PY = HERE / ".venv-searxng" / "Scripts" / "python.exe"
SETTINGS = HERE / "settings.local.yml"

if not PY.exists() or not SETTINGS.exists():
    sys.exit("SearXNG is not installed: run `python search/install_searxng.py` first")
env = {**os.environ, "SEARXNG_SETTINGS_PATH": str(SETTINGS), "PYTHONUNBUFFERED": "1"}
print(f"starting SearXNG from {SRC} (settings {SETTINGS.name})")
sys.exit(subprocess.call([str(PY), "-m", "searx.webapp"], cwd=str(SRC), env=env))
