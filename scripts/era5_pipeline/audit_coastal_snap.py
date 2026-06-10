"""Audit the coastal all-NaN archives (Finding F1) and build the snap mapping.

Read-only. Finds every degenerate archive on R2 (an all-blank cell whose snapped
0.1deg gridpoint landed offshore on an ERA5-Land ocean NaN), and for each one
computes the nearest LAND gridpoint it SHOULD have used. Emits a JSON mapping
that drives the fix:

  - cells.csv rewrite (move the cell to its land coord, re-derive its name),
  - deletion of the stale blank archive keys,
  - re-pull of the affected tiles with the patched downloader.

Detection: the degenerate archives form a tight ~63 KB cluster on R2 (a
full-history file of all-empty rows), with the next-smallest HEALTHY archive at
~321 KB — a wide, unambiguous gap. We flag every archive under --size-threshold
(default 100 KB) and CONFIRM each is blank by content (zero non-null tmax) before
including it, so a genuinely small-but-complete cell can't be misclassified.

Land snap: ERA5-Land ocean cells are NaN. For each affected tile we fetch ONE
mid-record timestep (cheap) to build the land mask, then resolve each blank
cell's nearest finite gridpoint via download_cells.resolve_land_indices.

Collisions are reported, not resolved: two blank cells can snap to the same land
coord, or a blank cell can snap onto a coord already in cells.csv. The rewrite
step merges those to one row.

Usage:
  source .venv/bin/activate
  set -a; source r2.env; set +a            # R2 creds
  python audit_coastal_snap.py             # writes coastal_snap_map.json
  python audit_coastal_snap.py --size-threshold 100000 --mask-day 2020-06-15
"""
from __future__ import annotations

import argparse
import csv
import gzip
import io
import json
import re
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np

from download_cells import (
    TILE_CELLS,
    archive_name,
    open_store,
    resolve_land_indices,
)
from r2_upload import R2Uploader

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
CELLS_CSV = REPO / "data" / "cells.csv"
OUT_JSON = HERE / "coastal_snap_map.json"

_KEY_RE = re.compile(r"archive/archive_(-?\d+\.\d+)_(-?\d+\.\d+)\.csv\.gz")


def key_to_coord(key: str) -> tuple[float, float]:
    m = _KEY_RE.match(key)
    return (float(m.group(1)), float(m.group(2)))


def find_blank_archives(up: R2Uploader, size_threshold: int) -> list[tuple[float, float]]:
    """Coords of every archive under size_threshold, CONFIRMED all-blank.

    Size is a cheap pre-filter; we then download each candidate and require zero
    non-null tmax so a small-but-real cell can't slip in.
    """
    arch = {k: v for k, v in up.list_sizes("archive/").items()
            if k.endswith(".csv.gz")}
    candidates = sorted(k for k, v in arch.items() if v < size_threshold)
    print(f"  {len(arch)} archives total; {len(candidates)} under "
          f"{size_threshold:,} bytes — confirming each is blank by content...")
    confirmed: list[tuple[float, float]] = []
    import pandas as pd
    for i, key in enumerate(candidates, 1):
        body = up.client.get_object(Bucket=up.bucket, Key=key)["Body"].read()
        with gzip.open(io.BytesIO(body), "rt") as fh:
            df = pd.read_csv(fh, usecols=["tmax_C"])
        if df["tmax_C"].notna().sum() == 0:
            confirmed.append(key_to_coord(key))
        else:
            print(f"    NOT blank (skipping): {key} "
                  f"({df['tmax_C'].notna().sum()} non-null tmax)")
        if i % 50 == 0:
            print(f"    confirmed {i}/{len(candidates)}")
    print(f"  {len(confirmed)} archives confirmed degenerate (all-blank)")
    return confirmed


