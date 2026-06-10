"""Pull an ARCHIVE (ERA5-Land) vs IFS-HRES overlap dataset for the bias study.

READ-ONLY research tool. It does NOT mutate the live R2 db; it only DOWNLOADS
the 20 pilot cells' archive objects to a dedicated local dir and fetches the
HRES side from the public API.

The comparison that matters for the app:
  - baseline : the ARCHIVE tier the app computes percentiles against. This is
               our own ERA5-Land pull (4 daily vars incl. precip/wind), stored
               as archive/archive_{lat}_{lon}.csv.gz in R2 (bucket
               weather-baseline). We pull each pilot cell's object from R2 to
               scripts/bias_study/data/archive/ and read the baseline off disk.
  - hres     : IFS-HRES historical (historical-forecast-api), the settled-date
               proxy for the forecast tier, fetched at the IDENTICAL snapped
               0.1deg point with cell_selection=nearest.

NOTE (smoke-test finding): the archive-*api* era5_land endpoint returns null
for precip/wind, which is exactly why ensureFresh sources those elsewhere. So
the baseline MUST come from our own archive .gz (which has all 4 vars), not
re-fetched from the archive API.

Output is tidy long CSV:  cell_id,name,regime,lat,lon,date,var,baseline,hres

Open-Meteo cost: only the HRES side hits the API. ceil(vars/10)*ceil(days/14)
per cell = 1 * 53 = ~53 calls/cell for a 2-yr window. 20 cells => ~1060 calls
(~11% of the 10k/day free tier). R2 GETs are not metered against that.

Usage:
  python pull_overlap.py                 # full pilot (20 cells), 2-yr window
  python pull_overlap.py --years 1       # cheaper 1-yr window
  python pull_overlap.py --only London   # single cell smoke test
"""
from __future__ import annotations

import argparse
import csv
import gzip
import io
import os
import sys
import time
from datetime import date, timedelta
from pathlib import Path

import boto3
import requests
from botocore.config import Config

HERE = Path(__file__).resolve().parent
ARCHIVE_DIR = HERE / "data" / "archive"
OUT = HERE / "data" / "overlap.csv"
R2_ENV = HERE.parent / "era5_pipeline" / "r2.env"

HISTFC_API = "https://historical-forecast-api.open-meteo.com/v1/forecast"

# Open-Meteo daily field -> our schema name. Matches the archive .gz columns.
VARS = {
    "temperature_2m_max": "tmax",
    "temperature_2m_min": "tmin",
    "precipitation_sum": "precip",
    "wind_speed_10m_max": "wind_max",
}
HRES_FIELDS = ",".join(VARS)
# Archive .gz column name per schema var (schema: date,tmax_C,tmin_C,precip_mm,wind_max_ms)
ARCHIVE_COL = {"tmax": "tmax_C", "tmin": "tmin_C", "precip": "precip_mm", "wind_max": "wind_max_ms"}

# End the window a few days behind today so HRES historical is fully settled.
END_LAG_DAYS = 10
SLEEP_BETWEEN_CELLS_S = 6.0


def snap(coord: float) -> float:
    """Round to the canonical 0.1deg grid, matching worker cellStore.snap."""
    return round(coord * 10) / 10


# 20-cell stratified pilot: (name, lat, lon, regime). Snapped before use.
PILOT_CELLS = [
    ("Chicago", 41.9, -87.7, "flat_inland"),
    ("Brest_BY", 52.1, 23.7, "flat_inland"),
    ("Beijing", 39.9, 116.4, "flat_inland_china"),
    ("Denver", 39.7, -105.0, "mountain"),
    ("Innsbruck", 47.3, 11.4, "mountain_alps"),
    ("Kathmandu", 27.7, 85.3, "mountain_himalaya"),
    ("Cusco", -13.5, -72.0, "mountain_andes"),
    ("La_Paz", -16.5, -68.1, "mountain_andes"),
    ("Srinagar", 34.1, 74.8, "mountain_himalaya"),
    ("Reykjavik", 64.1, -21.9, "high_lat"),
    ("Edinburgh", 56.0, -3.2, "high_lat_coast"),
    ("London", 51.5, -0.1, "nw_europe"),
    ("Plymouth", 50.4, -4.1, "nw_europe_coast"),
    ("Cape_Town", -34.0, 18.5, "coast_storm"),
    ("Wellington", -41.3, 174.8, "coast_storm"),
    ("Wichita", 37.7, -97.3, "great_plains"),
    ("Oklahoma_City", 35.5, -97.6, "great_plains"),
    ("Manaus", -3.1, -60.0, "tropics_amazon"),
    ("Singapore", 1.4, 103.8, "tropics_itcz"),
    ("Lagos", 6.5, 3.3, "tropics_monsoon"),
]


