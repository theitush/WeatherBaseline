"""Main resumable ERA5-Land daily pipeline.

For each year (default 1950..present-1):
  1. Submit 3 CDS requests: (tmin, tmax, precip) — bounded concurrency.
  2. For each downloaded file: open with xarray, interp to city points,
     unit-convert, accumulate into a per-city year frame.
  3. After all 3 targets for a year are done, append rows to each
     data/era5/weather_hist_{lat}_{lon}.csv. Delete source files.
  4. Mark (year) done in state.json.

Resumability: years marked done in state.json are skipped.

Output schema: date,min_temperature,max_temperature,precipitation_mm
  - temperatures in °C
  - precipitation in mm
  - filename uses lat/lon rounded to 2dp (matches existing cacheManager.js convention)

Usage:
  source .venv/bin/activate
  python fetch_era5.py --start-year 1950 --end-year 2025 \
      [--cities data/era5/cities.csv] [--max-concurrent 2] [--strategy global|regional]
"""
from __future__ import annotations

import argparse
import concurrent.futures as cf
import csv
import datetime as dt
import json
import sys
import time
from pathlib import Path

import cdsapi
import numpy as np
import pandas as pd

from era5 import (
    COLS,
    TARGETS,
    RequestSpec,
    convert_units,
    dates_from_ds,
    interp_cities,
    open_dataset,
    submit_and_download,
)

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
DATA_DIR = REPO / "data" / "era5"
TMP_DIR = HERE / ".pipeline_tmp"
STATE_PATH = HERE / "state.json"


def load_state() -> dict:
    if STATE_PATH.exists():
        return json.loads(STATE_PATH.read_text())
    return {"done_years": []}


def save_state(state: dict) -> None:
    STATE_PATH.write_text(json.dumps(state, indent=2, sort_keys=True))


def load_cities(path: Path) -> pd.DataFrame:
    df = pd.read_csv(path)
    df["lat"] = df["lat"].astype(float)
    df["lon"] = df["lon"].astype(float)
    df["key"] = df.apply(lambda r: f"{r.lat:.2f}_{r.lon:.2f}", axis=1)
    # Collapse duplicates (cities sharing a 2-dp lat/lon cell)
    df = df.drop_duplicates(subset=["key"]).reset_index(drop=True)
    return df


def csv_path_for(lat: float, lon: float) -> Path:
    return DATA_DIR / f"weather_hist_{lat:.2f}_{lon:.2f}.csv"


def append_year_for_cities(
    cities: pd.DataFrame, year_frames: dict[str, pd.DataFrame]
) -> None:
    """year_frames: target -> DataFrame indexed by date, columns=city keys."""
    dates = year_frames["tmin"].index
    DATA_DIR.mkdir(parents=True, exist_ok=True)

    for _, c in cities.iterrows():
        key = c["key"]
        path = csv_path_for(c["lat"], c["lon"])
        new_exists = not path.exists()
        # Build rows
        rows = []
        tmin = year_frames["tmin"][key].values
        tmax = year_frames["tmax"][key].values
        precip = year_frames["precip"][key].values
        for i, d in enumerate(dates):
            rows.append(
                (
                    pd.Timestamp(d).strftime("%Y-%m-%d"),
                    f"{tmin[i]:.2f}",
                    f"{tmax[i]:.2f}",
                    f"{precip[i]:.3f}",
                )
            )
        mode = "w" if new_exists else "a"
        with path.open(mode, newline="", encoding="utf-8") as f:
            w = csv.writer(f)
            if new_exists:
                w.writerow(["date", "min_temperature", "max_temperature", "precipitation_mm"])
            w.writerows(rows)


def process_target(
    spec: RequestSpec, src: Path, cities: pd.DataFrame
) -> pd.DataFrame:
    """Open downloaded file, interp to cities, unit-convert. Return frame
    indexed by date with one column per city key."""
    ds = open_dataset(src)
    # Identify data var (first non-coord)
    data_vars = list(ds.data_vars)
    if not data_vars:
        raise RuntimeError(f"No data vars in {src}")
    var = data_vars[0]

    lats = cities["lat"].to_numpy()
    lons = cities["lon"].to_numpy()
    arr = interp_cities(ds, lats, lons, var)  # (n_cities, n_days)
    arr = convert_units(spec.target, arr)
    dates = dates_from_ds(ds)
    # arr shape might be (n_days, n_cities) if interp_cities transposed wrong way;
    # interp_cities normalises to (city, time).
    n_cities, n_days = arr.shape
    assert n_days == len(dates), f"shape mismatch {arr.shape} vs {len(dates)} dates"

    frame = pd.DataFrame(
        arr.T,  # (n_days, n_cities)
        index=pd.to_datetime(dates),
        columns=cities["key"].values,
    )
    ds.close()
    return frame


