"""Download ERA5-Land daily metrics for selected cells — batched, parallel, resumable.

Batched, parallel, resumable. Inputs (data/cells.csv) and outputs
(data/era5-land/archive/archive_{lat}_{lon}.csv.gz, schema
date,tmax_C,tmin_C,precip_mm,wind_max_ms,dewpt_mean_C) — archives merge by date
AND by column. Design notes:

1. BATCHED TIME SPANS (was: one .compute() per year).
   The store's time chunks are 1440 h = 60 days, NOT aligned to calendar years.
   A single year straddles ~7 chunks, and each boundary chunk is shared with the
   neighbouring year — so year-by-year RE-FETCHES every boundary chunk. Fetching
   a multi-year span reads each 60-day chunk exactly once.
   --batch-years bounds the span so memory stays sane (a span's t2m array is
   span_years * 8760 * 50 * 100 * 4 bytes; ~20 yr ≈ 3.5 GB/var per tile).

2. PARALLEL FETCHES. The 5 stored vars (t2m, tp, d2m, u10, v10) are
   independent network-bound .compute()s, so we fetch them concurrently (thread
   pool). Everything else is derived for free: tmax/tmin from t2m, wind speed
   from u10+v10, the daily-mean dew point from d2m. --vars restricts a run to a
   SUBSET of the stored variables — the backfill of one new column fetches only
   the variable that column derives from; its frames then carry only that
   column and the merge keeps everything else the archive already holds.
   --parallel-tiles additionally runs whole tiles concurrently. The store drops
   connections under load, so keep the worker count modest; the per-step retry
   covers the occasional drop.

3. WHOLE LOCAL DAYS ONLY. Days are bucketed by the cell's solar-local clock, so
   each span is fetched with a one-day halo and any bucket still short of 24
   hours (the store's newest day, mid-accumulation) is dropped rather than
   written — a partial day merges over a complete one and silently corrupts it.

4. RESUME + MONTHLY TOP-UP. Before fetching, we compute how COMPLETE each year
   already is for each tile — its count of rows carrying COMPLETENESS_COLUMN
   (the newest archive column), not merely whether the year is present — and
   fetch only the years still short of a full year of days. Counting only rows
   that carry the newest column is what makes a column backfill resumable: an
   archive written before that column existed reads as 0% complete and is
   refetched exactly once, then behaves as before. That one
   rule catches a wholly-absent year, an interior gap (a hole from an interrupted
   run), AND a year that's present but nearly empty (e.g. a lone stray row old code
   left behind — a bare year-set check wrongly treated that as "have"). The source
   of truth is the local disk, OR (with --upload-r2) the R2 bucket, since the VM's
   disk is ephemeral: a fresh box has no local archives but R2 still holds what
   earlier runs produced. R2 coverage is read cheaply — one object listing gives
   every cell archive's size, then one representative cell per tile is downloaded
   and its per-year row counts checked.
   A year is "complete" when a past year has ~365/366 rows and the trailing
   (current) store year has caught up to the store's newest day. The trailing year
   is thus re-fetched automatically whenever the tile lags the store (ERA5-Land
   lags ~6 days and keeps appending): it reads as incomplete until it catches up.
   That IS the monthly refresh — rerun the same command and every tile that's
   fallen behind gets its last days merged in (idempotent merge-by-date), while
   up-to-date tiles are skipped. No flag needed. --no-resume forces a full refetch.

Usage:
  source .venv/bin/activate
  python download_cells.py --tile 11_26 --year 2020          # one span, one year
  python download_cells.py --tile 17_10,6_3 --start-year 1950 # resume missing yrs
  python download_cells.py --start-year 1950 --batch-years 20 --parallel-tiles 2
  python download_cells.py --start-year 1950 --vars d2m    # dew-point backfill
"""
from __future__ import annotations

import argparse
import calendar
import csv
import os
import threading
import time
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime
from pathlib import Path

import numpy as np

from cell_keys import coord_str, tier_name

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
CELLS_CSV = REPO / "data" / "cells.csv"
OUT_DIR = REPO / "data" / "era5-land" / "archive"

# Hourly ERA5-Land ARCO zarr store on EarthDataHub (Zarr v3, July 2026 revamp;
# same 0.1deg grid and no-Antarctica crop as before, new chunking). The legacy
# Zarr v2 store (era5/reanalysis-era5-land-no-antartica-v0.zarr, 2880x64x64
# chunks) is FROZEN at 2026-05-31 — monthly updates land only in this store.
ZARR_URL = "https://data.earthdatahub.destine.eu/era5/era5-land-v0.zarr"

# Stored variables we need. Derived metrics (tmax/tmin from t2m, wind speed from
# u10+v10, daily-mean dew point from d2m) cost nothing extra — the cost is per
# stored variable fetched. `d2m` (2 m dewpoint, kelvin) arrived 2026-08 for the
# dew-point metric; verified present in the v3 store by the preflight in main().
ZARR_VARS = ["t2m", "tp", "d2m", "u10", "v10"]

# Canonical archive column order. New columns are appended AFTER the shipped
# ones, and every reader (frontend tieredData.ts, worker cellStore.js, the bias
# study, the analytics notebooks) parses by header NAME, so widening the schema
# is inert for anything that doesn't ask for the new column.
ARCHIVE_COLUMNS = [
    "date", "tmax_C", "tmin_C", "precip_mm", "wind_max_ms", "dewpt_mean_C",
]

# Which stored variables each archive column needs. A run whose --vars lacks a
# column's inputs simply doesn't produce that column.
COLUMN_INPUTS = {
    "tmax_C": ("t2m",),
    "tmin_C": ("t2m",),
    "precip_mm": ("tp",),
    "wind_max_ms": ("u10", "v10"),
    "dewpt_mean_C": ("d2m",),
}

# Store units -> archive units, per daily column. Temperatures arrive in kelvin,
# precipitation in metres; wind is already m/s.
_TO_ARCHIVE_UNITS = {
    "tmax_C": lambda v: v - 273.15,
    "tmin_C": lambda v: v - 273.15,
    "precip_mm": lambda v: v * 1000.0,
    "wind_max_ms": lambda v: v,
    "dewpt_mean_C": lambda v: v - 273.15,
}

# Resume counts a year as covered only through rows that carry THIS column —
# the newest one — so an archive from before it existed reads as empty and is
# refetched once (the column backfill's crash-resume, no ledger needed). Passed
# to r2_upload.read_coverage for the R2-sourced half of the same check.
COMPLETENESS_COLUMN = "dewpt_mean_C"

# The store chunks 50 (lat) x 100 (lon) cells per spatial chunk. tile_id
# encodes the chunk index, so one tile == one 5x10deg chunk. Must match
# select_cells.
TILE_LAT_CELLS = 50
TILE_LON_CELLS = 100

# Hourly steps per year (8760 h; leap years are ~0.03% more — ignore for an
# estimate). One var's in-memory array over an N-year span is
# HOURS_PER_YEAR * N * 50 * 100 * float32. Used only for the RAM warning.
HOURS_PER_YEAR = 8760
# Concurrent var fetches each hold their full hourly array at once; the daily
# resample + sqrt(u^2+v^2) allocate transient copies on top. ~1.5x covers it.
_RAM_OVERHEAD = 1.5

# Generous per-request HTTP ceiling — a cold ~29 MB chunk can be slow.
HTTP_TIMEOUT_S = 2400

# Default span per .compute(). ~20 yr ≈ 3.5 GB/var in memory per tile — bounded,
# while still reading each 60-day time-chunk only once across the span.
DEFAULT_BATCH_YEARS = 20

_T0 = time.time()
# log() is called from worker threads when --parallel-tiles > 1; serialise the
# print so lines from different tiles don't interleave mid-string.
_LOG_LOCK = threading.Lock()


def log(msg: str) -> None:
    """Timestamped log: wall-clock time + elapsed seconds since start."""
    now = datetime.now().strftime("%H:%M:%S")
    with _LOG_LOCK:
        print(f"  [{now} | +{time.time() - _T0:7.1f}s] {msg}", flush=True)


def fmt_dur(seconds: float) -> str:
    """Human-friendly duration, e.g. '3m 12s'."""
    m, s = divmod(int(seconds), 60)
    return f"{m}m {s:02d}s" if m else f"{s}s"


# ANSI colors for the RAM warning — disabled when stdout isn't a TTY (piping to
# a log file) or NO_COLOR is set, so redirected logs stay plain text.
def _colors_enabled() -> bool:
    import os
    import sys
    return sys.stdout.isatty() and "NO_COLOR" not in os.environ


def _c(text: str, code: str) -> str:
    """Wrap text in an ANSI SGR code if colors are enabled, else return as-is."""
    return f"\033[{code}m{text}\033[0m" if _colors_enabled() else text


def _available_ram_gb() -> float | None:
    """Free RAM in GB, or None if it can't be determined on this platform.

    Reads /proc/meminfo MemAvailable (Linux); falls back to psutil if present.
    None means "couldn't tell" — we then warn unconditionally rather than guess.
    """
    try:
        with open("/proc/meminfo") as f:
            for line in f:
                if line.startswith("MemAvailable:"):
                    return int(line.split()[1]) / 1e6  # kB -> GB
    except OSError:
        pass
    try:
        import psutil
        return psutil.virtual_memory().available / 1e9
    except Exception:  # noqa: BLE001
        return None