def tile_window(ds, tile_id: str):
    lat_name = "latitude" if "latitude" in ds.coords else "lat"
    lon_name = "longitude" if "longitude" in ds.coords else "lon"
    r, c = (int(x) for x in tile_id.split("_"))
    la = slice(r * TILE_CELLS, min((r + 1) * TILE_CELLS, ds.sizes[lat_name]))
    lo = slice(c * TILE_CELLS, min((c + 1) * TILE_CELLS, ds.sizes[lon_name]))
    return lat_name, lon_name, la, lo


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--size-threshold", type=int, default=100_000,
                    help="archives smaller than this (bytes) are blank candidates "
                    "(default 100000; the degenerate cluster is ~63 KB, healthy "
                    "cells start ~321 KB)")
    ap.add_argument("--mask-day", default="2020-06-15T12:00:00",
                    help="mid-record timestep used to build each tile's land mask")
    ap.add_argument("--out", default=str(OUT_JSON))
    args = ap.parse_args()

    print("Coastal snap audit (Finding F1)")
    up = R2Uploader()
    print(f"  bucket: {up.bucket}")
    blanks = find_blank_archives(up, args.size_threshold)
    if not blanks:
        print("no degenerate archives found — nothing to do.")
        return 0

    # join blanks -> cells.csv rows (for tile_id + name)
    rows = list(csv.DictReader(CELLS_CSV.open()))
    cell_by_coord = {(round(float(r["lat"]), 1), round(float(r["lon"]), 1)): r
                     for r in rows}
    all_coords = set(cell_by_coord)  # to detect snap-onto-existing collisions
    missing = [c for c in blanks if c not in cell_by_coord]
    if missing:
        print(f"  WARNING: {len(missing)} blank coords not in cells.csv: "
              f"{missing[:5]}")
    blanks = [c for c in blanks if c in cell_by_coord]

    by_tile: dict[str, list[tuple[float, float]]] = defaultdict(list)
    for c in blanks:
        by_tile[cell_by_coord[c]["tile_id"]].append(c)
    print(f"  {len(blanks)} blank cells across {len(by_tile)} tiles\n")

    print("  opening zarr store for land masks...")
    ds = open_store()

    mapping: dict[str, dict] = {}   # "lat,lon" -> {land_lat, land_lon, ...}
    no_land: list[tuple[float, float]] = []
    snap_dists: list[int] = []

    for ti, (tile_id, cells) in enumerate(sorted(by_tile.items()), 1):
        lat_name, lon_name, la, lo = tile_window(ds, tile_id)
        sub = ds["t2m"].sel({"valid_time": args.mask_day}).isel(
            {lat_name: la, lon_name: lo}).compute()
        lats, lons = sub[lat_name].values, sub[lon_name].values
        finite = np.isfinite(sub.values)

        # targets in the store's 0..360 lon convention
        targets = [(lat, lon + 360.0 if lon < 0 else lon) for (lat, lon) in cells]
        idxs = resolve_land_indices(finite, lats, lons, targets)
        for (lat, lon), idx in zip(cells, idxs):
            li = int(np.abs(lats - lat).argmin())
            ci = int(np.abs(lons - (lon + 360 if lon < 0 else lon)).argmin())
            if idx is None:
                no_land.append((lat, lon))
                continue
            r_i, c_i = idx
            # land coord back in signed-lon, snapped to the 0.1deg grid label
            land_lat = round(float(lats[r_i]), 1)
            land_lon_360 = float(lons[c_i])
            land_lon = round(land_lon_360 - 360 if land_lon_360 > 180 else land_lon_360, 1)
            dist = abs(r_i - li) + abs(c_i - ci)
            snap_dists.append(dist)
            mapping[f"{lat:.1f},{lon:.1f}"] = {
                "old_lat": lat, "old_lon": lon,
                "land_lat": land_lat, "land_lon": land_lon,
                "tile_id": tile_id,
                "snap_cells": dist,
                "old_name": cell_by_coord[(lat, lon)].get("name", ""),
            }
        if ti % 20 == 0 or ti == len(by_tile):
            print(f"    {ti}/{len(by_tile)} tiles processed")

    # ---- collision analysis --------------------------------------------------
    land_targets = Counter((m["land_lat"], m["land_lon"]) for m in mapping.values())
    collide_each_other = {k: n for k, n in land_targets.items() if n > 1}
    # a blank snapping onto a coord that ALREADY exists in cells.csv (and isn't
    # itself one of the blanks being moved away)
    moving_away = {(m["old_lat"], m["old_lon"]) for m in mapping.values()}
    onto_existing = sorted({
        (m["land_lat"], m["land_lon"])
        for m in mapping.values()
        if (m["land_lat"], m["land_lon"]) in all_coords
        and (m["land_lat"], m["land_lon"]) not in moving_away
    })

    out = {
        "size_threshold": args.size_threshold,
        "mask_day": args.mask_day,
        "n_blank": len(blanks),
        "n_mapped": len(mapping),
        "n_no_land": len(no_land),
        "no_land_cells": no_land,
        "missing_from_cells_csv": missing,
        "snap_distance_hist": dict(Counter(snap_dists)),
        "collisions_land_target_shared": {f"{a},{b}": n
                                          for (a, b), n in collide_each_other.items()},
        "collisions_onto_existing_cell": [f"{a},{b}" for a, b in onto_existing],
        "mapping": mapping,
    }
    Path(args.out).write_text(json.dumps(out, indent=2))

    print("\n=== AUDIT SUMMARY ===")
    print(f"  blank cells          : {len(blanks)}")
    print(f"  mapped to land       : {len(mapping)}")
    print(f"  NO land in window    : {len(no_land)}  {no_land[:5]}")
    print(f"  snap distance (cells): {dict(sorted(Counter(snap_dists).items()))}")
    print(f"  >1 blank -> same land: {len(collide_each_other)} target(s)")
    print(f"  snap onto EXISTING   : {len(onto_existing)} cell(s)  {onto_existing[:5]}")
    print(f"\n  wrote {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
