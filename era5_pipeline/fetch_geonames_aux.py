"""Cache GeoNames' two small aux dumps (countryInfo, admin1Codes) to disk.

name_cells.py re-fetches these on every run and falls back to bare codes when the
network is down. The rename pass needs them to reproduce label format exactly, so
cache them once next to the gazetteer instead of hitting the host repeatedly.
"""
import sys, urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
# Root by search, not by depth: this dir sits at a different level on the VM mirror.
REPO = next(p for p in HERE.parents if (p / "data" / "cells.csv").is_file())
DATA = REPO / "data" / "era5-land"
FILES = {
    "countryInfo.txt": "https://download.geonames.org/export/dump/countryInfo.txt",
    "admin1CodesASCII.txt": "https://download.geonames.org/export/dump/admin1CodesASCII.txt",
}
for name, url in FILES.items():
    dest = DATA / name
    if dest.exists():
        print(f"  {name}: cached ({dest.stat().st_size/1e3:.0f} KB)")
        continue
    req = urllib.request.Request(url, headers={"User-Agent": "weatherbaseline-namecells/1.0"})
    with urllib.request.urlopen(req, timeout=30) as r:
        dest.write_bytes(r.read())
    print(f"  {name}: fetched {dest.stat().st_size/1e3:.0f} KB")
