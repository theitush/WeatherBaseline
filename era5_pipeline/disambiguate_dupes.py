"""Give every cell a unique `name` by refining same-metro duplicates to sub-district.

The problem
-----------
name_cells.py labels each 0.1deg cell with its nearest gazetteer city, and already
splices in the admin-1 region for the "Springfield, IL vs MO" case. But a 0.1deg
grid slices a dense metro into many cells that all reverse-geocode to the SAME city
in the SAME region -- so ~3.2k cells share a name with a neighbour ("Shanghai, China"
x2, "Riyadh, Riyadh Region, Saudi Arabia" x10). Region-splicing can't separate them;
there's nothing coarser left. They need a FINER distinguisher.

What this does
--------------
  1. Groups cells.csv rows by their current `name`; takes only the duplicated groups.
  2. Reverse-geocodes each such cell via Nominatim at neighbourhood zoom and prepends
     the finest sub-district that isn't already in the label
     ("Pudong, Shanghai, China" vs "Minhang, Shanghai, China"). Cached + resumable.
  3. Backstop: any cells that STILL collide after refinement (OSM had no distinct
     sub-district) keep the most-populous one bare and get a deterministic compass
     bearing from the group centroid appended ("... , China (E)"); if a bearing still
     collides, the cell's own "lat, lon" is used -- guaranteeing global uniqueness.
  4. Backs up cells.csv -> .pre_dedupe.bak and rewrites ONLY the name column; every
     other column and row order is preserved verbatim.

This is a targeted patch on the CURRENT cells.csv (like name_coord_cells.py), so it
does not disturb the coastal-snap / coord-name patches already applied.

Usage
-----
  source .venv/bin/activate
  python disambiguate_dupes.py --dry-run          # print the plan, write nothing
  python disambiguate_dupes.py --limit 30 --dry-run   # sanity-check on a few cells
  python disambiguate_dupes.py                     # do it (long: ~1s/cell, cached)
"""
from __future__ import annotations

import argparse
import csv
import json
import math
import sys
import time
import urllib.parse
import urllib.request
from collections import defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
DATA = HERE.parents[1] / "data"
CELLS = DATA / "cells.csv"
SUBDIST_CACHE = DATA / "era5-land" / "subdistrict_cache.json"

UA = "howhotwasit-namecells/1.0 (nafaltov@gmail.com)"

# Finest -> coarsest OSM address fields we'll accept as the sub-district piece to
# prepend. We take the first present that isn't already a segment of the label, so
# a neighbourhood beats the enclosing district, which beats the borough.
FINE_KEYS = [
    "neighbourhood", "quarter", "suburb", "city_district", "borough",
    "hamlet", "village", "town", "municipality", "county",
]

COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"]


def nominatim_reverse(lat: float, lon: float) -> dict | None:
    """Return the OSM `address` dict for a point (full admin hierarchy), or None."""
    q = urllib.parse.urlencode({
        "lat": lat, "lon": lon, "format": "jsonv2",
        "zoom": "14", "accept-language": "en",
    })
    url = f"https://nominatim.openstreetmap.org/reverse?{q}"
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=25) as r:
            data = json.loads(r.read())
    except Exception as e:  # noqa: BLE001
        print(f"    revgeo {lat},{lon} failed: {e}", file=sys.stderr)
        return None
    return data.get("address") or {}


def segments(name: str) -> set[str]:
    return {s.strip().casefold() for s in name.split(",") if s.strip()}


def is_latin_label(v: str) -> bool:
    """True if v carries at least one ASCII letter.

    Rejects CJK/Arabic/etc. sub-district names that OSM returns untranslated (the
    rest of cells.csv is English/Latin) and purely-numeric neighbourhoods ("508"),
    so the scan falls through to a coarser, usable field or to the backstop.
    """
    return any("a" <= c <= "z" or "A" <= c <= "Z" for c in v)


def fine_place(addr: dict, existing: str) -> str:
    """Finest usable sub-district in `addr` not already in `existing`, else ""."""
    have = segments(existing)
    for k in FINE_KEYS:
        v = (addr.get(k) or "").strip()
        if v and v.casefold() not in have and is_latin_label(v):
            return v
    return ""


def bearing(clat: float, clon: float, plat: float, plon: float) -> str:
    """8-wind compass bearing from a centroid (clat,clon) to a point."""
    dlon = math.radians(plon - clon)
    y = math.sin(dlon) * math.cos(math.radians(plat))
    x = (math.cos(math.radians(clat)) * math.sin(math.radians(plat))
         - math.sin(math.radians(clat)) * math.cos(math.radians(plat)) * math.cos(dlon))
    brng = (math.degrees(math.atan2(y, x)) + 360) % 360
    return COMPASS[round(brng / 45) % 8]


def load_cache() -> dict:
    if SUBDIST_CACHE.exists():
        try:
            return json.loads(SUBDIST_CACHE.read_text())
        except Exception:  # noqa: BLE001
            return {}
    return {}


