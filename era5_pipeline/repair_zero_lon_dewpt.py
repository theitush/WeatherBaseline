#!/usr/bin/env python3
"""Repair the eight lon=-0.0 archives the 2026-08 d2m backfill wrote to the
wrong key, by merging their dew point into the live `_0.0` object.

WHAT HAPPENED.  cells.csv stores eight cells with a longitude of -0.0 (Canary
Wharf, Tottenham, Beckenham, Enfield Town, Castello de la Plana, Gao, Sinkasse,
Tulaku).  On 2026-08-28 those cells' R2 archives were renamed from
`archive_{lat}_-0.0.csv.gz` to the `_0.0` keys the Worker and frontend actually
request, and `cell_keys.coord_str` became the pipeline's one sign-normalising
formatter.  The d2m backfill ran LATER that day (12:19 rename, 21:35 backfill)
from a checkout that predates `cell_keys`, so `download_cells.py` still built
`archive_{lat:.1f}_{lon:.1f}` -> `_-0.0`.  Finding no series at that key it
took the "no data at all" path and wrote a FRESH two-column
`date,dewpt_mean_C` object there, while the live `_0.0` object it should have
merged into kept its five columns and no dew point.

The dew point itself was correct and complete -- 27,971 rows per cell, the same
dates as the live archive, zero nulls.  Only the key was wrong.  So this script
appends it as the sixth column and drops the stray; it does NOT re-download.

The cause is fixed: download_cells.py now formats every key through cell_keys,
so a rerun of the backfill lands on `_0.0`.  This script is kept as the record
of the data repair, and is safe to rerun -- a cell whose live archive already
carries the column, or whose stray is gone, is reported and skipped.

Usage (from era5_pipeline/):
  set -a && source r2.env && set +a
  python repair_zero_lon_dewpt.py            # report what it would do
  python repair_zero_lon_dewpt.py --apply
"""
from __future__ import annotations

import argparse
import gzip
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from cell_keys import tier_key  # noqa: E402
from download_cells import ARCHIVE_COLUMNS  # noqa: E402
from r2_upload import R2Uploader  # noqa: E402

# The eight cells cells.csv stores at lon -0.0.
ZERO_LON_LATS = [5.7, 11.1, 16.3, 40.0, 51.4, 51.5, 51.6, 51.7]
COLUMN = "dewpt_mean_C"
BASE_COLUMNS = [c for c in ARCHIVE_COLUMNS if c != COLUMN]


def repair(up: R2Uploader, lat: float, *, apply: bool) -> str:
    live_key = tier_key("archive", lat, 0.0)          # normalised -> `_0.0`
    stray_key = f"archive/archive_{lat:.1f}_-0.0.csv.gz"  # the bug's own spelling

    live_raw = up.get_bytes(live_key)
    if live_raw is None:
        return f"live object missing ({live_key}) — nothing to repair"
    live = gzip.decompress(live_raw).decode()
    live_lines = live.split("\n")
    trailing_nl = live_lines[-1] == ""
    if trailing_nl:
        live_lines.pop()
    header = live_lines[0].rstrip("\r").split(",")
    if COLUMN in header:
        return "already has the column — skipped"
    if header != BASE_COLUMNS:
        return f"unexpected header {header} — skipped"

    stray_raw = up.get_bytes(stray_key)
    if stray_raw is None:
        return f"NO dew point and no stray at {stray_key} — needs a real backfill"
    stray_lines = [ln for ln in gzip.decompress(stray_raw).decode().split("\n") if ln]
    if stray_lines[0].rstrip("\r").split(",") != ["date", COLUMN]:
        return f"stray header is not date,{COLUMN} — skipped"
    dew = dict(ln.rstrip("\r").split(",", 1) for ln in stray_lines[1:])

    # Append the column, leaving every existing byte of every row untouched. A
    # date the stray doesn't cover raises KeyError and aborts before any write.
    out = [live_lines[0].rstrip("\r") + "," + COLUMN]
    for line in live_lines[1:]:
        line = line.rstrip("\r")
        out.append(line + "," + dew[line.split(",", 1)[0]])
    if len(dew) != len(out) - 1:
        return f"row mismatch: {len(dew)} dew rows vs {len(out) - 1} archive rows"
    text = "\n".join(out) + ("\n" if trailing_nl else "")

    if not apply:
        return f"would merge {len(out) - 1} rows and delete the stray"
    with tempfile.TemporaryDirectory() as td:
        path = Path(td) / Path(live_key).name
        with gzip.open(path, "wt", newline="") as fh:
            fh.write(text)
        up.upload_file(path, live_key)          # keeps the tier's serve headers
    if gzip.decompress(up.get_bytes(live_key)).decode() != text:
        raise SystemExit(f"round-trip mismatch on {live_key} — stray NOT deleted")
    up.delete_object(stray_key)
    return f"merged {len(out) - 1} rows, stray deleted"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--apply", action="store_true",
                    help="write to R2 (default: report only)")
    args = ap.parse_args()
    up = R2Uploader()
    for lat in ZERO_LON_LATS:
        print(f"{lat:6.1f}_0.0  {repair(up, lat, apply=args.apply)}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
