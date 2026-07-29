"""Pull a SLICE of the ARCHIVE (ERA5-Land) data — the baseline half of the
archive<->forecast bias model. A slice in two senses: only the cells we have an
HRES forecast for, and only the rows inside the HRES overlap window.

The forecast side (pull_hres_all.py) writes hres-forecast/hres_{lat}_{lon}.csv.gz
to R2. This job is its mirror: for each of those cells it downloads our own
ERA5-Land archive object (archive/archive_{lat}_{lon}.csv.gz, already in R2) and
keeps ONLY the rows in the HRES overlap window. The archive .gz holds decades of
daily history; the bias study only compares it against HRES from 2024-03-01 on,
so we trim to that window to keep the local dataset small ("just the relevant
data") — pass --full to keep every row instead.

Unlike pull_hres_all.py this hits NO external API: the archive is already ours in
R2. It's a pure R2 read job, so it's fast, free (well inside the R2 free tier —
see the cost note below), and trivially resumable.

--local sources each cell's archive from the on-disk files download_cells.py
already wrote (data/era5-land/archive/) instead of R2 — no R2 auth, no network.
Only the cells actually downloaded locally are sliced; any cell in cells.csv
without a local archive is simply skipped (not a failure — a partial local mirror
is the normal case). Use this to build the training slice straight from a local
pull without touching R2.

OUTPUT — a local dir paralleling the HRES one (NOT re-uploaded to R2; this is a
research extract):
  scripts/bias_study/data/archive-overlap/archive_{lat}_{lon}.csv.gz
  columns: date,tmax_C,tmin_C,precip_mm,wind_max_ms  (unchanged archive schema)

CELL SET — by default the cells that HAVE an HRES object in R2 (so baseline and
forecast line up 1:1 for the join). Pass --all-cells to pull every cell in
cells.csv regardless, or --only NAME / --limit N to subset. With --local the cell
set is every cell in cells.csv (HRES filtering needs R2); cells without a local
archive file are skipped.

RESUME — a trimmed file already on disk is skipped (idempotent). Rerun after any
interruption; pass --overwrite to re-pull.

R2 COST — one GetObject (Class B) per cell + a couple of ListObjectsV2 (Class A)
to enumerate. ~10.4k cells => ~10.4k Class B ops, ~0.1% of R2's 10M/mo free
Class B allowance; egress is free on R2. So the whole grid costs effectively $0.

Auth — R2 S3 token in env (reuses era5_pipeline/r2.env), same as pull_hres_all.py:
  R2_ACCOUNT_ID R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY  [R2_BUCKET=weather-baseline]

Usage (from scripts/bias_study/, with the era5_pipeline venv):
  source ../era5_pipeline/.venv/bin/activate
  source ../era5_pipeline/r2.env
  python pull_archive_slice.py --only Chicago     # one-cell smoke test (by name)
  python pull_archive_slice.py --limit 20         # first 20 HRES cells
  python pull_archive_slice.py                     # all cells that have HRES in R2
  python pull_archive_slice.py --all-cells --full  # every cell, untrimmed
  python pull_archive_slice.py --local             # slice the LOCAL download, no R2
"""
from __future__ import annotations

import argparse
import csv
import gzip
import io
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, timedelta
from pathlib import Path

# Reuse the era5 pipeline's R2 client (get_bytes + list_sizes).
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "era5_pipeline"))
from r2_upload import R2Uploader  # noqa: E402

CELLS_CSV = HERE.parent.parent / "data" / "cells.csv"
# Where download_cells.py writes each cell's full-history archive on local disk —
# the source for --local (mirrors the R2 archive/ prefix read in the default mode).
LOCAL_ARCHIVE_DIR = HERE.parent.parent / "data" / "era5-land" / "archive"
OUT_DIR = HERE / "data" / "archive-overlap"
ARCHIVE_PREFIX = "archive"
HRES_PREFIX = "hres-forecast"
SCHEMA = ["date", "tmax_C", "tmin_C", "precip_mm", "wind_max_ms"]

# Keep these in lockstep with pull_hres_all.py so baseline and forecast cover the
# exact same window. The HRES native-9km archive only starts here; END_LAG keeps
# the far edge to a few days back so the comparison ends where HRES is settled.
HRES_ARCHIVE_START = date(2024, 3, 1)
END_LAG_DAYS = 10


def snap(coord: float) -> float:
    """Round to the canonical 0.1deg grid, matching worker cellStore.snap."""
    return round(coord * 10) / 10


def read_cells():
    """Yield (name, slat, slon) for each row in cells.csv, snapped."""
    with open(CELLS_CSV, newline="") as f:
        for row in csv.DictReader(f):
            yield row["name"], snap(float(row["lat"])), snap(float(row["lon"]))


def local_src_candidates(slat: float, slon: float) -> list[Path]:
    """Local archive filenames download_cells.py may have written for this
    snapped cell. download_cells.py's archive_name() formats the RAW
    (unsnapped) lat/lon straight from cells.csv, so a coordinate that snaps
    to exactly 0.0 but was stored as -0.0 (small negative lon/lat near the
    prime meridian/equator, e.g. Canary Wharf at 51.5,-0.0) keeps its sign in
    the on-disk filename (archive_51.5_-0.0.csv.gz), while snap() here
    normalizes it to 0.0 (Python's bare round() returns an int, which has no
    negative zero). Try both signs on any axis that snapped to zero."""
    lat_opts = ("0.0", "-0.0") if slat == 0 else (f"{slat:.1f}",)
    lon_opts = ("0.0", "-0.0") if slon == 0 else (f"{slon:.1f}",)
    return [LOCAL_ARCHIVE_DIR / f"archive_{la}_{lo}.csv.gz"
            for la in lat_opts for lo in lon_opts]


