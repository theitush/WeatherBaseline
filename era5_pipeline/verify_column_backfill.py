#!/usr/bin/env python3
"""Gate for a column backfill (download_cells.py --vars X): did the run add the
new column and change NOTHING else?

Compares every cell of the given tiles against a baseline snapshot of the R2
archives taken before the run (a directory of archive_{lat}_{lon}.csv.gz):

  * every shipped column is byte-identical on every shared date;
  * dates are a superset (a trailing top-up may append, never drop);
  * the new column is non-null on ~every day of every year through the store's
    newest day, and physically sane (dew point never above the day's tmax);
  * optionally, one cell is cross-checked against an INDEPENDENT hourly pull
    (scripts/dew_point/pull_openmeteo_hourly.py: Open-Meteo's era5_land hourly
    d2m at the same 0.1deg point) aggregated by the same rule — daily mean over
    the local solar day, whole days only. Same reanalysis, same rule: the
    archive must match to a few thousandths of a degree.

Reads R2 (r2.env) and local files only; writes nothing.

Usage:
  set -a && source r2.env && set +a
  python verify_column_backfill.py --tiles 17_10,6_3,11_3 \\
      --baseline ../../data/era5-land/baseline_pre_dewpt \\
      --hourly ../dew_point/data/dew_point_2m_era5_land_32.1_34.8_hourly.csv.gz \\
      --hourly-cell 32.1,34.8
"""
from __future__ import annotations

import argparse
import csv
import io
import sys
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import date
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from download_cells import ARCHIVE_COLUMNS, archive_name, whole_day_mask  # noqa: E402
from r2_upload import R2Uploader  # noqa: E402

CELLS_CSV = HERE.parent.parent / "data" / "cells.csv"


def read_gz(body: bytes) -> pd.DataFrame:
    return pd.read_csv(io.BytesIO(body), compression="gzip")


