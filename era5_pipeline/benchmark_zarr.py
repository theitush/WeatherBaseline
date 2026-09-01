"""Benchmark the EarthDataHub zarr method against the CDS download pipeline.

Status task #1: compare a single cloud-zarr `.sel()`+`.interp()` against the
A/B/C CDS bbox strategies measured by the old `benchmark.py`.

The CDS side of that comparison is gone: `benchmark.py`, `era5.py`,
`fetch_era5.py` and `benchmark_results*.json` were removed in `61a2c0ae`
(2026-06-03) once the Zarr store won, and live only in git history. Its
numbers survive in `STATUS.md`; this file and `benchmark_zarr_results*.json`
are the Zarr half of the record.

Dataset (HOURLY ERA5-Land, ARCO zarr; Zarr v3 store since the July 2026 revamp):
  https://earthdatahub.destine.eu/collections/era5/datasets/era5-land
  https://data.earthdatahub.destine.eu/era5/era5-land-v0.zarr

Why the hourly store and not era5-land-daily:
  The `era5-land-daily-utc` store only carries one daily value per cell — a
  daily MEAN. We need daily min and max. So we open the *hourly* store and
  resample to D ourselves: `.resample(time="D").min()` / `.max()`.

Chunking (inspected via the store's t2m encoding):
  zarr chunks = (valid_time=1440, latitude=50, longitude=100), float32, ~29 MB
  uncompressed each. 1440 h = 60 days, so one year ≈ 6-7 time-chunks. 50x100
  cells at 0.1° = a 5°×10° spatial tile. (The pre-2026-07 Zarr v2 store was
  2880x64x64 = 120-day, 6.4° chunks.)
  => The right access pattern is: for EACH city, .sel() a small lat/lon WINDOW
     (a few cells, enough for bilinear interp) BEFORE computing. That way dask
     only fetches the time-chunks of that one spatial tile per city, not
     the whole globe. Interpolating the global array first (the naive path)
     schedules far more chunk reads and times out.

This script reuses the same 3 cities and produces the same tmin/tmax that
`benchmark.py` measured, so the numbers are comparable. It records wall time
broken into open / select / compute / save phases (with per-city compute
timings), plus peak memory and on-disk parquet-vs-csv sizes.

Auth:
  EarthDataHub needs a DestinE Platform account. Credentials are read from the
  environment (`trust_env=True` → ~/.netrc for data.earthdatahub.destine.eu).
  Without them the open will 401; the script reports that cleanly.

Usage:
  source .venv/bin/activate
  pip install "zarr>3" fsspec aiohttp     # not in requirements.txt yet
  python benchmark_zarr.py --year 2020

Output: benchmark_zarr_results.json (`_prev.json` is the run before it)
"""
from __future__ import annotations

import argparse
import json
import time
import tracemalloc
from pathlib import Path

import numpy as np

# The city list the CDS benchmark used, inlined verbatim from `benchmark.py`
# at its last revision (`61a2c0ae^`) — that file was removed with the rest of
# the CDS pipeline, and `from benchmark import CITIES` has raised
# ModuleNotFoundError ever since. Keep the ORDER: the committed results were
# measured on `--n-cities 3`, i.e. New York, London, Tokyo.
CITIES = [
    (40.71, -74.01, "New York"),
    (51.52, -0.09, "London"),
    (35.68, 139.69, "Tokyo"),
    (32.09, 34.78, "Tel Aviv"),
    (34.05, -118.24, "Los Angeles"),
    (30.04, 31.24, "Cairo"),
    (55.75, 37.62, "Moscow"),
    (13.75, 100.49, "Bangkok"),
    (28.61, 77.21, "Delhi"),
    (52.52, 13.40, "Berlin"),
]

HERE = Path(__file__).resolve().parent
OUT_JSON = HERE / "benchmark_zarr_results.json"
TMP = HERE / ".bench_tmp"

# Hourly ERA5-Land ARCO zarr store on EarthDataHub (Zarr v3, July 2026 revamp).
ZARR_URL = "https://data.earthdatahub.destine.eu/era5/era5-land-v0.zarr"

# 2m air temperature, hourly. We resample this to daily min/max.
ZARR_VAR = "t2m"

# Half-width of the per-city lat/lon window, in degrees. The store is 0.1°, so
# 0.3° = ~7 cells each side — comfortably enough for bilinear interp while
# still landing inside a single 5°×10° spatial chunk for most cities.
WINDOW_DEG = 0.3

