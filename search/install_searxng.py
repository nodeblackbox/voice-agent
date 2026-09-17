"""Reproducible SearXNG install for Windows without Docker. Standard library only.

    python search/install_searxng.py [--ref master] [--force]

Idempotent steps:
  1. download the SearXNG source archive for --ref (a branch, tag or commit) from GitHub
  2. extract to search/searxng-src, skipping filenames that are illegal on NTFS
  3. guard the Unix-only imports (pwd/grp/fcntl/resource/termios/pty) so searx imports on Windows
  4. create search/.venv-searxng (Python 3.11 via uv) and install searxng-src/requirements.txt
  5. write search/settings.local.yml from settings.template.yml with a fresh secret_key
The app starts it on demand (Settings > Web search) with SEARXNG_SETTINGS_PATH=search/settings.local.yml.
"""
from __future__ import annotations

import argparse
import io
import pathlib
import re
import secrets
import shutil
import subprocess
import sys
import urllib.request
import zipfile

HERE = pathlib.Path(__file__).resolve().parent
SRC = HERE / "searxng-src"
VENV = HERE / ".venv-searxng"
TEMPLATE = HERE / "settings.template.yml"
LOCAL = HERE / "settings.local.yml"
UNIX_ONLY = ("pwd", "grp", "fcntl", "resource", "termios", "pty")


def fetch_source(ref: str) -> None:
    url = f"https://github.com/searxng/searxng/archive/{ref}.zip"
    print("downloading", url)
    with urllib.request.urlopen(url, timeout=180) as r:  # noqa: S310
        data = r.read()
    z = zipfile.ZipFile(io.BytesIO(data))
    if SRC.exists():
        shutil.rmtree(SRC)
    skipped = 0
    for m in z.infolist():
        parts = m.filename.split("/", 1)
        if len(parts) < 2 or not parts[1]:
            continue
        rel = parts[1]
        if any(ch in rel for ch in ':*?"<>|'):
            skipped += 1
            continue
        out = SRC / rel
        if m.is_dir():
            out.mkdir(parents=True, exist_ok=True)
            continue
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(z.read(m))
    print(f"extracted to {SRC} (skipped {skipped} NTFS-illegal names)")


def patch_unix_imports() -> None:
    pat = re.compile(r"^(import (%s))\s*$" % "|".join(UNIX_ONLY), re.M)
    n = 0
    for p in (SRC / "searx").rglob("*.py"):
        s = p.read_text(encoding="utf-8")
        new = pat.sub(r"try:\n    \1\nexcept ImportError:  # Windows\n    \2 = None", s)
        if new != s:
            p.write_text(new, encoding="utf-8")
            n += 1
    print(f"{n} file(s) patched for Windows imports")


def make_venv() -> None:
    py = VENV / "Scripts" / "python.exe"
    if not py.exists():
        subprocess.check_call(["uv", "venv", "--python", "3.11", str(VENV)])
    subprocess.check_call(["uv", "pip", "install", "--python", str(py), "-r", str(SRC / "requirements.txt")])
    subprocess.check_call([str(py), "-c", "import searx; print('searx import ok')"], cwd=str(SRC))


def write_settings(force: bool) -> None:
    if LOCAL.exists() and not force:
        print(f"keeping existing {LOCAL.name}")
        return
    text = TEMPLATE.read_text(encoding="utf-8").replace("__GENERATED__", secrets.token_hex(32))
    LOCAL.write_text(text, encoding="utf-8")
    print(f"wrote {LOCAL.name} with a fresh secret_key")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--ref", default="master", help="branch, tag or commit of searxng/searxng to install")
    ap.add_argument("--force", action="store_true", help="re-download the source and regenerate settings.local.yml")
    a = ap.parse_args()
    if a.force or not (SRC / "searx" / "webapp.py").exists():
        fetch_source(a.ref)
        patch_unix_imports()
    make_venv()
    write_settings(a.force)
    print("done. The app will start SearXNG on demand; or run search/run_searxng.py to start it manually.")
    sys.exit(0)