def warn_ram(batch_years: int, var_workers: int, parallel_tiles: int,
             n_vars: int | None = None) -> None:
    """Estimate peak RAM for the chosen settings and warn if it's tight.

    `n_vars` is the number of variables actually fetched (--vars); no more than
    that many fetches can be in flight, however many --var-workers were asked.

    `batch_years` is the SPAN actually fetched — min(--batch-years, years asked
    for) — not the flag, so a single-year top-up isn't costed as a 20-year pull.

    Peak ≈ one var's hourly array (HOURS_PER_YEAR * batch_years * 50*100 * 4 B)
    held once per concurrent var, times concurrent tiles, times overhead for the
    transient resample/sqrt copies. Compared against MemAvailable so it's loud on
    a small remote box, where an OOM would silently kill the run mid-fetch.
    """
    if n_vars is not None:
        var_workers = max(1, min(var_workers, n_vars))
    per_var_gb = (HOURS_PER_YEAR * batch_years
                  * TILE_LAT_CELLS * TILE_LON_CELLS * 4 / 1e9)
    peak_gb = per_var_gb * var_workers * parallel_tiles * _RAM_OVERHEAD
    avail = _available_ram_gb()

    print(f"  RAM   : ~{peak_gb:.1f} GB peak estimate "
          f"({per_var_gb:.1f} GB/var x {var_workers} var-workers "
          f"x {parallel_tiles} tile(s) x {_RAM_OVERHEAD:g} overhead)")
    if avail is None:
        print(_c("  !! could not read available RAM — make sure the box has at "
                 f"least ~{peak_gb:.0f} GB free, or lower --batch-years / "
                 "--var-workers / --parallel-tiles.", "33"))  # yellow
        return
    if peak_gb > avail * 0.9:
        print(f"          {_c(f'{avail:.1f} GB available now', '1;31')}")  # bold red
        # halve batch-years until the estimate fits, as a concrete suggestion
        suggest = batch_years
        while suggest > 1 and (peak_gb * suggest / batch_years) > avail * 0.9:
            suggest //= 2
        bar = _c("  " + "!" * 60, "1;31")
        print(bar)
        print(_c("  !! WARNING: peak RAM estimate is close to or exceeds "
                 "available RAM —", "1;31"))
        print(_c("  !!          the run may be OOM-killed mid-fetch.", "1;31"))
        print(_c("  !! Try --batch-years {}".format(max(1, suggest))
                 + (" and/or --var-workers 1" if var_workers > 1 else "")
                 + (" and/or --parallel-tiles 1" if parallel_tiles > 1 else "")
                 + ".", "1;31"))
        print(bar)
    else:
        print(f"          {_c(f'{avail:.1f} GB available now — OK', '32')}")  # green


# Transient network errors worth retrying — EarthDataHub object storage
# occasionally drops a connection mid-chunk. A plain re-fetch almost always works.
_RETRY_HINTS = (
    "payload is not completed",
    "not enough data to satisfy content length",
    "contentlengtherror",
    "server disconnected",
    "connection reset",
    "timeout",
    # Server-side 5xx, both from the zarr store and from R2. Seen live
    # 2026-08-25: R2 answered a burst of GetObject with InternalError for ~30 s.
    # Matched on words, not bare status numbers, so a message that merely
    # contains "500" can't be mistaken for one.
    "internalerror",
    "internal error",
    "slowdown",
    "serviceunavailable",
    "service unavailable",
    "bad gateway",
    "502",
    "503",
    "504",
)
_MAX_RETRIES = 8
# Attempts for the per-cell R2 merge-base GET, backing off 2/4/8/16 s (~30 s
# total). Sized against a real burst: on 2026-08-25 R2 answered GetObject with
# InternalError for ~2.5 min and 18 cells were skipped. 30 s rides out the short
# blips; a longer outage still skips the cell, which is the safe outcome and a
# repairable one — better than every one of 8,727 cells stalling for minutes.
_R2_BASE_RETRIES = 5


def _is_transient(err: Exception) -> bool:
    msg = f"{type(err).__name__}: {err}".lower()
    return any(h in msg for h in _RETRY_HINTS)


def _compute_step(name: str, da):
    """Compute one lazy DataArray, retrying on transient network errors.

    On a dropped connection it backs off and re-fetches the same chunks (no extra
    request budget beyond the failed attempt).
    """
    for attempt in range(1, _MAX_RETRIES + 1):
        suffix = "" if attempt == 1 else f" (attempt {attempt}/{_MAX_RETRIES})"
        log(f"    computing {name}{suffix} ... (fetching chunks)")
        t0 = time.time()
        try:
            out = da.compute()
            log(f"    {name} done in {fmt_dur(time.time() - t0)}")
            return out
        except Exception as e:  # noqa: BLE001
            if not _is_transient(e) or attempt == _MAX_RETRIES:
                raise
            backoff = min(60, 5 * 2 ** (attempt - 1))
            log(f"    !! {name} transient error after {fmt_dur(time.time() - t0)}: "
                f"{type(e).__name__} — retrying in {backoff}s")
            time.sleep(backoff)
    raise RuntimeError(f"unreachable: {name} retries exhausted")


def load_cells() -> list[dict]:
    """Read cells.csv into a list of dicts (cell_id, lat, lon, tile_id, ...)."""
    with CELLS_CSV.open() as f:
        rows = list(csv.DictReader(f))
    for r in rows:
        r["cell_id"] = int(r["cell_id"])
        r["lat"] = float(r["lat"])
        r["lon"] = float(r["lon"])
    return rows


def group_by_tile(cells: list[dict]) -> dict[str, list[dict]]:
    """Group cells by tile_id so each 5x10deg zarr tile is fetched only once."""
    by_tile: dict[str, list[dict]] = defaultdict(list)
    for c in cells:
        by_tile[c["tile_id"]].append(c)
    return by_tile


# Scalar (0-dim) coordinates the store attaches to every variable. They carry
# constant metadata we don't use, but each is its own zarr chunk that xarray
# re-fetches on EVERY .compute(). Dropping them at open time saves ~3 requests
# per variable per fetch.
_DROP_COORDS = ["number", "surface", "depthBelowLandLayer"]


def open_store():
    """Open the hourly zarr store lazily, dropping the unused scalar coords."""
    import aiohttp
    import xarray as xr

    ds = xr.open_dataset(
        ZARR_URL,
        storage_options={
            "client_kwargs": {
                "trust_env": True,
                "timeout": aiohttp.ClientTimeout(total=HTTP_TIMEOUT_S),
            },
        },
        chunks={},
        engine="zarr",
    )
    present = [c for c in _DROP_COORDS if c in ds.coords]
    if present:
        ds = ds.drop_vars(present)
    return ds


def store_latest_date(ds) -> date:
    """The newest calendar date the store currently holds.

    ERA5-Land lags the real date by ~6 days and keeps appending, so this creeps
    forward between runs. Read once after opening the store; a tile whose archive
    ends before this gets its trailing year topped up, one that reaches it is left
    alone. The time coordinate is a small 1-D array, so reading its max is cheap.
    """
    import pandas as pd

    time_name = "valid_time" if "valid_time" in ds.coords else "time"
    return pd.Timestamp(ds[time_name].max().values).date()


# --------------------------------------------------------------------------- #
# Resume: which years does a tile already have?
# --------------------------------------------------------------------------- #
class R2Resume:
    """Source-of-truth for resume sourced from R2 instead of the VM's disk.

    The VM's local archives are ephemeral (a fresh or wiped box has none), but R2
    already holds what earlier runs produced — so when uploading we ask R2, not
    the disk, which tiles are done. Built once up front with one ListObjectsV2,
    which gives every archive key's size for free (no downloads) — used to find a
    tile's smallest cell and to detect missing cells.
    """

    def __init__(self, uploader):
        self.up = uploader
        # key (e.g. "archive/archive_32.1_34.8.csv.gz") -> byte size
        self.sizes = uploader.list_sizes("archive/")
        log(f"  R2 resume: {len(self.sizes)} archive object(s) already in "
            f"bucket '{uploader.bucket}'")

    def coverage_for_tile(
        self, tile_cells: list[dict]
    ) -> tuple[dict[int, int], date | None]:
        """(per-year row counts R2 has, newest date) for this whole tile.

        A tile is written all-cells-together per span, so every cell in a tile
        shares the same coverage — so we inspect exactly ONE cell. We can't infer
        completeness from file size (a cell missing only a single recent year is
        barely smaller than a complete one, and a tiny-but-complete desert cell is
        smaller than a large partial one), so we read the cell's actual per-year row
        counts. We pick the SMALLEST present cell as the one to read — it's the
        cheapest download and, since all cells share coverage, representative. The
        caller (missing_years) judges each year's counts against the store's newest
        day, so a nearly-empty or lagging year is caught, not just a wholly-absent
        one.

        Any cell key missing -> ({}, None): tile not safely done, refetch it.
        """
        smallest_key: str | None = None
        smallest_size = None
        for c in tile_cells:
            key = f"archive/{archive_name(c['lat'], c['lon'])}"
            size = self.sizes.get(key)
            if size is None:
                return {}, None  # a missing cell -> tile not safely done
            if smallest_size is None or size < smallest_size:
                smallest_size, smallest_key = size, key
        if smallest_key is None:
            return {}, None
        return self.up.read_coverage(smallest_key, COMPLETENESS_COLUMN)


