"""Download ERA5-Land daily metrics for selected cells, grouped by zarr tile.

Reads `data/era5/cells.csv` (the top-N populated 0.1deg cells from
select_cells.py), groups the cells by their 6.4deg zarr `tile_id`, and for each
DISTINCT tile fetches the hourly chunks ONCE — then computes 4 daily metrics for
every cell in that tile:

  tmax_C   daily maximum 2m temperature      (max of hourly t2m)
  tmin_C  daily minimum 2m temperature         (min of hourly t2m)
  precip_mm daily total precipitation        (tp is accumulated — the day's
                                               total is the value at the next
                                               day's 00:00 step; see process_tile)
  wind_max_ms daily maximum 10m wind speed   (max of hourly sqrt(u10^2+v10^2))

Why per-tile, not per-cell: the zarr store chunks 64x64 cells (=6.4deg) into one
spatial chunk. Fetching per cell would re-pull the shared chunk for every cell
in it. Grouping by tile_id and selecting the tile's lat/lon box means dask reads
each spatial chunk exactly once. Each selected cell IS an ERA5-Land cell centre,
so we index it directly with .sel(method="nearest") — no interpolation needed.

Wind speed MUST be computed hourly then resampled: mean(sqrt(u^2+v^2)) !=
sqrt(mean(u)^2+mean(v)^2). 

Usage (test run — one tile, one year):
  source .venv/bin/activate
  python download_cells.py --tile 9_37 --year 2020

  # all tiles, a year range:
  python download_cells.py --start-year 2018 --end-year 2020

Output: data/era5/cell_daily/{cell_id}.csv  (one file per cell, appended/extended)
        schema: date,tmax_C,tmin_C,precip_mm,wind_max_ms
"""
from __future__ import annotations

import argparse
import csv
import time
from collections import defaultdict
from datetime import datetime
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
CELLS_CSV = REPO / "data" / "era5" / "cells.csv"
OUT_DIR = REPO / "data" / "era5" / "cell_daily"

# Hourly ERA5-Land ARCO zarr store on EarthDataHub.
ZARR_URL = "https://data.earthdatahub.destine.eu/era5/reanalysis-era5-land-no-antartica-v0.zarr"

# Stored variables we need. Derived metrics (tmax/tmin from t2m, wind speed
# from u10+v10) cost nothing extra — the cost is per stored variable fetched.
ZARR_VARS = ["t2m", "tp", "u10", "v10"]

# The store chunks 64x64 cells per spatial chunk. tile_id encodes the chunk
# index, so one tile == one 64-cell block on each axis. Must match select_cells.
TILE_CELLS = 64

# Generous per-request HTTP ceiling — a cold ~47 MB chunk can be slow.
HTTP_TIMEOUT_S = 2400

_T0 = time.time()


def log(msg: str) -> None:
    """Timestamped log: wall-clock time + elapsed seconds since start."""
    now = datetime.now().strftime("%H:%M:%S")
    print(f"  [{now} | +{time.time() - _T0:7.1f}s] {msg}", flush=True)


def fmt_dur(seconds: float) -> str:
    """Human-friendly duration, e.g. '3m 12s'."""
    m, s = divmod(int(seconds), 60)
    return f"{m}m {s:02d}s" if m else f"{s}s"