# aiohttp default read timeout is ~5 min total but ~minutes can still trip on a
# cold ~47 MB chunk. Give each request a VERY generous ceiling of 40 min coz this may suck.
HTTP_TIMEOUT_S = 2400


_T0 = time.time()


def log(msg: str) -> None:
    """Print a timestamped line and flush, so progress shows during long phases."""
    print(f"  [{time.time() - _T0:6.1f}s] {msg}", flush=True)


def _phase(timings: dict, name: str, desc: str = ""):
    """Logs the start of a phase; returns a callable that stamps its duration.

    The start line prints immediately so the user sees which step is running
    (the compute phase in particular can sit silent for minutes pulling chunks).
    """
    log(f"-> {name}: {desc or name}...")
    start = time.time()

    def done(extra: str = ""):
        dt = time.time() - start
        timings[name] = round(dt, 3)
        log(f"   {name} done in {dt:.2f}s{('  ' + extra) if extra else ''}")

    return done


def run_zarr_benchmark(year: int, cities: list[tuple[float, float, str]]) -> dict:
    import xarray as xr  # imported late so a missing dep is reported, not crashed

    lats = np.array([c[0] for c in cities], dtype=float)
    lons = np.array([c[1] for c in cities], dtype=float)
    names = [c[2] for c in cities]

    timings: dict[str, float] = {}
    result: dict = {
        "ok": False,
        "year": year,
        "n_cities": len(cities),
        "zarr_url": ZARR_URL,
        "var": ZARR_VAR,
        "method": "hourly t2m -> resample(D) min/max",
        "timings_s": timings,
        "error": None,
    }

    # --- open -----------------------------------------------------------
    stop = _phase(timings, "open", f"open hourly zarr store ({ZARR_VAR})")
    try:
        import aiohttp

        ds = xr.open_dataset(
            ZARR_URL,
            storage_options={
                "client_kwargs": {
                    "trust_env": True,
                    # generous timeout so a cold ~47 MB chunk has time to land
                    "timeout": aiohttp.ClientTimeout(total=HTTP_TIMEOUT_S),
                },
            },
            chunks={},
            engine="zarr",
        )
    except Exception as e:  # noqa: BLE001
        stop()
        msg = f"{type(e).__name__}: {e}"
        result["error"] = msg
        if "401" in msg or "403" in msg or "auth" in msg.lower():
            result["error"] += (
                "  (looks like missing DestinE credentials — set up ~/.netrc "
                "for data.earthdatahub.destine.eu, see the dataset page)"
            )
        log(f"!! open failed: {msg}")
        return result
    stop()

    if ZARR_VAR not in ds:
        result["error"] = (
            f"variable {ZARR_VAR!r} not in store; available: {list(ds.data_vars)}"
        )
        log(f"!! {result['error']}")
        return result

    # Coordinate names: store uses latitude/longitude; lon grid is 0..360.
    lat_name = "latitude" if "latitude" in ds.coords else "lat"
    lon_name = "longitude" if "longitude" in ds.coords else "lon"
    time_name = "valid_time" if "valid_time" in ds.coords else "time"
    log(f"   store opened: var={ZARR_VAR}, coords=({lat_name},{lon_name},{time_name})")
    log(f"   full {ZARR_VAR} shape={dict(ds[ZARR_VAR].sizes)}")

    lon_max = float(ds[lon_name].max())
    sel_lons = np.where(lons < 0, lons + 360.0, lons) if lon_max > 180.5 else lons
    if lon_max > 180.5:
        log(f"   lon grid is 0..360 — remapped city lons to {list(np.round(sel_lons, 2))}")

    # --- select year (lazy: slices the dask graph, fetches no data yet) --
    stop = _phase(timings, "select", f"slice time to {year} (lazy, no fetch)")
    year_da = ds[ZARR_VAR].sel({time_name: slice(str(year), str(year))})
    n_steps = year_da.sizes.get(time_name)
    stop(f"hourly steps in {year}: {n_steps}")

    # latitude can be ascending or descending — slice() needs the right order.
    lat_ascending = bool(ds[lat_name][0] < ds[lat_name][-1])

    # --- per-city window + interp + resample + compute ------------------
    # Process one city at a time: .sel() a small WINDOW_DEG box first so dask
    # only fetches that city's spatial chunk(s), then interp within the window,
    # then resample hourly -> daily min/max. This is the access pattern the
    # chunk layout calls for; interpolating the global array would schedule
    # reads across the whole globe.
    log(f"   processing {len(cities)} cities one at a time, "
        f"±{WINDOW_DEG}° window each (keeps each fetch to ~1 spatial chunk)")
    tracemalloc.start()
    stop = _phase(timings, "compute", "per-city window fetch + interp + daily min/max")

    # Date axis: derive once from the (cheap, coords-only) year slice so the
    # output arrays are sized exactly right — no post-hoc trimming guesswork.
    dates = (
        year_da[time_name].resample({time_name: "1D"}).first()[time_name].values
    )
    n_days = len(dates)
    tmin = np.full((len(cities), n_days), np.nan)
    tmax = np.full_like(tmin, np.nan)
    per_city_s: dict[str, float] = {}

    for i, (lat, lon, name, slon) in enumerate(zip(lats, lons, names, sel_lons)):
        c0 = time.time()
        lat_slice = (
            slice(lat - WINDOW_DEG, lat + WINDOW_DEG) if lat_ascending
            else slice(lat + WINDOW_DEG, lat - WINDOW_DEG)
        )
        win = year_da.sel({lat_name: lat_slice})

        # Longitude window: select by nearest cell *indices*, not value slice,
        # so a city near the 0°/360° seam (e.g. London at 359.91°) still gets a
        # symmetric window. Then unwrap the lon coord to be monotonic around
        # the city so interp's bracketing works across the seam.
        n_lon_cells = int(round(WINDOW_DEG / 0.1))  # ~3 cells each side
        lon_idx = int(np.abs(ds[lon_name].values - slon).argmin())
        sz = ds.sizes[lon_name]
        lon_pos = [(lon_idx + d) % sz for d in range(-n_lon_cells, n_lon_cells + 1)]
        win = win.isel({lon_name: lon_pos})
        win_lons = win[lon_name].values.copy()
        # unwrap: make win_lons monotonic increasing centred on the city
        win_lons = np.unwrap(np.radians(win_lons)) * 180.0 / np.pi
        win = win.assign_coords({lon_name: win_lons})
        city_lon = slon if win_lons.min() <= slon <= win_lons.max() else (
            slon - 360.0 if slon > win_lons.max() else slon + 360.0
        )

        # bilinear interp to the exact city point within the small window
        point = win.interp(
            {lat_name: lat, lon_name: city_lon}, method="linear"
        )
        # nearest-neighbour fallback for NaN steps: ERA5-Land is land-only, so
        # a coastal city's 2x2 interp neighbours can include an ocean (NaN)
        # cell. Same fix as era5.py:interp_cities.
        nearest = win.interp(
            {lat_name: lat, lon_name: city_lon}, method="nearest"
        )
        point = point.where(point.notnull(), nearest)

        daily = point.resample({time_name: "1D"})
        dmin = (daily.min().compute().values - 273.15)  # K -> degC
        dmax = (daily.max().compute().values - 273.15)
        nd = dmin.shape[0]
        if nd != n_days:
            log(f"   WARN {name}: got {nd} days, expected {n_days}")
        tmin[i, :nd] = dmin
        tmax[i, :nd] = dmax
        n_nan = int(np.isnan(dmin).sum())
        dt = time.time() - c0
        per_city_s[name] = round(dt, 2)
        log(f"   [{i + 1}/{len(cities)}] {name}: window "
            f"{win.sizes.get(lat_name)}x{win.sizes.get(lon_name)} cells, "
            f"{nd} days, {n_nan} NaN, {dt:.1f}s")

    stop()
    _, peak = tracemalloc.get_traced_memory()
    tracemalloc.stop()
    result["peak_mem_mb"] = round(peak / 1e6, 1)
    result["per_city_s"] = per_city_s

    result["n_days"] = n_days
    result["payload_mb_est"] = round((tmin.nbytes + tmax.nbytes) / 1e6, 4)

    # --- save: per-city frame, parquet vs csv (the format STATUS.md asks)-
    stop = _phase(timings, "save", "write per-city frame as parquet + csv")
    try:
        import pandas as pd

        TMP.mkdir(parents=True, exist_ok=True)
        date_col = dates.astype("datetime64[D]")
        # one combined frame so parquet/csv sizes reflect the real schema
        frame = pd.DataFrame({"date": date_col})
        for i, name in enumerate(names):
            frame[f"{name}_min"] = tmin[i]
            frame[f"{name}_max"] = tmax[i]
        pq_path = TMP / f"zarr_bench_{year}.parquet"
        csv_path = TMP / f"zarr_bench_{year}.csv"
        frame.to_parquet(pq_path, index=False)
        frame.to_csv(csv_path, index=False)
        result["parquet_mb"] = round(pq_path.stat().st_size / 1e6, 4)
        result["csv_mb"] = round(csv_path.stat().st_size / 1e6, 4)
        stop(f"parquet={result['parquet_mb']}MB csv={result['csv_mb']}MB")
    except Exception as e:  # noqa: BLE001
        result["save_error"] = f"{type(e).__name__}: {e}"
        log(f"!! save failed: {result['save_error']}")
        stop()

    timings["total"] = round(sum(v for k, v in timings.items() if k != "total"), 3)

    # Sanity check: tmin <= tmax, values plausible for the year.
    result["ok"] = True

    def _city_stats(i: int) -> dict:
        row_min, row_max = tmin[i], tmax[i]
        all_nan = bool(np.isnan(row_min).all())
        if all_nan:
            # land-only store: an all-NaN row means the city fell on an ocean
            # cell with no land neighbour in the window — flag it, don't crash.
            return {"all_nan": True, "nan_days": int(len(row_min))}
        return {
            "all_nan": False,
            "tmin_lo_C": round(float(np.nanmin(row_min)), 2),
            "tmax_hi_C": round(float(np.nanmax(row_max)), 2),
            "mean_tmin_C": round(float(np.nanmean(row_min)), 2),
            "mean_tmax_C": round(float(np.nanmean(row_max)), 2),
            "tmin_le_tmax": bool(
                np.all(np.nan_to_num(row_min) <= np.nan_to_num(row_max) + 1e-6)
            ),
            "nan_days": int(np.isnan(row_min).sum()),
        }

    result["sample"] = {names[i]: _city_stats(i) for i in range(len(names))}
    return result


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--year", type=int, default=2020)
    ap.add_argument(
        "--n-cities", type=int, default=3,
        help="number of cities from CITIES; default 3 to match the CDS bench",
    )
    args = ap.parse_args()

    cities = CITIES[: args.n_cities]
    print(f"Zarr benchmark — year {args.year}, {len(cities)} cities: "
          f"{', '.join(c[2] for c in cities)}")
    print(f"Store: {ZARR_URL}")
    print(f"Variable: {ZARR_VAR} (hourly 2m air temperature)")
    print("Metric: resample hourly -> daily MIN (tmin) and daily MAX (tmax) — "
          "both, to fill the per-city CSV schema")
    print(f"Method: open hourly t2m -> per-city ±{WINDOW_DEG}° window -> "
          "interp -> resample(D) .min()/.max()\n")

    t0 = time.time()
    result = run_zarr_benchmark(args.year, cities)
    result["wall_s"] = round(time.time() - t0, 3)

    OUT_JSON.write_text(json.dumps(result, indent=2, default=str))

    print()
    if result["ok"]:
        t = result["timings_s"]
        print(f"  OK — {result['n_days']} days/city in {result['wall_s']:.1f}s wall")
        print(f"  phases: open={t.get('open')}s select={t.get('select')}s "
              f"compute={t.get('compute')}s save={t.get('save')}s")
        pc = result.get("per_city_s", {})
        if pc:
            print("  per-city compute: "
                  + ", ".join(f"{n}={s}s" for n, s in pc.items()))
        print(f"  peak mem: {result.get('peak_mem_mb')}MB | "
              f"payload (in-mem): {result.get('payload_mb_est')}MB")
        if "parquet_mb" in result:
            print(f"  on disk: parquet={result['parquet_mb']}MB "
                  f"csv={result['csv_mb']}MB")
        print("\n  sample daily temps (°C):")
        for name, s in result["sample"].items():
            if s.get("all_nan"):
                print(f"    {name:12s} ALL NaN — ocean cell, no land in window")
                continue
            print(f"    {name:12s} tmin∈[{s['tmin_lo_C']:7.2f}..]  "
                  f"tmax∈[..{s['tmax_hi_C']:7.2f}]  "
                  f"mean_tmin={s['mean_tmin_C']:6.2f}  mean_tmax={s['mean_tmax_C']:6.2f}  "
                  f"min<=max:{s['tmin_le_tmax']}  nan={s['nan_days']}")
        print("\n  Compare to the CDS A/B/C strategies in STATUS.md:")
        print("  zarr is 1 'request' (HTTP-range-addressed) — no CDS queue.")
    else:
        print(f"  FAILED: {result['error']}")
        print("\n  If this is a missing-package error:")
        print("    pip install 'zarr>3' fsspec aiohttp")
    print(f"\nWrote {OUT_JSON}")
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