def local_coverage_for_tile(
    tile_cells: list[dict],
) -> tuple[dict[int, int], date | None]:
    """(per-year covered-row counts across the tile, newest date) on local disk.

    A row counts only if it carries COMPLETENESS_COLUMN. That is what makes a
    column backfill resumable without an --overwrite ledger: an archive written
    before the column existed has no such rows, so it reads as 0% complete and is
    refetched exactly once, while a crash mid-backfill resumes at the first
    year-span that never landed. Once the grid is backfilled the rule is
    invisible — every row a top-up writes carries the column, so the counts are
    the plain daily-row counts they always were.

    For each year we take the MIN row count across the tile's cells: a year is only
    as complete as its least-covered cell, so a year fully present in some cells but
    missing (or nearly empty) in another counts as incomplete for the tile and is
    refetched. (A tile fetch writes all cells together, so coverage is normally
    uniform; the min makes an interrupted, non-uniform tile self-heal.) The caller
    (missing_years) judges completeness from these counts against the store's newest
    day, so a wholly-absent year, an interior hole, AND a present-but-nearly-empty
    year are all caught — not just the trailing tail. The newest date is the MIN of
    the cells' max dates — the tile is only as caught-up as its least-complete cell.

    Returns ({}, None) if any cell file is absent, empty, or predates the column.
    """
    per_cell_counts: list[dict[int, int]] = []
    max_dates: list[date] = []
    for c in tile_cells:
        path = OUT_DIR / archive_name(c["lat"], c["lon"])
        if not path.exists():
            return {}, None  # a missing cell file means nothing is safely done
        dates = covered_dates(path, COMPLETENESS_COLUMN)
        if dates.empty:
            return {}, None
        per_cell_counts.append(
            {int(y): int(n) for y, n in dates.dt.year.value_counts().items()}
        )
        max_dates.append(dates.max().date())
    if not per_cell_counts:
        return {}, None
    all_years = set().union(*(set(d) for d in per_cell_counts))
    min_counts = {y: min(d.get(y, 0) for d in per_cell_counts) for y in all_years}
    return min_counts, min(max_dates)


def covered_dates(source, column: str | None, **read_kwargs):
    """The dates of an archive's rows that carry `column` (all rows if None).

    `source` is anything pandas.read_csv accepts (a path, a text handle) plus
    optional read kwargs (e.g. compression). Reads the header first: `usecols`
    on an archive that predates the column would raise rather than report
    "nothing covered here", which is the answer we want. Shared by the local
    resume here and the R2 resume in r2_upload.read_coverage so both halves
    apply the identical rule.
    """
    import pandas as pd

    if column is None:
        frame = pd.read_csv(source, usecols=["date"], **read_kwargs)
        return pd.to_datetime(frame["date"])
    if hasattr(source, "seek"):
        source.seek(0)
    header = pd.read_csv(source, nrows=0, **read_kwargs).columns
    if column not in header:
        return pd.to_datetime(pd.Series([], dtype="object"))
    if hasattr(source, "seek"):
        source.seek(0)
    covered = pd.read_csv(source, usecols=["date", column], **read_kwargs)
    return pd.to_datetime(covered.loc[covered[column].notna(), "date"])


def _complete_years(year_counts: dict[int, int], latest_date: date | None,
                    tol: int = 5) -> set[int]:
    """Years present AND essentially complete, given the store's newest day.

    `year_counts` maps year -> daily-row count (see read_coverage /
    local_coverage_for_tile). A year is "complete" when it holds close to a full
    year of days:
      - a PAST year (< the store's newest year): >= 365/366 rows (minus `tol` to
        absorb the ±1-day slack from bucketing on the LOCAL solar day);
      - the TRAILING/current store year: >= the store's day-of-year so far. It is
        legitimately partial (ERA5-Land lags ~6 days), so we require only that the
        cell caught up to the newest day the store holds, not a full year.
    `tol` (days) both absorbs local-day boundary slack and keeps a just-fetched
    trailing year from re-fetching every run. A year present but well short of its
    expected days — a lone stray row, an interior hole, or a lagging tail — is NOT
    complete, so missing_years puts it back in the fetch list.

    latest_date None (couldn't read the store) -> fall back to presence (any row),
    the old behaviour, so a store-read failure can't trigger a full refetch.
    """
    if latest_date is None:
        return {int(y) for y, n in year_counts.items() if n > 0}
    newest_year = latest_date.year
    doy = latest_date.timetuple().tm_yday
    complete: set[int] = set()
    for y, n in year_counts.items():
        if y < newest_year:
            expected = 366 if calendar.isleap(int(y)) else 365
        elif y == newest_year:
            expected = doy
        else:
            continue  # beyond the store's newest year — nothing to have
        if n >= expected - tol:
            complete.add(int(y))
    return complete


def missing_years(tile_cells: list[dict], years: list[int], resume: bool,
                  r2_resume: "R2Resume | None",
                  latest_date: date | None) -> list[int]:
    """The subset of `years` still to fetch for this tile.

    Resume off: fetch all requested years. Resume on: keep only years that aren't
    already COMPLETE in the tile (source of truth = R2 when `r2_resume` is given,
    since the VM's disk is ephemeral, else the local disk).

    Completeness is row-count based, not mere presence (see `_complete_years`), and
    only rows carrying COMPLETENESS_COLUMN count: a past year needs ~365/366 such
    rows, the trailing (current) store year needs them up to the store's newest
    day. This catches three cases with one rule — a
    wholly-absent year, an interior hole, AND a year that's present but nearly empty
    (e.g. a lone stray 2025 row a year-set check would wrongly accept). Because the
    trailing year reads as incomplete until it catches up to the store, ERA5-Land's
    ~6-day lag makes a plain monthly rerun a top-up with no flag; once caught up,
    nothing is re-fetched.
    """
    if not resume:
        return years
    if r2_resume is not None:
        counts, _max_date = r2_resume.coverage_for_tile(tile_cells)
    else:
        counts, _max_date = local_coverage_for_tile(tile_cells)
    complete = _complete_years(counts, latest_date)
    return sorted(y for y in years if y not in complete)


def batches(years: list[int], batch_years: int) -> list[tuple[int, int]]:
    """Split a sorted year list into (start, end) spans of up to batch_years,
    breaking a span wherever the years aren't contiguous so a gap isn't fetched.
    """
    if not years:
        return []
    ys = sorted(years)
    spans: list[tuple[int, int]] = []
    run_start = prev = ys[0]
    for y in ys[1:]:
        contiguous = y == prev + 1
        within_cap = y - run_start + 1 <= batch_years
        if contiguous and within_cap:
            prev = y
            continue
        spans.append((run_start, prev))
        run_start = prev = y
    spans.append((run_start, prev))
    return spans


def resolve_land_indices(
    finite_mask: np.ndarray,
    lats: np.ndarray,
    lons: np.ndarray,
    targets: list[tuple[float, float]],
) -> list[tuple[int, int] | None]:
    """Map each (target_lat, target_lon) to a (row, col) index into a tile window
    that has LAND data, snapping off ocean.

    ERA5-Land is land-only: ocean gridpoints are NaN. A coastal city's nearest
    0.1deg gridpoint can be just offshore (NaN), which the old plain-nearest snap
    extracted as an all-blank archive (Finding F1). Here we snap to the nearest
    gridpoint and, IF that cell is ocean, fall back to the geometrically closest
    LAND cell in the window.

    `finite_mask` is the land mask: True where the cell has finite data (over the
    period being processed), shaped (n_lat, n_lon). `lats`/`lons` are the window's
    1-D coordinate arrays (any monotonic ordering). Returns one entry per target:
    a (row, col) index into the window, or None if the whole window is ocean
    (no land to fall back to — the caller logs and skips it rather than writing a
    blank or a far-away value).

    Inland cells whose nearest gridpoint is already land resolve to exactly that
    nearest index, so the snap is a no-op everywhere it was already correct.
    """
    land = np.argwhere(finite_mask)  # (k, 2) rows of [row, col] land cells
    out: list[tuple[int, int] | None] = []
    for tlat, tlon in targets:
        li = int(np.abs(lats - tlat).argmin())
        ci = int(np.abs(lons - tlon).argmin())
        if finite_mask[li, ci]:
            out.append((li, ci))  # nearest gridpoint is land — plain nearest
            continue
        if land.size == 0:
            out.append(None)  # window is all ocean — nothing to snap to
            continue
        # nearest LAND cell by grid (index) distance — within one tile window
        # row/col steps are near-equal-area; squared index distance is the right
        # tie-break and far cheaper than a haversine over every land cell.
        d2 = (land[:, 0] - li) ** 2 + (land[:, 1] - ci) ** 2
        bi, bj = land[int(d2.argmin())]
        out.append((int(bi), int(bj)))
    return out