# Transient network errors worth retrying — EarthDataHub object storage
# occasionally drops a connection mid-chunk (ContentLengthError / payload not
# completed). A plain re-fetch of the same chunk almost always succeeds.
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
    """Compute one lazy DataArray, with retry on transient network errors.

    Logs start/end wall time + duration. On a dropped connection it backs off
    and re-fetches — the same chunks, so no extra request budget beyond the
    failed attempt.
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
# constant metadata (number=0, surface=0.0, depthBelowLandLayer=100.0) and we
# don't use them — but each is its own zarr chunk that xarray re-fetches on
# EVERY .compute(). Verified via an HTTP-level trace: leaving them in cost ~3
# extra requests per variable per tile-year (~22 of the measured 38). Dropping
# them at open time brings a tile-year to exactly 16 data-chunk requests.
_DROP_COORDS = ["number", "surface", "depthBelowLandLayer"]


def open_store():
    """Open the hourly zarr store lazily, dropping the unused scalar coords.

    `chunks={}` keeps it lazy (data fetched on .compute()). The scalar-coord
    drop is a real request saving — see _DROP_COORDS.
    """
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


def process_tile(
    ds,
    tile_id: str,
    tile_cells: list[dict],
    year: int,
) -> dict[int, "object"]:
    """Fetch one tile's hourly data for `year`, return per-cell daily frames.

    Selects exactly the tile's one 64x64 spatial chunk by integer index (so the
    fetch reads precisely one chunk per axis — no margin, no straddle), slices
    the year, then computes all 4 daily metrics for the whole chunk in one go.
    Each selected cell is read out by nearest-neighbour index — it's an exact
    cell centre within the chunk.
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
    # tile_id is "{chunk_row}_{chunk_col}" on the store's coordinate grid
    # (see retile/select_cells.store_tile), so isel over [chunk*64 : +64]
    # reads precisely one chunk per axis — no bounding-box margin, no risk of
    # straddling a chunk boundary and quadrupling the request count.
    chunk_row, chunk_col = (int(x) for x in tile_id.split("_"))
    lat_i0, lat_i1 = chunk_row * TILE_CELLS, chunk_row * TILE_CELLS + TILE_CELLS
    lon_i0, lon_i1 = chunk_col * TILE_CELLS, chunk_col * TILE_CELLS + TILE_CELLS
    # clamp to the store extent (the last chunk on each axis is partial)
    lat_i1 = min(lat_i1, ds.sizes[lat_name])
    lon_i1 = min(lon_i1, ds.sizes[lon_name])

    log(f"  tile {tile_id}: {len(tile_cells)} cells, "
        f"chunk lat[{lat_i0}:{lat_i1}] lon[{lon_i0}:{lon_i1}]")

    sub = ds[ZARR_VARS].sel({
        time_name: slice(str(year), str(year)),
    }).isel({
        lat_name: slice(lat_i0, lat_i1),
        lon_name: slice(lon_i0, lon_i1),
    })
    n_steps = sub.sizes.get(time_name)
    n_lat, n_lon = sub.sizes.get(lat_name), sub.sizes.get(lon_name)
    log(f"  tile {tile_id}: window {n_lat}x{n_lon} cells x {n_steps} hourly steps")
    # Per-variable uncompressed payload estimate (float32). The actual download
    # is compressed and chunk-aligned, but this gives a feel for the volume.
    var_mb = n_steps * n_lat * n_lon * 4 / 1e6
    log(f"  tile {tile_id}: ~{var_mb:.1f} MB/var uncompressed "
        f"({len(ZARR_VARS)} vars -> ~{var_mb * len(ZARR_VARS):.1f} MB total)")

    # --- daily metrics, computed one variable at a time so each fetch is
    #     visible in the log AND each transfer stays small (a fat multi-var
    #     .compute() is more likely to have its connection dropped mid-stream).
    #     t2m is fetched once and reused for max + min.
    log(f"  tile {tile_id}: starting compute — 4 fetches (t2m, tp, u10, v10)")
    c0 = time.time()

    t2m_hourly = _compute_step("t2m hourly", sub["t2m"])
    t2m_daily = t2m_hourly.resample({time_name: "1D"})
    t2m_max = t2m_daily.max()
    t2m_min = t2m_daily.min()

    # --- precipitation: tp is ACCUMULATED, not per-hour --------------------
    # ERA5-Land tp accumulates over a forecast run that resets at 01:00 UTC, so
    # the value at a day's 00:00 step is that day's COMPLETE total. Verified
    # against the raw hourly dump: a naive resample().sum() over-counts ~20x.
    # Daily total for day D = tp at (D+1) 00:00. We pick every 00:00 step and
    # shift its timestamp back one day so it lands on the day it summarises.
    #
    # Within a single year's fetch the 00:00 steps run Jan 1 .. Dec 31, so
    # after the -1 day shift the tp series covers Dec 31 (year-1) .. Dec 30
    # (year). We keep the Dec-31-(year-1) value — it's real data, and the
    # per-cell CSV merges by date so it fills the gap year-1's own run left.
    # Only Dec 31 (year) is absent here; that year's successor run supplies it.
    tp_hourly = _compute_step("tp hourly", sub["tp"])
    tp_midnight = tp_hourly.sel(
        {time_name: tp_hourly[time_name].dt.hour == 0}
    )
    tp_sum = tp_midnight.assign_coords({
        time_name: tp_midnight[time_name] - np.timedelta64(1, "D")
    })

    # wind: u10 and v10 fetched SEPARATELY (smaller transfers = fewer dropped
    # connections), then hourly speed sqrt(u^2+v^2), then daily max.
    u10_hourly = _compute_step("u10 hourly", sub["u10"])
    v10_hourly = _compute_step("v10 hourly", sub["v10"])
    wind_hourly = np.sqrt(u10_hourly ** 2 + v10_hourly ** 2)
    wind_max = wind_hourly.resample({time_name: "1D"}).max()

    log(f"  tile {tile_id}: all chunks fetched + aggregated in "
        f"{fmt_dur(time.time() - c0)}")

    dates = pd.to_datetime(t2m_max[time_name].values).date
    log(f"  tile {tile_id}: {len(dates)} daily values; reading out {len(tile_cells)} cells")

    # tp's daily axis is shifted -1 day vs the t2m/wind axis, so it covers
    # Dec 31 (year-1) .. Dec 30 (year). Join on date — never positionally — so
    # each tp value lands on the day it belongs to and the axis offset (and
    # the missing Dec-31-(year) row) are handled by the merge, not by luck.
    tp_dates = pd.to_datetime(tp_sum[time_name].values).date

    frames: dict[int, pd.DataFrame] = {}
    for c, slon in zip(tile_cells, sel_lons):
        sel = {lat_name: c["lat"], lon_name: float(slon)}
        temp_wind = pd.DataFrame({
            "date": dates,
            "tmax_C": np.round(
                t2m_max.sel(sel, method="nearest").values - 273.15, 3),
            "tmin_C": np.round(
                t2m_min.sel(sel, method="nearest").values - 273.15, 3),
            "wind_max_ms": np.round(
                wind_max.sel(sel, method="nearest").values, 3),
        })
        precip = pd.DataFrame({
            "date": tp_dates,
            "precip_mm": np.round(
                tp_sum.sel(sel, method="nearest").values * 1000.0, 3),
        })
        # outer join: keeps Dec-31-(year-1) precip (no temp/wind that day) and
        # Dec-31-(year) temp/wind (no precip until next year's run).
        frame = temp_wind.merge(precip, on="date", how="outer").sort_values("date")
        frames[c["cell_id"]] = frame[
            ["date", "tmax_C", "tmin_C", "precip_mm", "wind_max_ms"]
        ]

    return frames


