"""Backfill real names for the handful of cells whose `name` is still bare coords.

A few sparse cells came out of name_cells.py labelled just "lat, lon" because the
nearest GeoNames city was > FAR_KM away AND the Photon reverse-geocode fallback
returned nothing for them (they sit in deserts, the Congo basin, rural Bangladesh,
etc., where Photon's gazetteer is thin). Nominatim (full OSM admin hierarchy) does
resolve every one of them to a real administrative place.

This script:
  1. Finds cells in data/cells.csv whose name is a bare "lat, lon".
  2. Reverse-geocodes each via Nominatim (1 req/s, proper UA), picking the most
     specific place (village -> town -> city -> county -> state) + country.
  3. Writes "{place}, {country}" back into the name column (all other columns and
     rows preserved verbatim), after backing up cells.csv.
  4. Seeds data/era5-land/revgeo_cache.json with the same [place, country] answers
     keyed by "lat,lon" (2dp), so a future name_cells.py run reuses them instead of
     falling back to coords. The chosen format is exactly what name_cells.py's
     with_country() would reproduce, so naming stays idempotent.

Usage
-----
  source .venv/bin/activate
  python name_coord_cells.py            # do it
  python name_coord_cells.py --dry-run  # just print what it would write
"""
from __future__ import annotations

import argparse
import csv
import json
import re
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
DATA = HERE.parents[1] / "data"
CELLS = DATA / "cells.csv"
REVGEO_CACHE = DATA / "era5-land" / "revgeo_cache.json"

COORD_NAME = re.compile(r"^\s*-?\d+\.\d+\s*,\s*-?\d+\.\d+\s*$")
UA = "howhotwasit-namecells/1.0 (nafaltov@gmail.com)"

# Most-specific -> least-specific OSM address fields we'll accept as the place
# label. We take the first present so a real town beats the enclosing district.
PLACE_KEYS = [
    "village", "hamlet", "town", "city", "municipality", "suburb",
    "neighbourhood", "city_district", "county", "state_district",
    "province", "state", "region",
]


def nominatim_reverse(lat: float, lon: float) -> tuple[str, str] | None:
    """Return (place, country) for a point, or None if OSM has nothing."""
    q = urllib.parse.urlencode({
        "lat": lat, "lon": lon, "format": "jsonv2",
        "zoom": "10", "accept-language": "en",
    })
    url = f"https://nominatim.openstreetmap.org/reverse?{q}"
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=25) as r:
            data = json.loads(r.read())
    except Exception as e:  # noqa: BLE001
        print(f"    revgeo {lat},{lon} failed: {e}", file=sys.stderr)
        return None
    addr = data.get("address") or {}
    country = (addr.get("country") or "").strip()
    place = next((addr[k] for k in PLACE_KEYS if addr.get(k)), "")
    if not place:
        place = (data.get("name") or "").strip()
    if not place:
        return None
    return place, country


def clean_place(place: str) -> str:
    """Drop a trailing bilingual alias OSM sometimes appends ("Saraf Omra - سرف عمرة").

    Only strips when the part after " - " is non-Latin script (Arabic, CJK, …);
    a Latin suffix like "Chanchal - I" (a real block name) is left intact.
    """
    place = place.strip()
    if " - " in place:
        head, tail = place.split(" - ", 1)
        if any(ord(c) > 0x2BF for c in tail):  # non-Latin -> it's a localized alias
            return head.strip()
    return place


def with_country(place: str, country: str) -> str:
    """`{place}, {country}` unless country is already the tail (matches name_cells)."""
    country = country.strip()
    if country and not place.endswith(country):
        return f"{place}, {country}"
    return place


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dry-run", action="store_true",
                    help="print proposed names but don't write cells.csv / cache")
    args = ap.parse_args()

    with CELLS.open(encoding="utf-8") as f:
        reader = csv.DictReader(f)
        fieldnames = list(reader.fieldnames or [])
        rows = list(reader)

    targets = [r for r in rows if COORD_NAME.match(r["name"] or "")]
    print(f"  {len(targets)} coord-named cells to resolve\n", file=sys.stderr)
    if not targets:
        return 0

    cache = {}
    if REVGEO_CACHE.exists():
        try:
            cache = json.loads(REVGEO_CACHE.read_text())
        except Exception:  # noqa: BLE001
            cache = {}

    resolved = 0
    for i, r in enumerate(targets, 1):
        lat, lon = float(r["lat"]), float(r["lon"])
        res = nominatim_reverse(lat, lon)
        time.sleep(1.1)  # Nominatim usage policy: <= 1 req/s
        if not res:
            print(f"  [{i}/{len(targets)}] {lat},{lon}: no OSM answer — left as coords")
            continue
        place, country = res
        place = clean_place(place)
        label = with_country(place, country)
        print(f"  [{i}/{len(targets)}] {lat},{lon}: {r['name']!r} -> {label!r}")
        r["name"] = label
        cache[f"{lat:.2f},{lon:.2f}"] = [place, country]  # seed for name_cells.py
        resolved += 1

    print(f"\n  resolved {resolved}/{len(targets)}", file=sys.stderr)
    if args.dry_run:
        print("  --dry-run: nothing written", file=sys.stderr)
        return 0

    backup = CELLS.with_suffix(".csv.pre_coordname.bak")
    backup.write_bytes(CELLS.read_bytes())
    print(f"  backed up original -> {backup.name}", file=sys.stderr)

    with CELLS.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fieldnames)
        w.writeheader()
        w.writerows(rows)
    REVGEO_CACHE.write_text(json.dumps(cache))
    print(f"  wrote {CELLS} and seeded {REVGEO_CACHE.name}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