def process_span(
    ds,
    tile_id: str,
    tile_cells: list[dict],
    start_year: int,
    end_year: int,
    var_workers: int,
    zarr_vars: list[str] | None = None,
) -> dict[tuple[float, float], "object"]:
    """Fetch one tile's hourly data for [start_year, end_year], return per-cell
    daily frames. Reads exactly the tile's one 50x100 spatial chunk and the
    time-chunks spanning the year range — each chunk fetched once. The vars are
    computed concurrently across a thread pool of size var_workers.

    `zarr_vars` is the ACTIVE variable list (default: all of ZARR_VARS). The
    returned frames carry exactly the ARCHIVE_COLUMNS whose inputs were fetched
    (see COLUMN_INPUTS) — a `--vars d2m` backfill yields date + dewpt_mean_C and
    nothing else; write_archive merges per column, so the rest of the archive
    survives untouched.
    """
    import pandas as pd
    import xarray as xr

    zarr_vars = list(ZARR_VARS if zarr_vars is None else zarr_vars)
    active_columns = [
        col for col in ARCHIVE_COLUMNS if col != "date"
        and all(v in zarr_vars for v in COLUMN_INPUTS[col])
    ]
    if not active_columns:
        raise ValueError(f"no archive column derives from {zarr_vars}")

    lat_name = "latitude" if "latitude" in ds.coords else "lat"
    lon_name = "longitude" if "longitude" in ds.coords else "lon"
    time_name = "valid_time" if "valid_time" in ds.coords else "time"

    lon_max = float(ds[lon_name].max())
    lon_is_360 = lon_max > 180.5

    lons = np.array([c["lon"] for c in tile_cells])
    sel_lons = np.where(lons < 0, lons + 360.0, lons) if lon_is_360 else lons

    # Select EXACTLY this tile's one 50x100 spatial chunk by integer index.
    chunk_row, chunk_col = (int(x) for x in tile_id.split("_"))
    lat_i0, lat_i1 = chunk_row * TILE_LAT_CELLS, (chunk_row + 1) * TILE_LAT_CELLS
    lon_i0, lon_i1 = chunk_col * TILE_LON_CELLS, (chunk_col + 1) * TILE_LON_CELLS
    lat_i1 = min(lat_i1, ds.sizes[lat_name])
    lon_i1 = min(lon_i1, ds.sizes[lon_name])

    span = f"{start_year}" if start_year == end_year else f"{start_year}-{end_year}"
    log(f"  tile {tile_id} | years {span}: {len(tile_cells)} cells, "
        f"chunk lat[{lat_i0}:{lat_i1}] lon[{lon_i0}:{lon_i1}]")

    # ONE DAY OF HALO on each side. The daily aggregation buckets by LOCAL day
    # (see below), so the span's edge days need hours from outside the calendar
    # span: Austin's local 2026-01-01 runs to 2026-01-02 05:00 UTC, and its local
    # 2025-12-31 starts at 2025-12-31 06:00 UTC. Without the halo those edge days
    # aggregate from a partial handful of hours. The halo is clamped by the store
    # itself (a slice past either end just yields what exists), and costs at most
    # one extra 60-day time-chunk per variable per span end.
    sub = ds[zarr_vars].sel({
        time_name: slice(f"{start_year - 1}-12-31", f"{end_year + 1}-01-01"),
    }).isel({
        lat_name: slice(lat_i0, lat_i1),
        lon_name: slice(lon_i0, lon_i1),
    })
    n_steps = sub.sizes.get(time_name)
    n_lat, n_lon = sub.sizes.get(lat_name), sub.sizes.get(lon_name)
    var_mb = (n_steps or 0) * (n_lat or 0) * (n_lon or 0) * 4 / 1e6
    log(f"  tile {tile_id} | years {span}: window {n_lat}x{n_lon} cells x "
        f"{n_steps} hourly steps, ~{var_mb:.0f} MB/var "
        f"(~{var_mb * len(zarr_vars):.0f} MB total)")

    if not n_steps:
        log(f"  tile {tile_id} | years {span}: no steps in range — skipping")
        return {}

    # --- fetch the active vars concurrently ----------------------------------
    log(f"  tile {tile_id} | years {span}: fetching {len(zarr_vars)} var(s) "
        f"({', '.join(zarr_vars)}; {var_workers} concurrent)")
    c0 = time.time()
    raw: dict[str, object] = {}
    with ThreadPoolExecutor(max_workers=var_workers) as ex:
        futs = {ex.submit(_compute_step, f"{v} hourly", sub[v]): v
                for v in zarr_vars}
        for fut in as_completed(futs):
            raw[futs[fut]] = fut.result()  # re-raises on permanent failure

    # --- daily metrics, bucketed by LOCAL day --------------------------------
    # ERA5(-Land) is stored on a single UTC time axis, so a naive resample("1D")
    # buckets every cell on the UTC calendar day. For a cell well off UTC that
    # mislabels the pre-dawn MINIMUM (tmin) — Beijing's UTC-day "May 1" low is
    # really the local May 2 low — and the recent/forecast tiers (Open-Meteo
    # timezone=auto) use LOCAL days, so the archive↔recent seam disagrees.
    # The canonical fix (cf. Copernicus' ERA5 daily-statistics "shift to local
    # time zone" option, and xarray resample offset=) is to shift the UTC time
    # axis by the cell's offset BEFORE the daily aggregation. We use the SOLAR
    # offset round(lon/15)h: integer-hour, DST-free (the right choice for a
    # multi-decade baseline), and it reproduces Open-Meteo's timezone=auto
    # values exactly for whole-hour zones. Cells in one tile can fall in
    # different offsets, so we group by offset and aggregate once per group.

    # Precip is ACCUMULATED (resets 01:00 UTC), so it can't be min/max-resampled:
    # de-accumulate to hourly increments once (offset-independent), then SUM the
    # increments over the shifted local day per offset group. Increment[h] =
    # tp[h]-tp[h-1], except at the 01:00 reset where tp[01:00] IS the increment
    # (it resets from 0). Verified to reproduce the old 00:00-step UTC totals.
    # Skipped entirely when `tp` is not an active variable: the frame then has
    # no precip_mm and the per-column merge keeps what the archive holds.
    hourly: dict[str, object] = {}  # archive column -> hourly DataArray input
    if "tp" in raw:
        tp_hourly = raw.pop("tp")
        tp_prev = tp_hourly.shift({time_name: 1})
        tp_incr = tp_hourly - tp_prev
        is_reset = tp_hourly[time_name].dt.hour == 1
        tp_incr = xr.where(is_reset, tp_hourly, tp_incr)
        # First step has no predecessor; tiny negatives from float noise → 0.
        hourly["precip_mm"] = tp_incr.fillna(0.0).clip(min=0.0)
        del tp_hourly, tp_prev, tp_incr, is_reset  # increments are all we need

    if "u10" in raw and "v10" in raw:
        hourly["wind_max_ms"] = np.sqrt(raw.pop("u10") ** 2 + raw.pop("v10") ** 2)
    if "t2m" in raw:
        hourly["tmax_C"] = hourly["tmin_C"] = raw["t2m"]
    if "d2m" in raw:
        # The dew-point metric is the daily MEAN of hourly d2m (kelvin here,
        # degC in the archive): dewpoint_telaviv.ipynb found the daily max to be
        # a night-time value bunching against the marine ceiling, while the mean
        # ranks days the way a daytime reading does.
        hourly["dewpt_mean_C"] = raw["d2m"]

    # Reference array for the land mask, the time axis and the day buckets: t2m
    # when fetched, else whichever variable was. ERA5-Land is land-only in every
    # variable alike (ocean is NaN across the board), so the mask is the same.
    ref_hourly = raw["t2m"] if "t2m" in raw else next(iter(raw.values()))

    # --- nearest-LAND snap (Finding F1) ---------------------------------------
    # ERA5-Land is land-only (ocean cells are NaN). A coastal cell's nearest
    # gridpoint can be just offshore — the old per-cell .sel(method="nearest")
    # then extracted an all-blank archive. Build a land mask (any finite value
    # over the span — a cell that's ever finite is land) and resolve each target
    # cell to a real land gridpoint index, snapping off ocean. We then select by
    # INTEGER index (.isel) below instead of coordinate-nearest .sel.
    land_mask = np.isfinite(ref_hourly).any(dim=time_name).values
    win_lats = ref_hourly[lat_name].values
    win_lons = ref_hourly[lon_name].values
    targets = [(c["lat"], float(slon)) for c, slon in zip(tile_cells, sel_lons)]
    cell_idx = resolve_land_indices(land_mask, win_lats, win_lons, targets)
    n_snapped = sum(
        1 for (c, slon), idx in zip(zip(tile_cells, sel_lons), cell_idx)
        if idx is not None
        and idx != (int(np.abs(win_lats - c["lat"]).argmin()),
                    int(np.abs(win_lons - float(slon)).argmin()))
    )
    n_empty = sum(1 for idx in cell_idx if idx is None)
    if n_snapped or n_empty:
        log(f"  tile {tile_id} | years {span}: land snap — {n_snapped} cell(s) "
            f"snapped off ocean to nearest land"
            + (f", {n_empty} cell(s) had NO land in window (skipped)"
               if n_empty else ""))
    # index into the window for each cell (row, col), keyed by (lat, lon)
    idx_by_cell = {(c["lat"], c["lon"]): idx
                   for c, idx in zip(tile_cells, cell_idx)}

    def solar_offset_hours(lon_deg: float) -> int:
        """Whole-hour local solar offset for a longitude in [-180, 180]."""
        lon180 = ((lon_deg + 180.0) % 360.0) - 180.0
        return int(round(lon180 / 15.0))

    # Group this tile's cells by their solar offset (usually 1-2 distinct values
    # across a ~6° tile). Each group gets one shifted resample.
    groups: dict[int, list[tuple[dict, float]]] = defaultdict(list)
    for c, slon in zip(tile_cells, sel_lons):
        groups[solar_offset_hours(c["lon"])].append((c, slon))

    log(f"  tile {tile_id} | years {span}: all vars fetched in "
        f"{fmt_dur(time.time() - c0)}; bucketing {len(tile_cells)} cells "
        f"across {len(groups)} local-offset group(s)")

    def shift_time(da, off_h: int):
        """Relabel the UTC time axis to local time so resample('1D') buckets the
        local solar day. A whole-hour shift is exactly a coordinate relabel."""
        return da.assign_coords(
            {time_name: da[time_name] + np.timedelta64(off_h, "h")}
        )

    # How each archive column reduces its hourly input over the local day.
    def reduce_daily(col: str, grouped):
        if col in ("tmax_C", "wind_max_ms"):
            return grouped.max()
        if col == "tmin_C":
            return grouped.min()
        if col == "precip_mm":
            return grouped.sum()
        if col == "dewpt_mean_C":
            # Accumulate in float64: a float32 running sum over 24 values of
            # ~290 K carries ~1e-3 K of noise, visible at the archive's 3 dp.
            # Ocean gridpoints are all-NaN and numpy warns "Mean of empty
            # slice" for each — expected (they never reach an archive), so
            # keep the warning out of a log that is hours long.
            import warnings
            with warnings.catch_warnings():
                warnings.filterwarnings("ignore", message="Mean of empty slice")
                return grouped.mean(dtype="float64")
        raise KeyError(col)

    frames: dict[tuple[float, float], pd.DataFrame] = {}
    for off_h, members in groups.items():
        daily: dict[str, object] = {}
        for col in active_columns:
            grouped = shift_time(hourly[col], off_h).resample({time_name: "1D"})
            daily[col] = reduce_daily(col, grouped)
        ref_daily = next(iter(daily.values()))
        dates = pd.to_datetime(ref_daily[time_name].values).date
        # Drop the partial local days at the span's edges (see whole_day_mask).
        # With the halo above, the only buckets that fail are the ones the store
        # genuinely cannot complete — the newest day, mid-accumulation.
        whole = whole_day_mask(ref_hourly[time_name].values, off_h, dates)
        if not whole.all():
            dropped = [str(d) for d, ok in zip(dates, whole) if not ok]
            log(f"  tile {tile_id} | years {span}: offset {off_h:+d}h — "
                f"{len(dropped)} partial local day(s) dropped: "
                f"{', '.join(dropped)}")
        dates = dates[whole]

        for c, slon in members:
            idx = idx_by_cell[(c["lat"], c["lon"])]
            if idx is None:
                # No land anywhere in this tile window — don't write a blank
                # archive (that's the very F1 symptom). Skip; the cell stays
                # absent and is logged above.
                continue
            row, col_i = idx
            sel = {lat_name: row, lon_name: col_i}
            columns = {"date": dates}
            for col in active_columns:
                values = daily[col].isel(sel).values[whole]
                columns[col] = np.round(_TO_ARCHIVE_UNITS[col](values), 3)
            frame = pd.DataFrame(columns).sort_values("date")
            frames[(c["lat"], c["lon"])] = frame[
                [name for name in ARCHIVE_COLUMNS if name in frame.columns]
            ]

    return frames