def write_cell_csv(cell_id: int, frame) -> Path:
    """Write (or merge by date) one cell's daily frame to its CSV."""
    import pandas as pd

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    path = OUT_DIR / f"{cell_id}.csv"
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
    merged.to_csv(path, index=False)
    return path


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--tile", help="only this tile_id (e.g. 9_37); default: all")
    ap.add_argument("--year", type=int, help="single year (shorthand)")
    ap.add_argument("--start-year", type=int, default=2020)
    ap.add_argument("--end-year", type=int, default=2020)
    args = ap.parse_args()

    if args.year is not None:
        args.start_year = args.end_year = args.year
    years = list(range(args.start_year, args.end_year + 1))

    cells = load_cells()
    by_tile = group_by_tile(cells)
    tiles = {args.tile: by_tile[args.tile]} if args.tile else by_tile
    if args.tile and not tiles[args.tile]:
        print(f"no cells in tile {args.tile!r}")
        return 1

    n_cells = sum(len(v) for v in tiles.values())
    print(f"ERA5-Land cell download")
    print(f"  store : {ZARR_URL}")
    print(f"  vars  : {ZARR_VARS}")
    print(f"  scope : {len(tiles)} tile(s), {n_cells} cell(s), years {years}")
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
    for tile_id, tile_cells in tiles.items():
        for year in years:
            frames = process_tile(ds, tile_id, tile_cells, year)
            for cell_id, frame in frames.items():
                path = write_cell_csv(cell_id, frame)
                total_written += 1
            log(f"  tile {tile_id} year {year}: wrote {len(frames)} cell CSVs")

    print(f"\nDone — {total_written} cell-year frames written to {OUT_DIR}")

    # Quick sanity print of the first cell's first tile.
    first_tile = next(iter(tiles))
    sample_id = tiles[first_tile][0]["cell_id"]
    sample_path = OUT_DIR / f"{sample_id}.csv"
    if sample_path.exists():
        import pandas as pd

        df = pd.read_csv(sample_path)
        print(f"\nsample — cell {sample_id} ({sample_path.name}), {len(df)} days:")
        print(df.describe().loc[["min", "mean", "max"]].round(2).to_string())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