def disambiguate(rows: list[dict], *, limit: int = 0, fetch: bool = True,
                 verbose: bool = True) -> list[tuple[int, str, str]]:
    """Compute unique sub-district labels for every duplicated-name cell.

    Pure w.r.t. cells.csv -- reads rows (each a dict with lat/lon/population/name),
    returns the list of (row_index, old_name, new_name) edits WITHOUT mutating rows
    or the file. The reverse-geocode SUBDIST_CACHE is read and (when fetch=True)
    extended on disk, so repeat calls are instant. Set fetch=False to use only what
    is already cached (offline / idempotency checks).

    Used both by this script's CLI and as name_cells.py's final naming step.
    """
    def log(msg: str) -> None:
        if verbose:
            print(msg, file=sys.stderr)

    # Group row indices by current name; keep only the duplicated groups.
    by_name: dict[str, list[int]] = defaultdict(list)
    for i, r in enumerate(rows):
        by_name[r["name"]].append(i)
    dup_idx = [i for idxs in by_name.values() if len(idxs) > 1 for i in idxs]
    log(f"  {len(rows):,} cells; {len(dup_idx):,} in "
        f"{sum(len(v) > 1 for v in by_name.values()):,} duplicated-name groups")
    if limit:
        dup_idx = dup_idx[:limit]

    # --- Step 1: reverse-geocode each duplicate cell (cached, resumable). ---
    cache = load_cache()
    todo = ([i for i in dup_idx
             if f"{float(rows[i]['lat']):.2f},{float(rows[i]['lon']):.2f}" not in cache]
            if fetch else [])
    if todo:
        log(f"  reverse-geocoding {len(todo):,} cells via Nominatim (~1s each) ...")
    for n, i in enumerate(todo, 1):
        lat, lon = float(rows[i]["lat"]), float(rows[i]["lon"])
        cache[f"{lat:.2f},{lon:.2f}"] = nominatim_reverse(lat, lon)
        time.sleep(1.1)  # Nominatim usage policy: <= 1 req/s
        if n % 25 == 0:
            SUBDIST_CACHE.write_text(json.dumps(cache))  # resumable
            log(f"    {n}/{len(todo)}")
    if todo:
        SUBDIST_CACHE.write_text(json.dumps(cache))

    # --- Step 2: refine each duplicate cell's label with its sub-district. ---
    new_name = {i: rows[i]["name"] for i in dup_idx}
    for i in dup_idx:
        lat, lon = float(rows[i]["lat"]), float(rows[i]["lon"])
        addr = cache.get(f"{lat:.2f},{lon:.2f}")
        if not addr:
            continue
        sub = fine_place(addr, rows[i]["name"])
        if sub:
            new_name[i] = f"{sub}, {rows[i]['name']}"

    # --- Step 3: guarantee GLOBAL uniqueness (deterministic backstop). ---
    # Refinement can collide a cell with a DIFFERENT, already-unique cell -- a
    # "Tashkent" cell refining to "Sergeli, Tashkent" that another cell already
    # owns -- so we dedupe each refined label against ALL names in the file, not
    # just within the duplicate groups. Names of untouched cells are reserved;
    # within any colliding set the most-populous cell keeps the clean label and
    # the rest get a compass bearing from the group centroid, falling back to exact
    # coords if a bearing repeats.
    changing = set(dup_idx)
    taken = {rows[i]["name"] for i in range(len(rows)) if i not in changing}
    refined_groups: dict[str, list[int]] = defaultdict(list)
    for i in dup_idx:
        refined_groups[new_name[i]].append(i)
    backstopped = 0
    for label, idxs in refined_groups.items():
        clat = sum(float(rows[i]["lat"]) for i in idxs) / len(idxs)
        clon = sum(float(rows[i]["lon"]) for i in idxs) / len(idxs)
        idxs.sort(key=lambda i: int(rows[i]["population"] or 0), reverse=True)
        for i in idxs:
            lat, lon = float(rows[i]["lat"]), float(rows[i]["lon"])
            cand = label
            if cand in taken:
                cand = f"{label} ({bearing(clat, clon, lat, lon)})"
            if cand in taken:
                cand = f"{label} ({lat:.1f}, {lon:.1f})"
            if cand != label:
                backstopped += 1
            new_name[i] = cand
            taken.add(cand)

    changed = [(i, rows[i]["name"], new_name[i]) for i in dup_idx
               if new_name[i] != rows[i]["name"]]
    log(f"\n  refined {len(changed):,} labels "
        f"({backstopped:,} needed the bearing/coord backstop)")
    return changed


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dry-run", action="store_true",
                    help="print the rename plan but don't write cells.csv")
    ap.add_argument("--limit", type=int, default=0,
                    help="only reverse-geocode the first N duplicate cells (testing)")
    args = ap.parse_args()

    with CELLS.open(encoding="utf-8") as f:
        reader = csv.DictReader(f)
        fieldnames = list(reader.fieldnames or [])
        rows = list(reader)

    changed = disambiguate(rows, limit=args.limit)
    for i, old, new in changed[:40]:
        print(f"    {old!r} -> {new!r}")
    if len(changed) > 40:
        print(f"    ... and {len(changed) - 40:,} more", file=sys.stderr)

    # Report residual uniqueness across the whole file BEFORE mutating anything on
    # disk. (rows is still the original here; `changed` holds the proposed edits.)
    proposed = {i: new for i, _, new in changed}
    final_counts: dict[str, int] = defaultdict(int)
    for i, r in enumerate(rows):
        final_counts[proposed.get(i, r["name"])] += 1
    remaining = sum(c > 1 for c in final_counts.values())
    print(f"  duplicated names remaining after patch: {remaining}", file=sys.stderr)

    if args.dry_run:
        print("  --dry-run: nothing written", file=sys.stderr)
        return 0

    # Back up the untouched file on disk, then apply the edits and rewrite.
    backup = CELLS.with_suffix(".csv.pre_dedupe.bak")
    backup.write_bytes(CELLS.read_bytes())
    print(f"  backed up original -> {backup.name}", file=sys.stderr)
    for i, new in proposed.items():
        rows[i]["name"] = new

    with CELLS.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fieldnames)
        w.writeheader()
        w.writerows(rows)
    print(f"  wrote {CELLS}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