def whole_day_mask(time_values, off_h: int, bucket_dates) -> np.ndarray:
    """Which daily buckets hold all 24 hours of their LOCAL day.

    `resample("1D")` over a time axis shifted by `off_h` always produces a
    partial bucket at each end — for a -6 h cell the first bucket holds the six
    evening hours of the day BEFORE the fetched span, for a +3 h cell the last
    bucket holds three hours of the day AFTER it. Those buckets aggregate to a
    tmax/tmin/precip built from a fraction of the day (measured: 4.5 C low on a
    real boundary day), and merge-by-date would write that over a complete row.

    Returns a boolean mask over `bucket_dates`, True where the bucket holds 24
    hourly steps. Solar offsets are whole hours and DST-free, so a complete local
    day is exactly 24 steps, leap years included.
    """
    import pandas as pd

    shifted = pd.DatetimeIndex(time_values) + pd.Timedelta(hours=off_h)
    per_day = pd.Series(1, index=shifted).resample("1D").sum()
    counts = {ts.date(): int(n) for ts, n in per_day.items()}
    return np.array([counts.get(d, 0) == 24 for d in bucket_dates], dtype=bool)


def archive_name(lat: float, lon: float) -> str:
    """v2 archive filename for a snapped 0.1deg cell centre — the R2 key minus
    its `archive/` prefix. Formatted by cell_keys (the one sign-normalising
    formatter, so a cell stored as lon -0.0 names as `_0.0`, the key the
    Worker/frontend actually request)."""
    return tier_name("archive", lat, lon)


def recent_name(lat: float, lon: float) -> str:
    """v2 `recent` tier filename for a snapped 0.1deg cell centre — same lat/lon
    formatting as archive_name, matching worker/src/cellStore.js's objectKey."""
    return tier_name("recent", lat, lon)


# Writes share OUT_DIR across tile threads; serialise the read-merge-write so two
# threads never clobber the same (or a freshly created) archive.
_WRITE_LOCK = threading.Lock()

# In --upload-r2 mode, R2 — not the local disk — is the source of truth: the local
# disk may be stale (missing years R2 already has) or empty (a fresh box), and
# merging a fetched span onto a stale local file then uploading would CLOBBER the
# newer years R2 holds. So the FIRST write of each cell per run seeds its merge
# base from R2; later spans merge onto the (now-correct) local file we just wrote.
# This set records which cells have been seeded this run. Guarded by _WRITE_LOCK.
_R2_SEEDED: set[tuple[float, float]] = set()


class OverwriteLedger:
    """Resumable progress index for --overwrite runs.

    --overwrite REBUILDS each cell from scratch (to drop stale UTC-day values),
    which means it can't lean on the normal year-resume (that would skip the very
    years we want to recompute). So a long overwrite run needs its own resume: a
    small on-disk JSON index recording which (cell, span) frames already landed
    THIS run. On restart we skip those spans and keep going — no refetch of
    completed work, no self-wipe.

    Two facts are persisted per overwrite run, under a `signature` (the year
    range) so a *different* overwrite run won't trust a stale ledger:
      - `replaced`: cells whose file has already been replaced wholesale this run.
        The FIRST write of a cell replaces (discarding old rows); every later
        span MERGES onto that fresh file. Persisting this means a post-crash
        restart keeps merging instead of wiping a half-rebuilt cell.
      - `done`: (cell, span) pairs fully written — used to skip on resume.

    Durability: the ledger is written to local disk atomically on every change,
    AND mirrored to R2 (when an `uploader` is given) so it survives a full VM
    WIPE, not just a process crash — the VM's disk is ephemeral, so a disk-only
    ledger would be lost with the box and force a from-scratch rebuild. The R2
    push is throttled (it lags local by up to `_R2_MIN_INTERVAL_S`) so we don't
    PUT once per cell; a wipe then costs at most a few seconds of redone cells.
    On startup, if there's no local ledger we pull it from R2. Deleted from both
    on a clean finish. Guarded by _WRITE_LOCK (same lock as the archive writes).
    """

    # Don't push the ledger to R2 more than once per this many seconds.
    _R2_MIN_INTERVAL_S = 30.0
    R2_KEY = "archive/.overwrite_progress.json"

    def __init__(self, path: Path, signature: str, uploader=None):
        self.path = path
        self.signature = signature
        self.uploader = uploader
        self.replaced: set[str] = set()
        self.done: set[str] = set()
        self._last_r2_push = 0.0
        self._dirty_r2 = False
        self._load()

    # Same coordinate formatting as the object keys (cell_keys.coord_str), so
    # a -0.0 cell is one entry, not one per sign.
    @staticmethod
    def _cell_key(lat: float, lon: float) -> str:
        return f"{coord_str(lat)},{coord_str(lon)}"

    @staticmethod
    def _span_key(lat: float, lon: float, s: int, e: int) -> str:
        return f"{coord_str(lat)},{coord_str(lon)}@{s}-{e}"

    def _adopt(self, data: dict) -> bool:
        """Load state from a parsed ledger dict if its signature matches."""
        if data.get("signature") != self.signature:
            return False  # ledger is for a different overwrite scope — ignore it
        self.replaced = set(data.get("replaced", []))
        self.done = set(data.get("done", []))
        return True

    def _load(self) -> None:
        import json
        # Prefer the local copy (newest); fall back to R2 on a fresh/wiped box.
        try:
            if self._adopt(json.loads(self.path.read_text())):
                return
        except (OSError, ValueError):
            pass
        if self.uploader is not None:
            try:
                body = self.uploader.get_bytes(self.R2_KEY)
                if body and self._adopt(json.loads(body)):
                    log(f"overwrite: resumed ledger from R2 "
                        f"({len(self.done)} (cell,span) done)")
            except Exception as e:  # noqa: BLE001 - resume is best-effort
                log(f"overwrite: could not read R2 ledger ({e}); starting fresh")

    def _serialize(self) -> bytes:
        import json
        return json.dumps({
            "signature": self.signature,
            "replaced": sorted(self.replaced),
            "done": sorted(self.done),
        }).encode()

    def _flush(self) -> None:
        # Local write is atomic and per-change (cheap; survives a process crash).
        blob = self._serialize()
        tmp = self.path.with_suffix(".tmp")
        tmp.write_bytes(blob)
        tmp.replace(self.path)
        # R2 mirror is throttled (survives a VM wipe; a few seconds of lag is ok).
        self._dirty_r2 = True
        if self.uploader is not None and (
            time.time() - self._last_r2_push >= self._R2_MIN_INTERVAL_S
        ):
            self._push_r2(blob)

    def _push_r2(self, blob: bytes | None = None) -> None:
        if self.uploader is None:
            return
        try:
            self.uploader.put_bytes(
                blob if blob is not None else self._serialize(),
                self.R2_KEY, "application/json",
            )
            self._last_r2_push = time.time()
            self._dirty_r2 = False
        except Exception as e:  # noqa: BLE001 - mirror is best-effort
            log(f"overwrite: R2 ledger push failed ({e}); local copy kept")

    def span_done(self, lat: float, lon: float, s: int, e: int) -> bool:
        """Has this (cell, span) already been written this overwrite run?"""
        return self._span_key(lat, lon, s, e) in self.done

    def is_replaced(self, lat: float, lon: float) -> bool:
        return self._cell_key(lat, lon) in self.replaced

    def mark_replaced(self, lat: float, lon: float) -> None:
        self.replaced.add(self._cell_key(lat, lon))
        self._flush()

    def mark_span_done(self, lat: float, lon: float, s: int, e: int) -> None:
        self.done.add(self._span_key(lat, lon, s, e))
        self._flush()

    def clear(self) -> None:
        # Flush any throttled-but-unpushed state isn't needed on a clean finish —
        # we're deleting it. Remove from both stores so the NEXT run starts fresh.
        self.path.unlink(missing_ok=True)
        if self.uploader is not None:
            try:
                self.uploader.delete_object(self.R2_KEY)
            except Exception as e:  # noqa: BLE001
                log(f"overwrite: R2 ledger delete failed ({e})")


