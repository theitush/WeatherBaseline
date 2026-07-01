"""Download ERA5-Land daily metrics for selected cells — batched, parallel, resumable.

Batched, parallel, resumable. Inputs (data/cells.csv) and outputs
(data/era5-land/archive/archive_{lat}_{lon}.csv.gz, schema
date,tmax_C,tmin_C,precip_mm,wind_max_ms) are unchanged; archives merge by date.
Design notes:

1. BATCHED TIME SPANS (was: one .compute() per year).
   The store's time chunks are 2880 h = 120 days, NOT aligned to calendar years.
   A single year straddles ~4 chunks, and each boundary chunk is shared with the
   neighbouring year — so year-by-year RE-FETCHES every boundary chunk (~3x the
   reads). Fetching a multi-year span reads each 120-day chunk exactly once.
   --batch-years bounds the span so memory stays sane (a span's t2m array is
   span_years * 8760 * 64 * 64 * 4 bytes; ~20 yr ≈ 3 GB/var per tile).

2. PARALLEL FETCHES. The 4 stored vars (t2m, tp, u10, v10) are independent
   network-bound .compute()s, so we fetch them concurrently (thread pool).
   --parallel-tiles additionally runs whole tiles concurrently. The store drops
   connections under load, so keep the worker count modest; the per-step retry
   covers the occasional drop.

3. RESUME. Before fetching, we compute the set of YEARS already present for each
   tile and fetch only the missing ones — including interior gaps (a hole left by
   an interrupted run), not just the tail. The source of truth is the local disk,
   OR (with --upload-r2) the R2 bucket, since the VM's disk is ephemeral: a fresh
   box has no local archives but R2 still holds what earlier runs produced. R2
   coverage is read cheaply — one object listing gives every cell archive's size,
   and a tile is taken as complete on size alone (only the few small/ambiguous
   cells are downloaded and year-checked). A present year is skipped by default,
   INCLUDING the current year — so a resume won't redownload 2026 just because
   ERA5-Land is still appending to it. --refresh-latest re-fetches the trailing
   year on purpose (to top up recent data / a new dataset version); --no-resume
   forces a full refetch.

Usage:
  source .venv/bin/activate
  python download_cells.py --tile 9_37 --year 2020          # one span, one year
  python download_cells.py --tile 9_5,8_37 --start-year 1950 # resume missing yrs
  python download_cells.py --start-year 1950 --batch-years 20 --parallel-tiles 2
"""
from __future__ import annotations

import argparse
import csv
import threading
import time
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
CELLS_CSV = REPO / "data" / "cells.csv"
OUT_DIR = REPO / "data" / "era5-land" / "archive"

# Hourly ERA5-Land ARCO zarr store on EarthDataHub.
ZARR_URL = "https://data.earthdatahub.destine.eu/era5/reanalysis-era5-land-no-antartica-v0.zarr"

# Stored variables we need. Derived metrics (tmax/tmin from t2m, wind speed from
# u10+v10) cost nothing extra — the cost is per stored variable fetched.
ZARR_VARS = ["t2m", "tp", "u10", "v10"]

# The store chunks 64x64 cells per spatial chunk. tile_id encodes the chunk
# index, so one tile == one 64-cell block on each axis. Must match select_cells.
TILE_CELLS = 64

# Hourly steps per year (8760 h; leap years are ~0.03% more — ignore for an
# estimate). One var's in-memory array over an N-year span is
# HOURS_PER_YEAR * N * 64 * 64 * float32. Used only for the RAM warning.
HOURS_PER_YEAR = 8760
# Concurrent var fetches each hold their full hourly array at once; the daily
# resample + sqrt(u^2+v^2) allocate transient copies on top. ~1.5x covers it.
_RAM_OVERHEAD = 1.5

# Generous per-request HTTP ceiling — a cold ~47 MB chunk can be slow.
HTTP_TIMEOUT_S = 2400