def r2_client():
    if R2_ENV.exists():
        for line in R2_ENV.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ.setdefault(k, v)
    acct = os.environ["R2_ACCOUNT_ID"]
    return boto3.client(
        "s3",
        endpoint_url=f"https://{acct}.r2.cloudflarestorage.com",
        aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
        config=Config(signature_version="s3v4"),
    ), os.environ.get("R2_BUCKET", "weather-baseline")


def fetch_archive_from_r2(s3, bucket, slat, slon) -> Path:
    """Download archive/archive_{slat}_{slon}.csv.gz from R2 to our local dir."""
    key = f"archive/archive_{slat:.1f}_{slon:.1f}.csv.gz"
    dest = ARCHIVE_DIR / f"archive_{slat:.1f}_{slon:.1f}.csv.gz"
    dest.parent.mkdir(parents=True, exist_ok=True)
    if not dest.exists():
        s3.download_file(bucket, key, str(dest))
    return dest


def read_archive_baseline(path: Path, start: str, end: str) -> dict:
    """{date: {var: value}} from the archive .gz, restricted to [start,end]."""
    out = {}
    with gzip.open(path, "rt") as f:
        for row in csv.DictReader(f):
            d = row["date"]
            if d < start or d > end:
                continue
            out[d] = {}
            for vname, col in ARCHIVE_COL.items():
                v = row.get(col, "")
                out[d][vname] = float(v) if v not in ("", None) else None
    return out


def fetch_hres(slat, slon, start, end) -> dict:
    """{date: {var: value}} from IFS-HRES historical at the snapped point."""
    params = {
        "latitude": slat, "longitude": slon,
        "start_date": start, "end_date": end,
        "daily": HRES_FIELDS, "wind_speed_unit": "ms",
        "timezone": "auto", "cell_selection": "nearest",
    }
    for attempt in range(4):
        if attempt:
            time.sleep(2 ** attempt)
        r = requests.get(HISTFC_API, params=params, timeout=60,
                         headers={"User-Agent": "HowHotWasIt-biasstudy/0.1"})
        if r.ok:
            daily = r.json().get("daily", {})
            times = daily.get("time", [])
            out = {}
            for i, d in enumerate(times):
                out[d] = {v: daily.get(fld, [None] * len(times))[i]
                          for fld, v in VARS.items()}
            return out
        if r.status_code < 500 and r.status_code != 429:
            raise RuntimeError(f"{r.status_code} {r.text[:200]}")
    raise RuntimeError(f"HRES failed after retries (last {r.status_code})")


def rows_for_cell(s3, bucket, name, lat, lon, regime, start, end):
    slat, slon = snap(lat), snap(lon)
    apath = fetch_archive_from_r2(s3, bucket, slat, slon)
    base = read_archive_baseline(apath, start, end)
    hres = fetch_hres(slat, slon, start, end)
    out = []
    for d in sorted(set(base) | set(hres)):
        b = base.get(d, {})
        h = hres.get(d, {})
        for v in VARS.values():
            bv, hv = b.get(v), h.get(v)
            if bv is None and hv is None:
                continue
            out.append({"cell_id": name, "name": name, "regime": regime,
                        "lat": slat, "lon": slon, "date": d, "var": v,
                        "baseline": bv, "hres": hv})
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--years", type=float, default=2.0)
    ap.add_argument("--only")
    ap.add_argument("--out", default=str(OUT))
    args = ap.parse_args()

    end = date.today() - timedelta(days=END_LAG_DAYS)
    start = end - timedelta(days=round(365.25 * args.years))
    s, e = start.isoformat(), end.isoformat()

    cells = PILOT_CELLS
    if args.only:
        cells = [c for c in cells if args.only.lower() in c[0].lower()]
        if not cells:
            sys.exit(f"no pilot cell matches {args.only!r}")

    calls = len(cells) * -(-((end - start).days + 1) // 14)  # HRES side only
    print(f"window {s} .. {e}  ({(end-start).days+1} days)")
    print(f"{len(cells)} cells: archive from R2 (free) + ~{calls} HRES API calls "
          f"({calls/10000:.1%} of daily quota)\n")

    s3, bucket = r2_client()
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    fields = ["cell_id", "name", "regime", "lat", "lon", "date", "var",
              "baseline", "hres"]
    n = 0
    with open(args.out, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        for idx, (name, lat, lon, regime) in enumerate(cells):
            t0 = time.time()
            try:
                rows = rows_for_cell(s3, bucket, name, lat, lon, regime, s, e)
            except Exception as ex:
                print(f"  [{idx+1}/{len(cells)}] {name:16s} FAILED: {ex}")
                continue
            w.writerows(rows)
            f.flush()
            n += len(rows)
            print(f"  [{idx+1}/{len(cells)}] {name:16s} {regime:20s} "
                  f"{len(rows):5d} rows  ({time.time()-t0:.1f}s)")
            if idx < len(cells) - 1:
                time.sleep(SLEEP_BETWEEN_CELLS_S)

    print(f"\nwrote {n} rows -> {args.out}")


if __name__ == "__main__":
    main()