# The first year any archive can contain. A run that starts here fetches the
# whole record, so a missing merge base costs nothing — the frame IS the history.
# A run that starts LATER (a monthly top-up) does not: see MergeBaseUnavailable.
ARCHIVE_FIRST_YEAR = 1950

# Cells whose write was skipped to protect their R2 history (see write_archive).
# Appended from tile threads; list.append is atomic, no lock needed.
_SKIPPED_CELLS: list[str] = []

# Tiles that raised. A run is hours long over hundreds of tiles, so one tile's
# error is recorded and stepped over, not fatal: before this, a single failed
# call aborted main while the executor's own shutdown kept the worker threads
# running to the end of the queue — the run looked dead and wasn't.
_FAILED_TILES: list[tuple[str, str]] = []


class MergeBaseUnavailable(RuntimeError):
    """R2 has (or may have) this cell's archive, but this run could not read it.

    Only raised for a PARTIAL-history run — one whose fetched span cannot itself
    reproduce the whole archive. Writing "fresh" there would upload a file
    containing the span alone, silently deleting every earlier year from R2. The
    cell is skipped instead: R2 keeps what it has, and a re-run picks it up.
    """


def _read_archive_frame(source, *, compression="infer"):
    """Read one gzip cell archive into a frame with `date` as datetime.date.

    `source` is a local path (compression inferred from .gz) or a BytesIO of raw
    gzip bytes (pass compression="gzip"). Raises the underlying read error if the
    archive is truncated/corrupt — callers decide how to recover.
    """
    import pandas as pd

    df = pd.read_csv(source, parse_dates=["date"], compression=compression)
    df["date"] = df["date"].dt.date
    return df


def _r2_error_detail(err: Exception) -> str:
    """R2's own request ids for a failed call, so a burst can be reported.

    botocore hangs the raw response off ClientError; the request id is what
    Cloudflare support can trace, and the status separates a server-side 5xx
    from a client/credential problem. Empty string for anything else.
    """
    meta = getattr(err, "response", {}).get("ResponseMetadata", {}) or {}
    bits = [f"{k}={meta[k]}" for k in ("HTTPStatusCode", "RequestId", "HostId")
            if meta.get(k)]
    return f" [{', '.join(bits)}]" if bits else ""


def _read_r2_base(uploader, name: str, *, required: bool = False):
    """The cell's current R2 archive as a merge base — frame, or None if R2 has
    no copy.

    On a FULL-history run a missing or unreadable object is fine: whatever years
    it lacks are exactly the years this run is fetching, so writing fresh loses
    nothing, and any read error degrades to None (best-effort).

    `required=True` (a partial-history run, e.g. `--year 2026`) inverts that: the
    fetched span is only a slice, so a base we failed to read must NOT become a
    fresh write — that would upload the slice alone over a full archive. Transient
    errors are retried, then raise MergeBaseUnavailable. A genuine 404 still
    returns None in both modes: R2 has nothing to lose.
    """
    import io

    body = None
    for attempt in range(1, _R2_BASE_RETRIES + 1):
        try:
            body = uploader.get_bytes(f"archive/{name}")
            break
        except Exception as e:  # noqa: BLE001 - reseed is best-effort
            last = attempt == _R2_BASE_RETRIES
            # When the base is REQUIRED, retry anything: the alternative is
            # skipping the cell, so a wasted retry on a permanent error costs
            # seconds while a missed retry costs the cell its top-up.
            if (required or _is_transient(e)) and not last:
                backoff = 2 ** attempt
                log(f"  R2 read failed for {name} ({type(e).__name__}); "
                    f"retrying in {backoff}s")
                time.sleep(backoff)
                continue
            if required:
                raise MergeBaseUnavailable(
                    f"cannot read R2 base for {name}: {type(e).__name__}: {e}"
                    f"{_r2_error_detail(e)}"
                ) from e
            log(f"  WARN R2 read failed for {name} ({e}); "
                "merging without an R2 base")
            return None
    if not body:
        return None  # R2 has no copy yet — the fetch is producing the full history
    try:
        return _read_archive_frame(io.BytesIO(body), compression="gzip")
    except (EOFError, OSError, ValueError) as e:
        if required:
            raise MergeBaseUnavailable(
                f"R2 archive {name} unreadable ({e.__class__.__name__})") from e
        log(f"  WARN R2 archive {name} unreadable ({e.__class__.__name__}); "
            "merging without an R2 base")
        return None


def _merge_base(path: Path, lat: float, lon: float, *, fresh: bool, uploader,
                require_base: bool = False):
    """The frame to merge a freshly-fetched span onto (None ⇒ write fresh).

    - --overwrite (`fresh`): None — rebuild the cell from scratch, dropping stale
      rows the recompute no longer produces.
    - Upload mode, first touch of this cell this run: seed from R2, the source of
      truth. The local disk is deliberately IGNORED here — it may be stale or
      empty, and every year it could contribute is one the fetch is reproducing
      anyway. One R2 GET per cell per run (not per span).
    - `require_base`: this run fetches only part of the record, so an R2 copy we
      cannot read is fatal for the cell (MergeBaseUnavailable) rather than a
      fresh write that would drop the years the span doesn't cover.
    - Later span this run, or a local (--no-upload) run: merge onto the local file
      — freshly R2-seeded this run, or the self-consistent base for a no-upload
      run whose resume itself reads local coverage. A corrupt local file (should
      not happen now writes are atomic) reseeds from R2 when an uploader exists.
    """
    if fresh:
        return None
    if uploader is not None and (lat, lon) not in _R2_SEEDED:
        _R2_SEEDED.add((lat, lon))
        return _read_r2_base(uploader, path.name, required=require_base)
    if not path.exists():
        return None
    try:
        return _read_archive_frame(path)
    except (EOFError, OSError, ValueError) as e:
        detail = "no R2 uploader — writing fresh from current span only"
        base = None
        if uploader is not None:
            base = _read_r2_base(uploader, path.name, required=require_base)
            detail = ("reseeded merge base from R2" if base is not None
                      else "no readable R2 copy — writing fresh")
        log(f"  WARN corrupt local archive {path.name} "
            f"({e.__class__.__name__}); {detail}")
        return base


def merge_archive_frames(base, frame):
    """Merge a freshly-fetched frame onto a cell's existing archive, per COLUMN.

    Not row-wise last-wins, which is what this used to be. A column backfill
    (`--vars d2m`) fetches ONE variable, so its frames carry only the column it
    derives — and replacing whole rows would blank every shipped column for each
    date it rewrites. `combine_first` keeps every value the new frame HAS and
    falls back to the archive for the rest: columns the frame lacks, and dates
    outside the fetched span alike. A full-column frame — every routine top-up —
    has a value everywhere and so degrades to exactly the old last-wins rule.

    Duplicate dates on either side (legacy archives from before the merge was
    de-duplicated) collapse last-wins first: combine_first aligns on the index
    and would otherwise refuse to reindex.
    """
    left = frame.drop_duplicates(subset="date", keep="last").set_index("date")
    right = base.drop_duplicates(subset="date", keep="last").set_index("date")
    return left.combine_first(right).reset_index()


def canonical_columns(frame):
    """`frame` with ARCHIVE_COLUMNS first, in order; anything else appended."""
    known = [c for c in ARCHIVE_COLUMNS if c in frame.columns]
    return frame[known + [c for c in frame.columns if c not in known]]