def hourly_daily_mean(hourly_csv: Path, lon: float, var: str = "dew_point_2m") -> pd.Series:
    """Local-solar-day mean of an hourly series, whole (24 h) days only, degC."""
    raw = pd.read_csv(hourly_csv, parse_dates=["time_utc"])
    off_h = int(round(lon / 15.0))
    utc = raw["time_utc"].dt.tz_convert(None) if raw["time_utc"].dt.tz is not None else raw["time_utc"]
    local = utc + pd.Timedelta(hours=off_h)
    series = pd.Series(raw[var].to_numpy(dtype="float64"), index=local)
    by_day = series.groupby(series.index.floor("D"))
    daily = by_day.mean()[by_day.count() == 24]
    daily.index = daily.index.date
    return daily


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--tiles", required=True, help="comma-separated tile ids")
    ap.add_argument("--baseline", type=Path, required=True,
                    help="dir of pre-run archive_{lat}_{lon}.csv.gz snapshots")
    ap.add_argument("--column", default="dewpt_mean_C")
    ap.add_argument("--upper-bound", default="tmax_C",
                    help="the new column must not exceed this one (+ --slack)")
    ap.add_argument("--slack", type=float, default=0.5)
    ap.add_argument("--hourly", type=Path, help="independent hourly pull (csv.gz)")
    ap.add_argument("--hourly-cell", help="lat,lon of that pull's cell")
    ap.add_argument("--hourly-tol", type=float, default=0.05,
                    help="max |archive - hourly-derived| allowed, degC")
    ap.add_argument("--workers", type=int, default=16)
    args = ap.parse_args()

    tiles = {t.strip() for t in args.tiles.split(",") if t.strip()}
    cells = [r for r in csv.DictReader(open(CELLS_CSV)) if r["tile_id"] in tiles]
    up = R2Uploader()
    print(f"{len(cells)} cells in tiles {sorted(tiles)}; fetching current R2 archives…")

    def fetch(c):
        name = archive_name(float(c["lat"]), float(c["lon"]))
        return name, up.get_bytes(f"archive/{name}")

    with ThreadPoolExecutor(args.workers) as ex:
        current = dict(ex.map(fetch, cells))

    problems: list[str] = []
    shipped = [col for col in ARCHIVE_COLUMNS if col not in ("date", args.column)]
    cover_min: dict[int, int] = defaultdict(lambda: 10**9)
    n_no_column = 0
    newest = None
    for c in cells:
        name = archive_name(float(c["lat"]), float(c["lon"]))
        body = current.get(name)
        if not body:
            problems.append(f"{name}: missing from R2 now")
            continue
        new = read_gz(body)
        base_path = args.baseline / name
        if not base_path.exists():
            problems.append(f"{name}: no baseline snapshot")
            continue
        base = pd.read_csv(base_path, compression="gzip")

        # 1. shipped columns byte-identical on shared dates; dates a superset
        missing_dates = set(base["date"]) - set(new["date"])
        if missing_dates:
            problems.append(f"{name}: {len(missing_dates)} baseline date(s) vanished")
        joined = base.merge(new, on="date", suffixes=("_base", "_new"))
        for col in shipped:
            if col not in base.columns:
                continue
            a = joined[f"{col}_base"].to_numpy(dtype="float64")
            b = joined[f"{col}_new"].to_numpy(dtype="float64")
            same = (a == b) | (np.isnan(a) & np.isnan(b))
            if not same.all():
                bad = joined.loc[~same, "date"].head(3).tolist()
                problems.append(f"{name}: {col} changed on {int((~same).sum())} date(s), e.g. {bad}")

        # 2. the new column: present, covered, sane
        if args.column not in new.columns:
            n_no_column += 1
            problems.append(f"{name}: no {args.column} column")
            continue
        dates = pd.to_datetime(new["date"])
        has = new[args.column].notna()
        for y, n in dates[has].dt.year.value_counts().items():
            cover_min[int(y)] = min(cover_min[int(y)], int(n))
        last = dates[has].max()
        newest = last if newest is None else min(newest, last)
        if args.upper_bound in new.columns:
            over = (new[args.column] > new[args.upper_bound] + args.slack)
            if over.any():
                problems.append(f"{name}: {args.column} above {args.upper_bound}+{args.slack} "
                                f"on {int(over.sum())} day(s), e.g. {new.loc[over, 'date'].head(2).tolist()}")

    # coverage summary: every past year should hold ~365 covered rows
    years = sorted(cover_min)
    short = {y: n for y, n in cover_min.items()
             if y < (newest.year if newest is not None else 9999) and n < 360}
    print(f"\n{args.column}: covered years {years[0] if years else '-'}..{years[-1] if years else '-'}, "
          f"min covered rows/year over all cells: "
          f"{min(cover_min.values()) if cover_min else 0}; "
          f"newest covered day (min over cells): {newest.date() if newest is not None else None}")
    if short:
        problems.append(f"years with < 360 covered rows in some cell: {short}")

    # 3. independent hourly cross-check
    if args.hourly and args.hourly_cell:
        lat, lon = (float(x) for x in args.hourly_cell.split(","))
        name = archive_name(lat, lon)
        body = current.get(name) or up.get_bytes(f"archive/{name}")
        arch = read_gz(body)
        arch_series = pd.Series(arch[args.column].to_numpy(dtype="float64"),
                                index=pd.to_datetime(arch["date"]).dt.date)
        ref = hourly_daily_mean(args.hourly, lon)
        shared = arch_series.index.intersection(ref.index)
        delta = (arch_series.loc[shared] - ref.loc[shared]).dropna()
        print(f"\nhourly cross-check {name}: {len(shared)} shared days, "
              f"max |delta| = {delta.abs().max():.4f} degC, mean delta = {delta.mean():+.4f}, "
              f"days over {args.hourly_tol}: {int((delta.abs() > args.hourly_tol).sum())}")
        worst = delta.abs().sort_values(ascending=False).head(5)
        print("  worst:", ", ".join(f"{d}: {v:+.3f}" for d, v in delta.loc[worst.index].items()))
        if delta.abs().max() > args.hourly_tol:
            problems.append(f"hourly cross-check exceeds {args.hourly_tol} degC")
        if len(shared) < 0.9 * len(ref):
            problems.append(f"hourly cross-check covers only {len(shared)}/{len(ref)} days")

    print()
    if problems:
        print(f"FAIL — {len(problems)} problem(s):")
        for p in problems[:40]:
            print("  -", p)
        if len(problems) > 40:
            print(f"  (+{len(problems) - 40} more)")
        return 1
    print(f"PASS — {len(cells)} cells: shipped columns untouched, {args.column} present and covered")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
