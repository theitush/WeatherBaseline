"""Download ERA5-Land daily metrics for selected cells — batched, parallel, resumable.

Batched, parallel, resumable. Inputs (data/cells.csv) and outputs
(data/era5-land/archive/archive_{lat}_{lon}.csv.gz, schema
date,tmax_C,tmin_C,precip_mm,wind_max_ms) are unchanged; archives merge by date.
Design notes:

1. BATCHED TIME SPANS (was: one .compute() per year).
   The store's time chunks are 1440 h = 60 days, NOT aligned to calendar years.
   A single year straddles ~7 chunks, and each boundary chunk is shared with the
   neighbouring year — so year-by-year RE-FETCHES every boundary chunk. Fetching
   a multi-year span reads each 60-day chunk exactly once.
   --batch-years bounds the span so memory stays sane (a span's t2m array is
   span_years * 8760 * 50 * 100 * 4 bytes; ~20 yr ≈ 3.5 GB/var per tile).

2. PARALLEL FETCHES. The 4 stored vars (t2m, tp, u10, v10) are independent
   network-bound .compute()s, so we fetch them concurrently (thread pool).
   --parallel-tiles additionally runs whole tiles concurrently. The store drops
   connections under load, so keep the worker count modest; the per-step retry
   covers the occasional drop.

3. RESUME + MONTHLY TOP-UP. Before fetching, we compute how COMPLETE each year
   already is for each tile — its daily-ROW count, not merely whether the year is
   present — and fetch only the years still short of a full year of days. That one
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
# u10+v10) cost nothing extra — the cost is per stored variable fetched.
ZARR_VARS = ["t2m", "tp", "u10", "v10"]

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


def warn_ram(batch_years: int, var_workers: int, parallel_tiles: int) -> None:
    """Estimate peak RAM for the chosen settings and warn if it's tight.

    Peak ≈ one var's hourly array (HOURS_PER_YEAR * batch_years * 50*100 * 4 B)
    held once per concurrent var, times concurrent tiles, times overhead for the
    transient resample/sqrt copies. Compared against MemAvailable so it's loud on
    a small remote box, where an OOM would silently kill the run mid-fetch.
    """
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
)
_MAX_RETRIES = 8
# Attempts for the per-cell R2 merge-base GET. Short: it's one small object, and
# on a partial-history run the failure path skips the cell rather than clobber it.
_R2_BASE_RETRIES = 3


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
        return self.up.read_coverage(smallest_key)


def local_coverage_for_tile(
    tile_cells: list[dict],
) -> tuple[dict[int, int], date | None]:
    """(per-year row counts across the tile, newest date) on local disk.

    For each year we take the MIN row count across the tile's cells: a year is only
    as complete as its least-covered cell, so a year fully present in some cells but
    missing (or nearly empty) in another counts as incomplete for the tile and is
    refetched. (A tile fetch writes all cells together, so coverage is normally
    uniform; the min makes an interrupted, non-uniform tile self-heal.) The caller
    (missing_years) judges completeness from these counts against the store's newest
    day, so a wholly-absent year, an interior hole, AND a present-but-nearly-empty
    year are all caught — not just the trailing tail. The newest date is the MIN of
    the cells' max dates — the tile is only as caught-up as its least-complete cell.

    Returns ({}, None) if any cell file is absent or empty.
    """
    import pandas as pd

    per_cell_counts: list[dict[int, int]] = []
    max_dates: list[date] = []
    for c in tile_cells:
        path = OUT_DIR / archive_name(c["lat"], c["lon"])
        if not path.exists():
            return {}, None  # a missing cell file means nothing is safely done
        # Only need the date column; parse years cheaply.
        dates = pd.to_datetime(pd.read_csv(path, usecols=["date"])["date"])
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

    Completeness is row-count based, not mere presence (see `_complete_years`): a
    past year needs ~365/366 rows, the trailing (current) store year needs rows up
    to the store's newest day. This catches three cases with one rule — a
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
) -> dict[tuple[float, float], "object"]:
    """Fetch one tile's hourly data for [start_year, end_year], return per-cell
    daily frames. Reads exactly the tile's one 50x100 spatial chunk and the
    time-chunks spanning the year range — each chunk fetched once. The 4 vars
    are computed concurrently across a thread pool of size var_workers.
    """
    import pandas as pd
    import xarray as xr

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

    sub = ds[ZARR_VARS].sel({
        time_name: slice(str(start_year), str(end_year)),
    }).isel({
        lat_name: slice(lat_i0, lat_i1),
        lon_name: slice(lon_i0, lon_i1),
    })
    n_steps = sub.sizes.get(time_name)
    n_lat, n_lon = sub.sizes.get(lat_name), sub.sizes.get(lon_name)
    var_mb = (n_steps or 0) * (n_lat or 0) * (n_lon or 0) * 4 / 1e6
    log(f"  tile {tile_id} | years {span}: window {n_lat}x{n_lon} cells x "
        f"{n_steps} hourly steps, ~{var_mb:.0f} MB/var "
        f"(~{var_mb * len(ZARR_VARS):.0f} MB total)")

    if not n_steps:
        log(f"  tile {tile_id} | years {span}: no steps in range — skipping")
        return {}

    # --- fetch the 4 vars concurrently ---------------------------------------
    log(f"  tile {tile_id} | years {span}: fetching {len(ZARR_VARS)} vars "
        f"({var_workers} concurrent)")
    c0 = time.time()
    raw: dict[str, object] = {}
    with ThreadPoolExecutor(max_workers=var_workers) as ex:
        futs = {ex.submit(_compute_step, f"{v} hourly", sub[v]): v
                for v in ZARR_VARS}
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
    tp_hourly = raw["tp"]
    tp_prev = tp_hourly.shift({time_name: 1})
    tp_incr = tp_hourly - tp_prev
    is_reset = tp_hourly[time_name].dt.hour == 1
    tp_incr = xr.where(is_reset, tp_hourly, tp_incr)
    # First step has no predecessor; tiny negatives from float noise → 0.
    tp_incr = tp_incr.fillna(0.0).clip(min=0.0)

    wind_hourly = np.sqrt(raw["u10"] ** 2 + raw["v10"] ** 2)
    t2m_hourly = raw["t2m"]

    # --- nearest-LAND snap (Finding F1) ---------------------------------------
    # ERA5-Land is land-only (ocean cells are NaN). A coastal cell's nearest
    # gridpoint can be just offshore — the old per-cell .sel(method="nearest")
    # then extracted an all-blank archive. Build a land mask (any finite t2m over
    # the span — a cell that's ever finite is land) and resolve each target cell
    # to a real land gridpoint index, snapping off ocean. We then select by
    # INTEGER index (.isel) below instead of coordinate-nearest .sel.
    land_mask = np.isfinite(t2m_hourly).any(dim=time_name).values
    win_lats = t2m_hourly[lat_name].values
    win_lons = t2m_hourly[lon_name].values
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

    frames: dict[tuple[float, float], pd.DataFrame] = {}
    for off_h, members in groups.items():
        t2m_g = shift_time(t2m_hourly, off_h).resample({time_name: "1D"})
        t2m_max = t2m_g.max()
        t2m_min = t2m_g.min()
        wind_max = shift_time(wind_hourly, off_h).resample({time_name: "1D"}).max()
        tp_sum = shift_time(tp_incr, off_h).resample({time_name: "1D"}).sum()
        dates = pd.to_datetime(t2m_max[time_name].values).date

        for c, slon in members:
            idx = idx_by_cell[(c["lat"], c["lon"])]
            if idx is None:
                # No land anywhere in this tile window — don't write a blank
                # archive (that's the very F1 symptom). Skip; the cell stays
                # absent and is logged above.
                continue
            row, col = idx
            sel = {lat_name: row, lon_name: col}
            frame = pd.DataFrame({
                "date": dates,
                "tmax_C": np.round(t2m_max.isel(sel).values - 273.15, 3),
                "tmin_C": np.round(t2m_min.isel(sel).values - 273.15, 3),
                "precip_mm": np.round(tp_sum.isel(sel).values * 1000.0, 3),
                "wind_max_ms": np.round(wind_max.isel(sel).values, 3),
            }).sort_values("date")
            frames[(c["lat"], c["lon"])] = frame[
                ["date", "tmax_C", "tmin_C", "precip_mm", "wind_max_ms"]
            ]

    return frames


def archive_name(lat: float, lon: float) -> str:
    """v2 archive filename for a snapped 0.1deg cell centre."""
    return f"archive_{lat:.1f}_{lon:.1f}.csv.gz"


def recent_name(lat: float, lon: float) -> str:
    """v2 `recent` tier filename for a snapped 0.1deg cell centre — same lat/lon
    formatting as archive_name, matching worker/src/cellStore.js's objectKey."""
    return f"recent_{lat:.1f}_{lon:.1f}.csv.gz"


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

    @staticmethod
    def _cell_key(lat: float, lon: float) -> str:
        return f"{lat:.1f},{lon:.1f}"

    @staticmethod
    def _span_key(lat: float, lon: float, s: int, e: int) -> str:
        return f"{lat:.1f},{lon:.1f}@{s}-{e}"

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
            if _is_transient(e) and not last:
                backoff = 2 ** attempt
                log(f"  R2 read failed for {name} ({type(e).__name__}); "
                    f"retrying in {backoff}s")
                time.sleep(backoff)
                continue
            if required:
                raise MergeBaseUnavailable(
                    f"cannot read R2 base for {name}: {type(e).__name__}: {e}"
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


def write_archive(lat: float, lon: float, frame, *, ledger=None,
                  span=None, uploader=None, require_base: bool = False) -> Path:
    """Write (or merge by date) one cell's daily frame to its gzip archive.

    Merge-by-date makes re-running an overlapping span idempotent: existing dates
    are overwritten last-wins, new dates appended. When `ledger` is given
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
    import pandas as pd

    with _WRITE_LOCK:
        OUT_DIR.mkdir(parents=True, exist_ok=True)
        path = OUT_DIR / archive_name(lat, lon)
        fresh = ledger is not None and not ledger.is_replaced(lat, lon)
        base = _merge_base(path, lat, lon, fresh=fresh, uploader=uploader,
                           require_base=require_base)
        if base is not None:
            merged = (
                pd.concat([base, frame])
                .drop_duplicates(subset="date", keep="last")
                .sort_values("date")
            )
        else:
            merged = frame.sort_values("date")
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


def run_tile(ds, tile_id, tile_cells, years, batch_years,
             var_workers, resume, latest_date=None, r2_resume=None,
             uploader=None, ledger=None, require_base=False) -> int:
    """Fetch all missing year-spans for one tile; return archives written.

    If `uploader` is given, each cell's archive is pushed to R2 right after it's
    (re)written — so a tile's full history lands incrementally during the pull
    rather than in a separate pass at the end. Idempotent: a re-run overwrites.
    `r2_resume`, when set, makes the resume check read coverage from R2 (the VM's
    disk is ephemeral) instead of the local archives. `ledger` (--overwrite)
    rebuilds every year from scratch and resumes via its own (cell, span) index.
    `require_base` marks a partial-history run: a cell whose R2 archive can't be
    read is skipped (and recorded) rather than overwritten with this span alone.

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

        frames = process_span(ds, tile_id, tile_cells, s, e, var_workers)
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
                if latest_date is not None and e >= latest_date.year:
                    uploader.delete_object(f"recent/{recent_name(lat, lon)}")
            written += 1
        span = f"{s}" if s == e else f"{s}-{e}"
        log(f"tile {tile_id} | years {span}: wrote {len(frames)} archives"
            + (" + uploaded" if uploader is not None else ""))
    return written


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--tile", help="tile_id(s), comma-separated; default: all")
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

    n_cells = sum(len(v) for v in tiles.values())
    print("ERA5-Land cell download (v2: batched + parallel + resumable)")
    print(f"  store : {ZARR_URL}")
    print(f"  vars  : {ZARR_VARS}")
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
    warn_ram(args.batch_years, args.var_workers, args.parallel_tiles)
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

    missing = [v for v in ZARR_VARS if v not in ds]
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
    # record (the monthly top-up: --year 2026). Uploading such a span over an
    # archive whose R2 copy we failed to read would delete every earlier year, so
    # in that mode an unreadable base skips the cell instead. Full-history runs
    # keep the old best-effort behaviour: the span they hold IS the history.
    require_base = uploader is not None and args.start_year > ARCHIVE_FIRST_YEAR
    if require_base:
        log(f"partial-history run (from {args.start_year}): a cell whose R2 "
            "archive can't be read is SKIPPED, not overwritten")

    total_written = 0
    if args.parallel_tiles > 1:
        with ThreadPoolExecutor(max_workers=args.parallel_tiles) as ex:
            futs = {
                ex.submit(run_tile, ds, t, c, years, args.batch_years,
                          args.var_workers, resume, latest_date, r2_resume,
                          uploader, ledger, require_base): t
                for t, c in tiles.items()
            }
            for fut in as_completed(futs):
                total_written += fut.result()
    else:
        for tile_id, tile_cells in tiles.items():
            total_written += run_tile(
                ds, tile_id, tile_cells, years, args.batch_years,
                args.var_workers, resume, latest_date, r2_resume,
                uploader, ledger, require_base)

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

    if _SKIPPED_CELLS:
        shown = ", ".join(_SKIPPED_CELLS[:10])
        more = f" (+{len(_SKIPPED_CELLS) - 10} more)" if len(_SKIPPED_CELLS) > 10 else ""
        print(f"\n!! {len(_SKIPPED_CELLS)} cell(s) SKIPPED to protect their R2 "
              f"history: {shown}{more}")
        print("   R2 still holds their previous archives — re-run to pick them up.")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