def fetch_year(
    year: int,
    cities: pd.DataFrame,
    client: cdsapi.Client,
    max_concurrent: int,
    area: list[float] | None,
) -> bool:
    """Returns True on success."""
    TMP_DIR.mkdir(parents=True, exist_ok=True)
    specs = {tgt: RequestSpec(year, tgt, area=area) for tgt in TARGETS}
    downloads: dict[str, Path] = {}

    def _dl(tgt: str) -> tuple[str, Path, dict]:
        dest = TMP_DIR / f"{year}_{tgt}.nc"
        stats = submit_and_download(client, specs[tgt], dest, label=f"{year}_{tgt}")
        return tgt, dest, stats

    with cf.ThreadPoolExecutor(max_workers=max_concurrent) as ex:
        futs = [ex.submit(_dl, tgt) for tgt in TARGETS]
        for fut in cf.as_completed(futs):
            tgt, path, stats = fut.result()
            downloads[tgt] = path
            print(
                f"  [{year} {tgt}] downloaded "
                f"{stats['size_mb']:.1f}MB in {stats['elapsed_s']:.0f}s"
            )

    # Interp + convert each target
    year_frames: dict[str, pd.DataFrame] = {}
    for tgt, path in downloads.items():
        t0 = time.time()
        year_frames[tgt] = process_target(specs[tgt], path, cities)
        print(f"  [{year} {tgt}] interpolated in {time.time() - t0:.1f}s")

    # Sanity-check dates align across targets
    base = year_frames["tmin"].index
    for tgt in ("tmax", "precip"):
        if not year_frames[tgt].index.equals(base):
            raise RuntimeError(f"date mismatch between tmin and {tgt} in year {year}")

    # Append rows for every city
    t0 = time.time()
    append_year_for_cities(cities, year_frames)
    print(f"  [{year}] wrote {len(cities)} city CSVs in {time.time() - t0:.1f}s")

    # Clean up downloads
    for path in downloads.values():
        try:
            path.unlink()
        except OSError:
            pass

    return True


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--start-year", type=int, default=1950)
    ap.add_argument(
        "--end-year",
        type=int,
        default=dt.date.today().year - 1,
        help="inclusive; default = last full year",
    )
    ap.add_argument("--cities", default=str(DATA_DIR / "cities.csv"))
    ap.add_argument("--max-concurrent", type=int, default=2)
    ap.add_argument(
        "--strategy",
        choices=["global", "regional"],
        default="global",
        help="ignored for now — main pipeline uses global requests. "
        "(Pick strategy based on benchmark results.)",
    )
    ap.add_argument(
        "--limit-cities",
        type=int,
        default=0,
        help="if >0, only process the first N cities (for testing)",
    )
    args = ap.parse_args()

    cities_path = Path(args.cities)
    if not cities_path.exists():
        print(
            f"cities file not found at {cities_path}; run download_cities.py first",
            file=sys.stderr,
        )
        return 2
    cities = load_cities(cities_path)
    if args.limit_cities:
        cities = cities.head(args.limit_cities).reset_index(drop=True)
    print(f"Loaded {len(cities)} unique cities (2dp grid)")

    state = load_state()
    done = set(state["done_years"])

    client = cdsapi.Client(wait_until_complete=False, quiet=True)

    area = None  # global; benchmark will tell us if we should narrow

    for year in range(args.start_year, args.end_year + 1):
        if year in done:
            print(f"[{year}] already done, skipping")
            continue
        print(f"\n=== {year} ===")
        try:
            fetch_year(year, cities, client, args.max_concurrent, area)
        except Exception as e:  # noqa: BLE001
            print(f"[{year}] FAILED: {e!r}", file=sys.stderr)
            return 1
        state["done_years"].append(year)
        save_state(state)
        print(f"[{year}] done")

    print("\nAll done.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
