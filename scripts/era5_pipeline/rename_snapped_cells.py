"""Re-name the snap-rewritten cells whose label names a place the data isn't from.

Why
---
`apply_snap_rewrite.py` moved 121 cells' coords onto the ERA5-Land gridpoint their
archive is actually read from (so the UI distance is honest) but kept the ORIGINAL
name. For most of them that's fine — the median move is 11.1 km, one gridpoint, and
"Venice, Italy" for a point 5 km from Venice is still the right label. For a handful
the label describes a different island or a different country entirely: "Road Town,
British Virgin Islands" over a gridpoint in north-east Puerto Rico, 116 km away.

Which cells
-----------
A moved cell is renamed when EITHER
  * snap_km >= FAR_SNAP_KM — the named place is nowhere near the gridpoint, or
  * the gridpoint's country differs from the one the current label ends with —
    the label names the wrong country (sub-grid territories: Gibraltar, Ceuta,
    Kinmen, Wallis, San Andrés, the Virgin Islands).
Everything else keeps its name.

Why not just re-run name_cells.py
---------------------------------
A full re-run is NOT idempotent — ~570 names drift, because the shipped names went
through the dedupe pass and the bare nearest-city join no longer reproduces them.
Measured here: it would rewrite Venice->Mestre, Stavanger->Sandnes, Annapolis->
Severna Park, and Tokushima->Narutochō-mitsuishi on a 0.9 km move. So this is a
targeted patch on the CURRENT cells.csv, the same pattern as name_coord_cells.py
and disambiguate_dupes.py.

Renaming cannot hide a place from search: the app geocodes the query and snaps the
result to the nearest cell (see frontend/src/services/cellIndex.ts), so "Road Town"
still resolves here — it just gets an honest label and a 114 km badge.

Usage
-----
  .venv/bin/python rename_snapped_cells.py --dry-run
  .venv/bin/python rename_snapped_cells.py
"""
from __future__ import annotations

import argparse
import csv
import shutil
import sys
from collections import Counter
from pathlib import Path

import name_cells as nc

HERE = Path(__file__).resolve().parent
CELLS = HERE.parents[1] / "data" / "cells.csv"
PLAN = HERE / "snap_rewrite_plan.csv"
AUX = HERE.parents[1] / "data" / "era5-land"

# Beyond this, the named place is too far from the gridpoint to be its label.
# 25 km is ~two 0.1deg cells; below it a move is a neighbouring gridpoint in the
# same metro, where the existing name is still correct.
FAR_SNAP_KM = 25.0


def load_aux(fname: str, key_col: int, val_col: int) -> dict[str, str]:
    """Parse a cached GeoNames aux dump into {key: value} (see fetch_geonames_aux.py)."""
    path = AUX / fname
    if not path.exists():
        sys.exit(f"{fname} not cached — run: .venv/bin/python fetch_geonames_aux.py")
    out: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.startswith("#") or not line.strip():
            continue
        cols = line.split("\t")
        if len(cols) > max(key_col, val_col) and cols[key_col]:
            out[cols[key_col]] = cols[val_col]
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dry-run", action="store_true", help="print the plan, write nothing")
    args = ap.parse_args()

    plan = {r["cell_id"]: r for r in csv.DictReader(PLAN.open(encoding="utf-8"))
            if r["action"].startswith("move")}
    with CELLS.open(encoding="utf-8") as f:
        reader = csv.DictReader(f)
        fieldnames = list(reader.fieldnames or [])
        rows = list(reader)
    targets = [i for i, r in enumerate(rows) if r["cell_id"] in plan]
    print(f"  {len(plan)} moved cells in the plan, {len(targets)} matched in cells.csv",
          file=sys.stderr)

    gaz = nc.load_gazetteer()
    cc_to_country = load_aux("countryInfo.txt", 0, 4)

    lats = [float(rows[i]["lat"]) for i in targets]
    lons = [float(rows[i]["lon"]) for i in targets]
    nn_names, nn_cc, _nn_a1, nn_dist = nc.nearest_city_join(lats, lons, *gaz)

    renames: list[tuple[int, str, str, float, str]] = []
    for n, i in enumerate(targets):
        snap_km = float(plan[rows[i]["cell_id"]]["snap_km"])
        country = cc_to_country.get(nn_cc[n], nn_cc[n])
        # endswith (not a comma split) so country names that themselves contain a
        # comma — "Bonaire, Saint Eustatius and Saba" — compare correctly.
        wrong_country = bool(country) and not rows[i]["name"].endswith(country)
        if snap_km < FAR_SNAP_KM and not wrong_country:
            continue
        label = nn_names[n]
        if country and not label.endswith(country):
            label = f"{label}, {country}"
        reason = "far" if snap_km >= FAR_SNAP_KM else "country"
        renames.append((i, rows[i]["name"], label, snap_km, reason))

    print(f"\n  {len(renames)} cells to rename "
          f"({len(targets) - len(renames)} keep their name)\n", file=sys.stderr)
    print(f"{'snap':>7}  {'why':7}  {'current':44}  proposed")
    for i, old, new, km, why in sorted(renames, key=lambda r: -r[3]):
        print(f"{km:7.1f}  {why:7}  {old[:44]:44}  {new}")

    # Every name must stay globally unique — the app uses it as the cell's label.
    final = Counter(r["name"] for i, r in enumerate(rows)
                    if i not in {x[0] for x in renames})
    for _i, _old, new, _km, _w in renames:
        final[new] += 1
    dupes = sorted({new for _i, _o, new, _k, _w in renames if final[new] > 1})
    if dupes:
        print(f"\n  {len(dupes)} collision(s) — run disambiguate_dupes.py after:",
              file=sys.stderr)
        for d in dupes:
            print(f"    {d} (x{final[d]})", file=sys.stderr)
    else:
        print("\n  no name collisions", file=sys.stderr)

    if args.dry_run:
        print("  --dry-run: nothing written", file=sys.stderr)
        return 0

    backup = CELLS.with_suffix(".csv.pre_snap_rename.bak")
    shutil.copy2(CELLS, backup)
    for i, _old, new, _km, _w in renames:
        rows[i]["name"] = new
    with CELLS.open("w", newline="", encoding="utf-8") as f:
        csv.DictWriter(f, fieldnames=fieldnames).writeheader()
        csv.DictWriter(f, fieldnames=fieldnames).writerows(rows)
    print(f"  backed up -> {backup.name}\n  wrote {CELLS}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