def write_archive(lat: float, lon: float, frame, *, ledger=None,
                  span=None, uploader=None, require_base: bool = False) -> Path:
    """Write (or merge by date) one cell's daily frame to its gzip archive.

    Merge-by-date makes re-running an overlapping span idempotent: existing dates
    are overwritten last-wins, new dates appended — per COLUMN, so a frame that
    carries only some columns leaves the others intact (see
    `merge_archive_frames`); the file is written in ARCHIVE_COLUMNS order.
    When `ledger` is given
    (--overwrite), the FIRST write of a cell this run REPLACES the existing file
    (so a recompute drops stale rows the new run no longer produces); subsequent
    span-writes for that cell merge as usual. `span` (s, e) records completion so
    a crashed run can resume past it.

    Merge base = R2, the source of truth (see `_merge_base`): in upload mode the
    local disk is treated as scratch, so a stale or empty box can't clobber R2 on
    upload, and a truncated local archive can't crash the tile. The write itself is
    atomic (temp file + os.replace) so a killed run never leaves a truncated file.
    With `require_base` (a partial-history run) an unreadable R2 base raises
    MergeBaseUnavailable instead — nothing is written, so R2 keeps its history.
    """
    with _WRITE_LOCK:
        OUT_DIR.mkdir(parents=True, exist_ok=True)
        path = OUT_DIR / archive_name(lat, lon)
        fresh = ledger is not None and not ledger.is_replaced(lat, lon)
        base = _merge_base(path, lat, lon, fresh=fresh, uploader=uploader,
                           require_base=require_base)
        if base is not None:
            merged = merge_archive_frames(base, frame).sort_values("date")
        else:
            merged = frame.sort_values("date")
        merged = canonical_columns(merged)
        # Atomic write: never leave a half-written .csv.gz that the next merge
        # (or the frontend) can't read if this process is killed mid-write.
        tmp = path.with_suffix(path.suffix + ".tmp")
        merged.to_csv(tmp, index=False, compression="gzip")
        os.replace(tmp, path)
        if ledger is not None:
            if fresh:
                ledger.mark_replaced(lat, lon)
            if span is not None:
                ledger.mark_span_done(lat, lon, span[0], span[1])
    return path


def run_tile_guarded(*args, **kwargs) -> int:
    """run_tile, with any error recorded against the tile instead of raised.

    Returns 0 for a tile that failed. The tile keeps whatever cells it had
    already written (each write is atomic and merges onto R2), so a re-run
    picks up exactly what's left — see the LastModified sweep in the docs.
    """
    tile_id = args[1] if len(args) > 1 else kwargs.get("tile_id", "?")
    try:
        return run_tile(*args, **kwargs)
    except Exception as exc:  # noqa: BLE001
        _FAILED_TILES.append((tile_id, f"{type(exc).__name__}: {exc}"))
        log(f"  !! tile {tile_id} FAILED ({type(exc).__name__}: {exc}) — "
            "continuing with the remaining tiles")
        return 0


def run_tile(ds, tile_id, tile_cells, years, batch_years,
             var_workers, resume, latest_date=None, r2_resume=None,
             uploader=None, ledger=None, require_base=False,
             zarr_vars=None) -> int:
    """Fetch all missing year-spans for one tile; return archives written.

    If `uploader` is given, each cell's archive is pushed to R2 right after it's
    (re)written — so a tile's full history lands incrementally during the pull
    rather than in a separate pass at the end. Idempotent: a re-run overwrites.
    `r2_resume`, when set, makes the resume check read coverage from R2 (the VM's
    disk is ephemeral) instead of the local archives. `ledger` (--overwrite)
    rebuilds every year from scratch and resumes via its own (cell, span) index.
    `require_base` marks a partial run (a slice of the years, or a subset of the
    variables): a cell whose R2 archive can't be read is skipped (and recorded)
    rather than overwritten with this span alone. `zarr_vars` restricts the
    fetch to a subset of ZARR_VARS (see process_span).

    When a written span reaches the store's newest year (`latest_date.year`) — a
    fresh backfill catching up, or the automatic trailing-year top-up — the cell's
    `recent/` object in R2 is deleted: the archive now covers the days recent was
    holding, and the frontend already prefers archive over recent on a shared
    date, so leftover recent rows are dead weight (stale IFS-sourced precip/wind
    nobody reads anymore). Ensure-fresh lazily rebuilds only the real remaining
    gap on the cell's next visit.
    """
    if ledger is not None:
        # Overwrite mode recomputes ALL requested years; year-resume is bypassed
        # (it would skip the very years we want to rebuild). Resume instead comes
        # from the ledger's per-(cell, span) record.
        todo = list(years)
    else:
        todo = missing_years(tile_cells, years, resume, r2_resume, latest_date)
    if not todo:
        log(f"tile {tile_id}: nothing missing — already complete, skipping")
        return 0
    spans = batches(todo, batch_years)
    skipped = sorted(set(years) - set(todo))
    log(f"tile {tile_id}: {len(todo)} years to fetch in {len(spans)} span(s)"
        + (f"; resume skipped {len(skipped)} present year(s)" if skipped else ""))

    written = 0
    for (s, e) in spans:
        # In overwrite mode, skip cells whose (cell, span) the ledger already has
        # (a prior, crashed run wrote them) — but only fetch the span at all if
        # SOME cell in the tile still needs it.
        pending = tile_cells
        if ledger is not None:
            pending = [c for c in tile_cells
                       if not ledger.span_done(c["lat"], c["lon"], s, e)]
            if not pending:
                log(f"tile {tile_id} | years {s}-{e}: all cells done "
                    "(ledger) — skipping")
                continue

        frames = process_span(ds, tile_id, tile_cells, s, e, var_workers,
                              zarr_vars)
        for (lat, lon), frame in frames.items():
            if ledger is not None and ledger.span_done(lat, lon, s, e):
                continue  # already landed before a crash
            try:
                path = write_archive(lat, lon, frame, ledger=ledger, span=(s, e),
                                     uploader=uploader, require_base=require_base)
            except MergeBaseUnavailable as exc:
                # Partial-history run and R2's copy is unreadable: writing would
                # replace a full archive with this span alone. Leave R2 as it is.
                # (`exc`, not `e` — `e` is this span's end year, and Python
                # deletes an `except ... as` name when the clause exits.)
                _SKIPPED_CELLS.append(archive_name(lat, lon))
                log(f"  !! SKIPPED {archive_name(lat, lon)} — {exc}")
                continue
            if uploader is not None:
                uploader.upload_file(path, f"archive/{path.name}")
                # This span reaches the store's newest year, so the archive now
                # covers the days the `recent` tier was holding — drop the dead
                # recent object (ensure-fresh rebuilds the real remaining gap).
                # Best-effort: the object is already dead weight, and the
                # frontend prefers archive over recent on a shared date. An R2
                # 5xx here must not cost us the tile — one did, live, on
                # 2026-08-25, and it took the whole run's accounting with it.
                if latest_date is not None and e >= latest_date.year:
                    try:
                        uploader.delete_object(f"recent/{recent_name(lat, lon)}")
                    except Exception as exc:  # noqa: BLE001
                        log(f"  WARN could not drop recent/{recent_name(lat, lon)}"
                            f" ({type(exc).__name__}); it is dead weight, not a"
                            " correctness problem")
            written += 1
        span = f"{s}" if s == e else f"{s}-{e}"
        log(f"tile {tile_id} | years {span}: wrote {len(frames)} archives"
            + (" + uploaded" if uploader is not None else ""))
    return written


def parse_vars(spec: str | None) -> list[str]:
    """The active variable list for a run: `--vars` as a subset of ZARR_VARS, in
    ZARR_VARS order; None ⇒ all of them. Unknown names raise ValueError."""
    if spec is None:
        return list(ZARR_VARS)
    wanted = {v.strip() for v in spec.split(",") if v.strip()}
    unknown = sorted(wanted - set(ZARR_VARS))
    if unknown:
        raise ValueError(f"unknown --vars {unknown}; stored vars are {ZARR_VARS}")
    if not wanted:
        raise ValueError("--vars is empty")
    return [v for v in ZARR_VARS if v in wanted]


