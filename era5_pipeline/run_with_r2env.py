#!/usr/bin/env python3
"""Run a pipeline script with R2_* credentials loaded from r2.env.

Usage: .venv/bin/python run_with_r2env.py <script.py> [args...]

Exists so scripts that read R2 creds from the environment (download_cells.py
--upload-r2, r2_upload.py, ...) can be launched without `set -a; source
r2.env` shell gymnastics — the subprocess-env pitfall noted in the VM runbook.
"""
from __future__ import annotations

import os
import runpy
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent


def main() -> None:
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    env_file = SCRIPT_DIR / "r2.env"
    if env_file.exists():
        for line in env_file.read_text().splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip())
    target = sys.argv[1]
    sys.argv = sys.argv[1:]
    runpy.run_path(str(SCRIPT_DIR / target), run_name="__main__")


if __name__ == "__main__":
    main()
