"""Fetch GeoNames cities5000.zip and write data/era5/cities.csv.

GeoNames format (tab-separated, no header):
  0 geonameid, 1 name, 2 asciiname, 3 alternatenames,
  4 latitude, 5 longitude, 6 feature_class, 7 feature_code,
  8 country_code, ... (19 cols total)
See: https://download.geonames.org/export/dump/readme.txt
"""
from __future__ import annotations

import csv
import io
import sys
import urllib.request
import zipfile
from pathlib import Path

URL = "https://download.geonames.org/export/dump/cities5000.zip"
OUT = Path(__file__).resolve().parents[2] / "data" / "era5" / "cities.csv"


def main() -> int:
    OUT.parent.mkdir(parents=True, exist_ok=True)
    print(f"Downloading {URL}", file=sys.stderr)
    with urllib.request.urlopen(URL) as resp:
        buf = io.BytesIO(resp.read())
    with zipfile.ZipFile(buf) as zf:
        with zf.open("cities5000.txt") as f:
            raw = f.read().decode("utf-8")

    rows = []
    for line in raw.splitlines():
        parts = line.split("\t")
        if len(parts) < 9:
            continue
        geonameid, name, _ascii, _alt, lat, lon, _fc, _fcode, country = parts[:9]
        try:
            latf = float(lat)
            lonf = float(lon)
        except ValueError:
            continue
        rows.append((geonameid, name, country, f"{latf:.4f}", f"{lonf:.4f}"))

    with OUT.open("w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["geonameid", "name", "country", "lat", "lon"])
        w.writerows(rows)

    print(f"Wrote {len(rows)} cities to {OUT}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
