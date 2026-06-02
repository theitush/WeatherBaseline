"""Download ERA5-Land daily metrics for selected cells — batched, parallel, resumable.

Batched, parallel, resumable. Inputs (data/era5/cells.csv) and outputs
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

3. RESUME. Before fetching, we read each tile's existing archives and compute the
   set of YEARS already present across its cells. Only missing years are fetched —
   including interior gaps (a hole left by an interrupted run), not just the tail.
   The trailing (current) year is always re-fetched: ERA5-Land lags ~6 days, so
   new data keeps arriving. --no-resume forces a full refetch.

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
CELLS_CSV = REPO / "data" / "era5" / "cells.csv"
OUT_DIR = REPO / "data" / "era5-land" / "archive"

# Hourly ERA5-Land ARCO zarr store on EarthDataHub.
ZARR_URL = "https://data.earthdatahub.destine.eu/era5/reanalysis-era5-land-no-antartica-v0.zarr"

# Stored variables we need. Derived metrics (tmax/tmin from t2m, wind speed from
# u10+v10) cost nothing extra — the cost is per stored variable fetched.
ZARR_VARS = ["t2m", "tp", "u10", "v10"]

# The store chunks 64x64 cells per spatial chunk. tile_id encodes the chunk
# index, so one tile == one 64-cell block on each axis. Must match select_cells.
TILE_CELLS = 64

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
def years_present_for_tile(tile_cells: list[dict]) -> set[int]:
    """Years already covered by EVERY cell in the tile (intersection).

    A year counts as present for a cell only if that cell's archive has a row for
    that year. We intersect across the tile's cells so a year is "done" only when
    all cells have it — a tile fetch writes all cells together, so a year missing
    from any cell means that whole tile-year still needs fetching. Interior gaps
    (a year missing in the middle, e.g. from an interrupted run) are caught too,
    because we look at the actual set of years, not just the max date.
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
                  resume: bool) -> list[int]:
    """The subset of `years` still to fetch for this tile.

    With resume on: drop years already present in every cell, but ALWAYS keep the
    latest year (ERA5-Land lags ~6 days, so new data keeps arriving and the last
    stored year is partial). With resume off: fetch all requested years.
    """
    if not resume:
        return years
    have = years_present_for_tile(tile_cells)
    return [y for y in years if y not in have or y >= latest_year]


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

    # --- daily metrics -------------------------------------------------------
    t2m_daily = raw["t2m"].resample({time_name: "1D"})
    t2m_max = t2m_daily.max()
    t2m_min = t2m_daily.min()

    # tp is ACCUMULATED (resets 01:00 UTC); the value at a day's 00:00 step is
    # that day's COMPLETE total. Daily total for day D = tp at (D+1) 00:00, so we
    # pick every 00:00 step and shift its timestamp back one day.
    tp_hourly = raw["tp"]
    tp_midnight = tp_hourly.sel({time_name: tp_hourly[time_name].dt.hour == 0})
    tp_sum = tp_midnight.assign_coords({
        time_name: tp_midnight[time_name] - np.timedelta64(1, "D")
    })

    # wind: hourly speed sqrt(u^2+v^2) then daily max (must be hourly-then-max:
    # mean(speed) != speed(mean)).
    wind_hourly = np.sqrt(raw["u10"] ** 2 + raw["v10"] ** 2)
    wind_max = wind_hourly.resample({time_name: "1D"}).max()

    log(f"  tile {tile_id} | years {span}: all vars fetched + aggregated in "
        f"{fmt_dur(time.time() - c0)}")

    dates = pd.to_datetime(t2m_max[time_name].values).date
    tp_dates = pd.to_datetime(tp_sum[time_name].values).date
    log(f"  tile {tile_id} | years {span}: {len(dates)} daily values; "
        f"reading out {len(tile_cells)} cells")

    frames: dict[tuple[float, float], pd.DataFrame] = {}
    for c, slon in zip(tile_cells, sel_lons):
        sel = {lat_name: c["lat"], lon_name: float(slon)}
        temp_wind = pd.DataFrame({
            "date": dates,
            "tmax_C": np.round(t2m_max.sel(sel, method="nearest").values - 273.15, 3),
            "tmin_C": np.round(t2m_min.sel(sel, method="nearest").values - 273.15, 3),
            "wind_max_ms": np.round(wind_max.sel(sel, method="nearest").values, 3),
        })
        precip = pd.DataFrame({
            "date": tp_dates,
            "precip_mm": np.round(tp_sum.sel(sel, method="nearest").values * 1000.0, 3),
        })
        frame = temp_wind.merge(precip, on="date", how="outer").sort_values("date")
        frames[(c["lat"], c["lon"])] = frame[
            ["date", "tmax_C", "tmin_C", "precip_mm", "wind_max_ms"]
        ]

    return frames


def archive_name(lat: float, lon: float) -> str:
    """v2 archive filename for a snapped 0.1deg cell centre."""
    return f"archive_{lat:.1f}_{lon:.1f}.csv.gz"


# Writes share OUT_DIR across tile threads; serialise the read-merge-write so two
# threads never clobber the same (or a freshly created) archive.
_WRITE_LOCK = threading.Lock()


def write_archive(lat: float, lon: float, frame) -> Path:
    """Write (or merge by date) one cell's daily frame to its gzip archive.

    Merge-by-date makes re-running an overlapping span idempotent: existing dates
    are overwritten last-wins, new dates appended.
    """
    import pandas as pd

    with _WRITE_LOCK:
        OUT_DIR.mkdir(parents=True, exist_ok=True)
        path = OUT_DIR / archive_name(lat, lon)
        if path.exists():
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
    return path


def run_tile(ds, tile_id, tile_cells, years, latest_year, batch_years,
             var_workers, resume) -> int:
    """Fetch all missing year-spans for one tile; return archives written."""
    todo = missing_years(tile_cells, years, latest_year, resume)
    if not todo:
        log(f"tile {tile_id}: nothing missing — already complete, skipping")
        return 0
    spans = batches(todo, batch_years)
    skipped = sorted(set(years) - set(todo))
    log(f"tile {tile_id}: {len(todo)} years to fetch in {len(spans)} span(s)"
        + (f"; resume skipped {len(skipped)} present year(s)" if skipped else ""))

    written = 0
    for (s, e) in spans:
        frames = process_span(ds, tile_id, tile_cells, s, e, var_workers)
        for (lat, lon), frame in frames.items():
            write_archive(lat, lon, frame)
            written += 1
        span = f"{s}" if s == e else f"{s}-{e}"
        log(f"tile {tile_id} | years {span}: wrote {len(frames)} archives")
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
    args = ap.parse_args()

    if args.year is not None:
        args.start_year = args.end_year = args.year
    years = list(range(args.start_year, args.end_year + 1))
    latest_year = args.end_year
    resume = not args.no_resume

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
    print(f"  resume: {'on' if resume else 'OFF (full refetch)'}")
    print(f"  out   : {OUT_DIR}\n")

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
                          args.batch_years, args.var_workers, resume): t
                for t, c in tiles.items()
            }
            for fut in as_completed(futs):
                total_written += fut.result()
    else:
        for tile_id, tile_cells in tiles.items():
            total_written += run_tile(
                ds, tile_id, tile_cells, years, latest_year,
                args.batch_years, args.var_workers, resume)

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
