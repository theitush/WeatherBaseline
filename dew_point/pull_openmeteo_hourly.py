#!/usr/bin/env python3
"""Pull one hourly variable for one location from Open-Meteo's historical
(reanalysis) archive, in resumable decade chunks, to a single csv.gz.

Default = ERA5-Land dew point at the Tel Aviv product cell (32.1, 34.8), the
full record 1950-01-01 .. 2026-08-22 (ERA5-Land lags ~5 days). Timestamps are
UTC epoch seconds; shift to the cell's local SOLAR clock (round(lon/15) h, as
download_cells.py does) before any daily bucketing.

QUOTA — Open-Meteo bills weighted, FRACTIONAL calls, not HTTP requests:
    weight = nLocations * (nDays / 14) * (nVariables / 10)   [nDays floored at 14]
so 1 var x 1 location x 76.6 years = ~200 calls, whatever the chunking. Free
tier is 600/min, 5k/hour, 10k/day per IP. ALWAYS --dry-run first and quote
the number before pulling anything (see feedback_ask_before_external_api).

Chunks land in data/chunks/ and are skipped on rerun, so a failed pull resumes
instead of re-spending quota. Network/5xx errors are retried ONCE after a pause
(a timed-out request may still have been billed); 429 stops the run.

Usage:
  python pull_openmeteo_hourly.py --dry-run
  python pull_openmeteo_hourly.py
  python pull_openmeteo_hourly.py --var temperature_2m --end 2026-08-22
"""
from __future__ import annotations

import argparse
import gzip
import sys
import time
from datetime import date, timedelta
from pathlib import Path

import pandas as pd
import requests

HOST = "https://archive-api.open-meteo.com/v1/archive"
HERE = Path(__file__).resolve().parent
QUOTA_CHUNK_DAYS = 14
QUOTA_VARS_PER_CALL = 10


def quota_units(days: int, n_vars: int = 1, locations: int = 1) -> float:
    """Weighted Open-Meteo calls one request costs (fractional)."""
    return locations * max(days, QUOTA_CHUNK_DAYS) / QUOTA_CHUNK_DAYS * n_vars / QUOTA_VARS_PER_CALL


def year_chunks(start: date, end: date, years_per_chunk: int) -> list[tuple[date, date]]:
    """Split [start, end] into calendar-aligned spans of <= years_per_chunk years."""
    chunks = []
    chunk_start = start
    while chunk_start <= end:
        next_year = (chunk_start.year // years_per_chunk + 1) * years_per_chunk
        chunk_end = min(end, date(next_year, 1, 1) - timedelta(days=1))
        chunks.append((chunk_start, chunk_end))
        chunk_start = chunk_end + timedelta(days=1)
    return chunks


def fetch_chunk(lat: float, lon: float, var: str, model: str, start: date, end: date) -> pd.DataFrame:
    params = {
        "latitude": lat,
        "longitude": lon,
        "start_date": start.isoformat(),
        "end_date": end.isoformat(),
        "hourly": var,
        "models": model,
        "cell_selection": "nearest",   # the product cell, not Open-Meteo's land/sea guess
        "timezone": "GMT",
        "timeformat": "unixtime",
    }
    session = requests.Session()
    last_error: Exception | None = None
    for attempt in (1, 2):
        try:
            response = session.get(HOST, params=params, timeout=(30, 600))
        except requests.RequestException as exc:
            last_error = exc
            print(f"    network error ({type(exc).__name__}); retrying once in 60 s", flush=True)
            time.sleep(60)
            continue
        if response.status_code == 429:
            sys.exit(f"429 rate-limited: {response.text[:300]}")
        if response.status_code >= 500 and attempt == 1:
            print(f"    HTTP {response.status_code}; retrying once in 60 s", flush=True)
            time.sleep(60)
            continue
        response.raise_for_status()
        body = response.json()
        got_lat, got_lon = body["latitude"], body["longitude"]
        if abs(got_lat - lat) > 0.051 or abs(got_lon - lon) > 0.051:
            sys.exit(f"Open-Meteo answered for grid point ({got_lat}, {got_lon}), "
                     f"not the requested cell ({lat}, {lon}) -- aborting")
        hourly = body["hourly"]
        frame = pd.DataFrame({"time_utc": hourly["time"], var: hourly[var]})
        frame["time_utc"] = pd.to_datetime(frame["time_utc"], unit="s", utc=True)
        print(f"    grid point ({got_lat}, {got_lon}), elevation {body.get('elevation')} m, "
              f"{len(frame)} hours, {frame[var].isna().sum()} missing", flush=True)
        return frame
    raise RuntimeError(f"chunk {start}..{end} failed twice: {last_error}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--lat", type=float, default=32.1)
    parser.add_argument("--lon", type=float, default=34.8)
    parser.add_argument("--var", default="dew_point_2m")
    parser.add_argument("--model", default="era5_land")
    parser.add_argument("--start", type=date.fromisoformat, default=date(1950, 1, 1))
    parser.add_argument("--end", type=date.fromisoformat, default=date(2026, 8, 22))
    parser.add_argument("--chunk-years", type=int, default=10)
    parser.add_argument("--out", type=Path, default=None,
                        help="default data/<var>_<model>_<lat>_<lon>_hourly.csv.gz")
    parser.add_argument("--dry-run", action="store_true", help="print the plan + quota cost, fetch nothing")
    args = parser.parse_args()

    out = args.out or HERE / "data" / f"{args.var}_{args.model}_{args.lat}_{args.lon}_hourly.csv.gz"
    chunk_dir = HERE / "data" / "chunks"
    chunks = year_chunks(args.start, args.end, args.chunk_years)
    total_days = (args.end - args.start).days + 1
    print(f"{args.var} / {args.model} at ({args.lat}, {args.lon}), {args.start} .. {args.end}: "
          f"{total_days} days, ~{total_days * 24:,} hourly values")
    print(f"{len(chunks)} HTTP request(s); weighted Open-Meteo cost = "
          f"{sum(quota_units((e - s).days + 1) for s, e in chunks):.1f} calls "
          f"(free tier: 10k/day)")

    frames = []
    for chunk_start, chunk_end in chunks:
        chunk_file = chunk_dir / f"{args.var}_{args.model}_{args.lat}_{args.lon}_{chunk_start}_{chunk_end}.csv"
        status = "cached" if chunk_file.exists() else f"{quota_units((chunk_end - chunk_start).days + 1):.1f} calls"
        print(f"  {chunk_start} .. {chunk_end}  [{status}]", flush=True)
        if args.dry_run:
            continue
        if chunk_file.exists():
            frames.append(pd.read_csv(chunk_file, parse_dates=["time_utc"]))
            continue
        frame = fetch_chunk(args.lat, args.lon, args.var, args.model, chunk_start, chunk_end)
        chunk_dir.mkdir(parents=True, exist_ok=True)
        frame.to_csv(chunk_file, index=False)
        frames.append(frame)
        time.sleep(2)

    if args.dry_run:
        return
    combined = pd.concat(frames, ignore_index=True).sort_values("time_utc").drop_duplicates("time_utc")
    out.parent.mkdir(parents=True, exist_ok=True)
    with gzip.open(out, "wt") as handle:
        combined.to_csv(handle, index=False, date_format="%Y-%m-%dT%H:%M:%SZ")
    print(f"wrote {out}: {len(combined):,} hours, {combined['time_utc'].min()} .. {combined['time_utc'].max()}, "
          f"{combined[args.var].isna().sum()} missing")


if __name__ == "__main__":
    main()