def trim_archive(body: bytes, start: str, end: str, full: bool) -> tuple[bytes, int]:
    """Return (gzipped csv bytes, kept row count) for the archive object body,
    keeping only rows whose date is within [start, end] (unless --full)."""
    buf = io.StringIO()
    w = csv.DictWriter(buf, fieldnames=SCHEMA)
    w.writeheader()
    kept = 0
    with gzip.open(io.BytesIO(body), "rt") as fh:
        for row in csv.DictReader(fh):
            d = row.get("date", "")
            if not full and (d < start or d > end):
                continue
            w.writerow({k: row.get(k, "") for k in SCHEMA})
            kept += 1
    out = io.BytesIO()
    with gzip.open(out, "wt", newline="") as gz:
        gz.write(buf.getvalue())
    return out.getvalue(), kept


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--all-cells", action="store_true",
                    help="pull every cell in cells.csv, not just those with an "
                         "HRES object in R2 (the default)")
    ap.add_argument("--local", action="store_true",
                    help="read each cell's archive from the on-disk files "
                         "download_cells.py wrote (data/era5-land/archive/) "
                         "instead of R2 — no R2 auth. Cells without a local "
                         "archive are skipped. Cell set is all of cells.csv.")
    ap.add_argument("--full", action="store_true",
                    help="keep the entire archive history instead of trimming to "
                         "the HRES overlap window")
    ap.add_argument("--only", help="substring match on cell name (smoke test)")
    ap.add_argument("--limit", type=int, help="only the first N cells")
    ap.add_argument("--overwrite", action="store_true",
                    help="re-pull cells already present locally instead of skipping")
    ap.add_argument("--workers", type=int, default=12,
                    help="parallel R2 downloads (default 12)")
    args = ap.parse_args()

    end = date.today() - timedelta(days=END_LAG_DAYS)
    start = HRES_ARCHIVE_START
    s, e = start.isoformat(), end.isoformat()

    cells = list(read_cells())
    if args.only:
        cells = [c for c in cells if args.only.lower() in c[0].lower()]
        if not cells:
            sys.exit(f"no cell name matches {args.only!r}")

    # --local reads local files only — no R2 client, and the HRES-in-R2 filter
    # (which needs an R2 listing) doesn't apply, so the cell set is all of cells.csv.
    up = None if args.local else R2Uploader()

    if not args.all_cells and not args.local:
        print("listing HRES cells in R2 to mirror…", flush=True)
        hres_keys = {
            k.split("/")[-1].removeprefix("hres_").removesuffix(".csv.gz")
            for k in up.list_sizes(f"{HRES_PREFIX}/")
            if k.endswith(".csv.gz")
        }
        cells = [c for c in cells if f"{c[1]:.1f}_{c[2]:.1f}" in hres_keys]
        print(f"{len(hres_keys)} HRES cells in R2 -> {len(cells)} matched in cells.csv")

    if args.limit:
        cells = cells[: args.limit]

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    window = "full history" if args.full else f"{s} .. {e}"
    source = f"local disk ({LOCAL_ARCHIVE_DIR})" if args.local else "R2"
    print(f"source: {source}\nwindow: {window}   {len(cells)} cells   "
          f"{args.workers} workers\n", flush=True)

    n_ok = n_skip = n_fail = n_nolocal = n_empty = 0
    t0 = time.time()

    def fetch(cell):
        name, slat, slon = cell
        key = f"{slat:.1f}_{slon:.1f}"
        dest = OUT_DIR / f"archive_{key}.csv.gz"
        if dest.exists() and not args.overwrite:
            return ("skip", name, key, 0)
        if args.local:
            src = next((p for p in local_src_candidates(slat, slon) if p.exists()),
                       None)
            if src is None:
                return ("nolocal", name, key, 0)  # not downloaded — expected, skip
            body = src.read_bytes()
        else:
            body = up.get_bytes(f"{ARCHIVE_PREFIX}/archive_{key}.csv.gz")
            if body is None:
                return ("fail", name, key, 0)
        blob, kept = trim_archive(body, s, e, args.full)
        # A local archive can be a stale PARTIAL (download_cells.py writes years
        # incrementally), so its history may not reach the overlap window at all —
        # trimming then yields a header-only slice. Never write that: it's useless
        # for training and, worse, --overwrite would clobber a good slice already
        # pulled from R2 with an empty one. (Not applied to --full, which is a
        # deliberate whole-history dump.)
        if kept == 0 and not args.full:
            return ("empty", name, key, 0)
        dest.write_bytes(blob)
        return ("ok", name, key, kept)

    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        futs = {ex.submit(fetch, c): c for c in cells}
        for i, fut in enumerate(as_completed(futs), 1):
            status, name, key, kept = fut.result()
            if status == "ok":
                n_ok += 1
                print(f"  [{i}/{len(cells)}] {name[:28]:28s} {key:14s} OK  {kept} rows",
                      flush=True)
            elif status == "skip":
                n_skip += 1
            elif status == "nolocal":
                n_nolocal += 1  # not downloaded locally — expected, silent
            elif status == "empty":
                n_empty += 1  # local file has nothing in the window — skip, silent
            else:
                n_fail += 1
                print(f"  [{i}/{len(cells)}] {name[:28]:28s} {key:14s} "
                      f"FAIL (no archive object in R2)", flush=True)

    tail = f" nolocal={n_nolocal} empty={n_empty}" if args.local else ""
    print(f"\ndone. ok={n_ok} skip={n_skip} fail={n_fail}{tail}  "
          f"({(time.time() - t0) / 60:.1f} min)  -> {OUT_DIR}")
    return 1 if n_fail else 0


if __name__ == "__main__":
    raise SystemExit(main())