def needs_merge_base(uploading: bool, start_year: int,
                     active_vars: list[str]) -> bool:
    """Whether an unreadable R2 base must SKIP the cell rather than write fresh.

    True for any upload run whose frames can't reproduce the whole archive on
    their own: one starting after ARCHIVE_FIRST_YEAR (a slice of the years) or
    one fetching a subset of ZARR_VARS (a slice of the columns). A full run —
    every year, every variable — keeps the best-effort fresh write.
    """
    if not uploading:
        return False
    return start_year > ARCHIVE_FIRST_YEAR or set(active_vars) != set(ZARR_VARS)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--tile", help="tile_id(s), comma-separated; default: all")
    ap.add_argument("--cells", help="cell name(s), ';'-separated — restrict the "
                    "run to just these cells (surgical re-pulls)")
    ap.add_argument("--year", type=int, help="single year (shorthand)")
    ap.add_argument("--start-year", type=int, default=1950)
    ap.add_argument("--end-year", type=int, default=datetime.now().year,
                    help="inclusive; default = current year")
    ap.add_argument("--batch-years", type=int, default=DEFAULT_BATCH_YEARS,
                    help=f"max years per fetch (default {DEFAULT_BATCH_YEARS}); "
                    "bigger = fewer calls but more memory")
    ap.add_argument("--var-workers", type=int, default=4,
                    help="concurrent variable fetches per span (default 4 = all)")
    ap.add_argument("--parallel-tiles", type=int, default=1,
                    help="tiles fetched concurrently (default 1); the store "
                    "drops connections under load, so keep this small")
    ap.add_argument("--vars", default=None,
                    help="comma-separated subset of the stored variables to "
                    f"fetch (default: all of {','.join(ZARR_VARS)}). A backfill "
                    "of ONE new column — `--vars d2m` for dewpt_mean_C — fetches "
                    "only that variable; the frames then carry only the "
                    "column(s) it derives and the merge keeps every other "
                    "column the archive already holds.")
    ap.add_argument("--no-resume", action="store_true",
                    help="refetch everything, ignoring existing archives")
    ap.add_argument("--upload-r2", action="store_true",
                    help="push each archive to R2 as it's written (needs "
                    "R2_ACCOUNT_ID/R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY in env, "
                    "e.g. `source r2.env`). Also makes resume read coverage from "
                    "R2 instead of the (ephemeral) local disk.")
    ap.add_argument("--overwrite", action="store_true",
                    help="REPLACE each cell's archive from scratch instead of "
                    "merging by date. Use this to correct already-downloaded "
                    "data (e.g. the UTC-day → local-day tmin fix): old rows are "
                    "discarded so stale values can't survive the merge. Refetches "
                    "every requested year, but is crash-resumable via a per-(cell,"
                    " span) ledger (.overwrite_progress.json), so a restart skips "
                    "work already written.")
    args = ap.parse_args()

    if args.year is not None:
        args.start_year = args.end_year = args.year
    years = list(range(args.start_year, args.end_year + 1))
    try:
        active_vars = parse_vars(args.vars)
    except ValueError as exc:
        print(f"!! {exc}")
        return 1
    # --overwrite recomputes from scratch, so every requested year must be
    # refetched — a resume that skipped present years would leave them stale.
    # It carries its own crash-resume via the ledger instead.
    resume = not args.no_resume and not args.overwrite

    uploader = None
    r2_resume = None
    if args.upload_r2:
        from r2_upload import R2Uploader  # boto3 import deferred to here

        # R2Uploader() raises SystemExit with a clear message if creds are
        # missing — fail fast here, before the long pull starts.
        uploader = R2Uploader()
        # With R2 as the upload target, also use it as the resume source of truth
        # (the VM's disk is ephemeral). One listing up front; built lazily below
        # only when resume is on, since --no-resume ignores existing archives.
        if resume:
            r2_resume = R2Resume(uploader)

    # Built after the uploader so the overwrite ledger can mirror to R2 (surviving
    # a full VM wipe). On a fresh/wiped box it pulls prior progress back from R2.
    ledger = None
    if args.overwrite:
        ledger = OverwriteLedger(
            OUT_DIR / ".overwrite_progress.json",
            signature=f"{args.start_year}-{args.end_year}",
            uploader=uploader,
        )

    cells = load_cells()
    by_tile = group_by_tile(cells)
    if args.tile:
        wanted = [t.strip() for t in args.tile.split(",") if t.strip()]
        missing = [t for t in wanted if not by_tile.get(t)]
        if missing:
            print(f"no cells in tile(s): {', '.join(missing)}")
            return 1
        tiles = {t: by_tile[t] for t in wanted}
    else:
        tiles = by_tile

    if args.cells:
        # Surgical scope: only the named cells (';'-separated — names contain
        # commas). Added for the 2026-08 snap rewrite (San Andrés offset-flip
        # re-pull); combine with --tile/--overwrite for one-cell rebuilds.
        wanted_names = {n.strip() for n in args.cells.split(";") if n.strip()}
        tiles = {t: [c for c in cs if c["name"] in wanted_names]
                 for t, cs in tiles.items()}
        tiles = {t: cs for t, cs in tiles.items() if cs}
        found = {c["name"] for cs in tiles.values() for c in cs}
        if missing_names := wanted_names - found:
            print(f"no cell(s) named: {'; '.join(sorted(missing_names))}")
            return 1

    n_cells = sum(len(v) for v in tiles.values())
    print("ERA5-Land cell download (v2: batched + parallel + resumable)")
    print(f"  store : {ZARR_URL}")
    print(f"  vars  : {active_vars}"
          + ("" if active_vars == ZARR_VARS else
             f"  (subset of {ZARR_VARS}; columns: "
             f"{[c for c in ARCHIVE_COLUMNS if c != 'date' and all(v in active_vars for v in COLUMN_INPUTS[c])]})"))
    print(f"  scope : {len(tiles)} tile(s), {n_cells} cell(s), "
          f"years {args.start_year}-{args.end_year}")
    print(f"  batch : up to {args.batch_years} yr/fetch, {args.var_workers} "
          f"var-workers, {args.parallel_tiles} parallel tile(s)")
    if ledger is not None:
        n_done = len(ledger.done)
        print("  mode  : OVERWRITE (rebuild from scratch, local-day buckets)"
              + (f"; ledger resume: {n_done} (cell,span) already done"
                 if n_done else "; ledger: fresh"))
    elif not resume:
        print("  resume: OFF (full refetch)")
    else:
        src = "R2 (ephemeral-disk-safe)" if r2_resume is not None else "local disk"
        print(f"  resume: on, source={src}; trailing year auto-topped-up "
              "when behind the store")
    print(f"  out   : {OUT_DIR}")
    if uploader is not None:
        print(f"  upload: R2 bucket '{uploader.bucket}' (archive/ keys), "
              "per-archive as written")
    # A span can never be longer than the year range asked for: `--year 2026`
    # holds one year of hourly data, not --batch-years' worth. Estimating from
    # the flag alone made a 1 GB top-up print a 21 GB OOM warning.
    warn_ram(min(args.batch_years, len(years)), args.var_workers,
             args.parallel_tiles, n_vars=len(active_vars))
    print()

    log("opening zarr store...")
    try:
        ds = open_store()
    except Exception as e:  # noqa: BLE001
        msg = f"{type(e).__name__}: {e}"
        print(f"!! open failed: {msg}")
        if "401" in msg or "403" in msg:
            print("   (missing DestinE creds — set up ~/.netrc for "
                  "data.earthdatahub.destine.eu)")
        return 1
    log("store opened")

    missing = [v for v in active_vars if v not in ds]
    if missing:
        print(f"!! variables not in store: {missing}; have {list(ds.data_vars)}")
        return 1

    # The store's newest day serves two automatic decisions, so read it once up
    # front: (1) on a resume, any tile whose archive ends before this gets its
    # trailing year re-fetched (merge-by-date), while caught-up tiles are skipped;
    # (2) whenever a written span reaches this year, the cell's now-dead `recent`
    # object is dropped. Cheap — the time axis is a small 1-D coordinate.
    latest_date = store_latest_date(ds)
    log(f"store latest date: {latest_date} (ERA5-Land lag) — on resume, tiles "
        "ending before this get their trailing year topped up")

    # A run that doesn't start at ARCHIVE_FIRST_YEAR fetches only a slice of the
    # record (the monthly top-up: --year 2026), and a --vars run only some of its
    # columns. Uploading such a frame over an archive whose R2 copy we failed to
    # read would delete every earlier year / every other column, so in either
    # mode an unreadable base skips the cell instead. Full runs keep the old
    # best-effort behaviour: the frame they hold IS the archive.
    require_base = needs_merge_base(uploader is not None, args.start_year,
                                    active_vars)
    if require_base:
        what = ("partial-history" if args.start_year > ARCHIVE_FIRST_YEAR
                else "partial-variable")
        log(f"{what} run (from {args.start_year}, vars {active_vars}): a cell "
            "whose R2 archive can't be read is SKIPPED, not overwritten")

    total_written = 0
    if args.parallel_tiles > 1:
        with ThreadPoolExecutor(max_workers=args.parallel_tiles) as ex:
            futs = {
                ex.submit(run_tile_guarded, ds, t, c, years, args.batch_years,
                          args.var_workers, resume, latest_date, r2_resume,
                          uploader, ledger, require_base, active_vars): t
                for t, c in tiles.items()
            }
            for fut in as_completed(futs):
                total_written += fut.result()
    else:
        for tile_id, tile_cells in tiles.items():
            total_written += run_tile_guarded(
                ds, tile_id, tile_cells, years, args.batch_years,
                args.var_workers, resume, latest_date, r2_resume,
                uploader, ledger, require_base, active_vars)

    # Clean finish: drop the resume ledger so the NEXT overwrite run starts fresh
    # rather than treating this run's completed spans as already-done.
    if ledger is not None:
        ledger.clear()

    print(f"\nDone — {total_written} cell-span frames written to {OUT_DIR}")

    first_tile = next(iter(tiles))
    sample = tiles[first_tile][0]
    sample_path = OUT_DIR / archive_name(sample["lat"], sample["lon"])
    if sample_path.exists():
        import pandas as pd

        df = pd.read_csv(sample_path)
        print(f"\nsample — {sample_path.name}, {len(df)} days:")
        print(df.describe().loc[["min", "mean", "max"]].round(2).to_string())

    if _FAILED_TILES:
        print(f"\n!! {len(_FAILED_TILES)} tile(s) FAILED and were stepped over:")
        for tile_id, why in _FAILED_TILES[:10]:
            print(f"   {tile_id}: {why}")
        if len(_FAILED_TILES) > 10:
            print(f"   (+{len(_FAILED_TILES) - 10} more)")
        print("   Re-run those tiles with --no-resume: a partly-written tile "
              "reads complete to the representative-cell check.")

    if _SKIPPED_CELLS:
        shown = ", ".join(_SKIPPED_CELLS[:10])
        more = f" (+{len(_SKIPPED_CELLS) - 10} more)" if len(_SKIPPED_CELLS) > 10 else ""
        print(f"\n!! {len(_SKIPPED_CELLS)} cell(s) SKIPPED to protect their R2 "
              f"history: {shown}{more}")
        print("   R2 still holds their previous archives — re-run to pick them up.")
    return 1 if (_SKIPPED_CELLS or _FAILED_TILES) else 0


if __name__ == "__main__":
    raise SystemExit(main())