# Default span per .compute(). ~20 yr ≈ 3 GB/var in memory per tile — bounded,
# while still reading each 120-day time-chunk only once across the span.
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

    Peak ≈ one var's hourly array (HOURS_PER_YEAR * batch_years * 64*64 * 4 B)
    held once per concurrent var, times concurrent tiles, times overhead for the
    transient resample/sqrt copies. Compared against MemAvailable so it's loud on
    a small remote box, where an OOM would silently kill the run mid-fetch.
    """
    per_var_gb = HOURS_PER_YEAR * batch_years * TILE_CELLS * TILE_CELLS * 4 / 1e9
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
    """Group cells by tile_id so each 6.4deg zarr tile is fetched only once."""
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

    def years_present_for_tile(self, tile_cells: list[dict],
                               want: set[int]) -> set[int]:
        """Years from `want` that R2 already has for this whole tile.

        A tile is written all-cells-together per span, so every cell in a tile
        shares the same year coverage — so we inspect exactly ONE cell. We can't
        infer completeness from file size (a cell missing only its last few years
        is barely smaller than a complete one, and a tiny-but-complete desert cell
        is smaller than a large partial one), so we read the cell's actual years.
        We pick the SMALLEST present cell as the one to read — it's the cheapest
        download and, since all cells share coverage, fully representative.

        Any cell key missing -> nothing safely done; the whole tile is refetched.
        """
        smallest_key: str | None = None
        smallest_size = None
        for c in tile_cells:
            key = f"archive/{archive_name(c['lat'], c['lon'])}"
            size = self.sizes.get(key)
            if size is None:
                return set()  # a missing cell -> tile not safely done
            if smallest_size is None or size < smallest_size:
                smallest_size, smallest_key = size, key
        if smallest_key is None:
            return set()
        have = self.up.read_years(smallest_key)
        return want & have  # only the wanted years this cell actually covers


def years_present_for_tile(tile_cells: list[dict], want: set[int]) -> set[int]:
    """Years (from `want`) already covered by EVERY cell on local disk.

    A year counts for a cell only if its archive has a row in that year. We
    intersect across the tile's cells so a year is "done" only when all cells have
    it — a tile fetch writes all cells together, so a year missing from any cell
    means that whole tile-year still needs fetching. Interior gaps (a year missing
    in the middle, e.g. from an interrupted run) are caught too, because we look at
    the actual set of years, not just the max date.
    """
    import pandas as pd

    per_cell_years: list[set[int]] = []
    for c in tile_cells:
        path = OUT_DIR / archive_name(c["lat"], c["lon"])
        if not path.exists():
            return set()  # a missing cell file means nothing is safely done
        # Only need the date column; parse years cheaply.
        dates = pd.read_csv(path, usecols=["date"])["date"]
        yrs = set(pd.to_datetime(dates).dt.year.unique().tolist())
        per_cell_years.append(yrs)
    return set.intersection(*per_cell_years) if per_cell_years else set()


def missing_years(tile_cells: list[dict], years: list[int], latest_year: int,
                  resume: bool, refresh_latest: bool,
                  r2_resume: "R2Resume | None") -> list[int]:
    """The subset of `years` still to fetch for this tile.

    With resume off: fetch all requested years. With resume on: drop years already
    present in every cell, using R2 as the source of truth when `r2_resume` is
    given (the VM's disk is ephemeral) and the local disk otherwise.

    By default an already-present year is skipped even if it's the latest year.
    Pass `refresh_latest` to ALWAYS re-fetch the trailing year — ERA5-Land lags
    ~6 days, so the last stored year is partial and a re-fetch tops it up (and
    picks up a new dataset version). You want that only when refreshing recent
    data, not on a plain resume of a long historical backfill.
    """
    if not resume:
        return years
    want = set(years)
    if r2_resume is not None:
        have = r2_resume.years_present_for_tile(tile_cells, want)
    else:
        have = years_present_for_tile(tile_cells, want)
    return [
        y for y in years
        if y not in have or (refresh_latest and y >= latest_year)
    ]


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
        # nearest LAND cell by grid (index) distance — the window is ~6deg, so
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
    daily frames. Reads exactly the tile's one 64x64 spatial chunk per axis and
    the time-chunks spanning the year range — each chunk fetched once. The 4 vars
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

    # Select EXACTLY this tile's one 64x64 spatial chunk by integer index.
    chunk_row, chunk_col = (int(x) for x in tile_id.split("_"))
    lat_i0, lat_i1 = chunk_row * TILE_CELLS, chunk_row * TILE_CELLS + TILE_CELLS
    lon_i0, lon_i1 = chunk_col * TILE_CELLS, chunk_col * TILE_CELLS + TILE_CELLS
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


def write_archive(lat: float, lon: float, frame, *, ledger=None,
                  span=None) -> Path:
    """Write (or merge by date) one cell's daily frame to its gzip archive.

    Merge-by-date makes re-running an overlapping span idempotent: existing dates
    are overwritten last-wins, new dates appended. When `ledger` is given
    (--overwrite), the FIRST write of a cell this run REPLACES the existing file
    (so a recompute drops stale rows the new run no longer produces); subsequent
    span-writes for that cell merge as usual. `span` (s, e) records completion so
    a crashed run can resume past it.
    """
    import pandas as pd

    with _WRITE_LOCK:
        OUT_DIR.mkdir(parents=True, exist_ok=True)
        path = OUT_DIR / archive_name(lat, lon)
        fresh = ledger is not None and not ledger.is_replaced(lat, lon)
        if path.exists() and not fresh:
            old = pd.read_csv(path, parse_dates=["date"])
            old["date"] = old["date"].dt.date
            merged = (
                pd.concat([old, frame])
                .drop_duplicates(subset="date", keep="last")
                .sort_values("date")
            )
        else:
            merged = frame.sort_values("date")
        merged.to_csv(path, index=False, compression="gzip")
        if ledger is not None:
            if fresh:
                ledger.mark_replaced(lat, lon)
            if span is not None:
                ledger.mark_span_done(lat, lon, span[0], span[1])
    return path


def run_tile(ds, tile_id, tile_cells, years, latest_year, batch_years,
             var_workers, resume, refresh_latest, r2_resume=None,
             uploader=None, ledger=None) -> int:
    """Fetch all missing year-spans for one tile; return archives written.

    If `uploader` is given, each cell's archive is pushed to R2 right after it's
    (re)written — so a tile's full history lands incrementally during the pull
    rather than in a separate pass at the end. Idempotent: a re-run overwrites.
    `r2_resume`, when set, makes the resume check read coverage from R2 (the VM's
    disk is ephemeral) instead of the local archives. `ledger` (--overwrite)
    rebuilds every year from scratch and resumes via its own (cell, span) index.

    When `refresh_latest` pushes an archive that now reaches further than before,
    the cell's `recent/` object in R2 is deleted: the frontend already prefers
    archive over recent on a shared date, but leftover recent rows are dead
    weight (stale IFS-sourced precip/wind nobody reads anymore) — ensure-fresh
    lazily rebuilds only the real remaining gap on the cell's next visit.
    """
    if ledger is not None:
        # Overwrite mode recomputes ALL requested years; year-resume is bypassed
        # (it would skip the very years we want to rebuild). Resume instead comes
        # from the ledger's per-(cell, span) record.
        todo = list(years)
    else:
        todo = missing_years(tile_cells, years, latest_year, resume,
                             refresh_latest, r2_resume)
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
            path = write_archive(lat, lon, frame, ledger=ledger, span=(s, e))
            if uploader is not None:
                uploader.upload_file(path, f"archive/{path.name}")
                if refresh_latest:
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
    ap.add_argument("--refresh-latest", action="store_true",
                    help="on resume, ALWAYS re-fetch the trailing year even if "
                    "present — ERA5-Land lags ~6 days so the last stored year is "
                    "partial. Off by default: a present year is skipped, so a "
                    "resume won't redownload the current year. Use this when you "
                    "want to top up recent data (e.g. a new dataset version).")
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
    latest_year = args.end_year
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
        latest = ("re-fetch latest year" if args.refresh_latest
                  else f"skip {latest_year} if present")
        print(f"  resume: on, source={src}, {latest}")
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

    total_written = 0
    if args.parallel_tiles > 1:
        with ThreadPoolExecutor(max_workers=args.parallel_tiles) as ex:
            futs = {
                ex.submit(run_tile, ds, t, c, years, latest_year,
                          args.batch_years, args.var_workers, resume,
                          args.refresh_latest, r2_resume, uploader, ledger): t
                for t, c in tiles.items()
            }
            for fut in as_completed(futs):
                total_written += fut.result()
    else:
        for tile_id, tile_cells in tiles.items():
            total_written += run_tile(
                ds, tile_id, tile_cells, years, latest_year,
                args.batch_years, args.var_workers, resume,
                args.refresh_latest, r2_resume, uploader, ledger)

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
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
