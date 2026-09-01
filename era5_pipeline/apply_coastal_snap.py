"""Apply the coastal snap map to cells.csv (Finding F1 rewrite).

Consumes coastal_snap_map.json (from audit_coastal_snap.py) and rewrites
data/cells.csv so every cell's coord is a real ERA5-Land LAND gridpoint —
coord = archive filename = data source, all consistent. Three cases:

  case 1 (move):  the blank cell's land coord is NOT already a cell. Move the
                  row's lat/lon to the land coord and recompute tile_id/tile_lat/
                  tile_lon (via select_cells.store_tile). cell_id is kept (it's a
                  population rank, opaque — nothing keys off it). The `name` is
                  re-derived afterward by re-running name_cells.py, since the
                  coord moved (a separate step; this script leaves name as-is and
                  prints the reminder).

  case 2 (drop):  the land coord IS already a cell in cells.csv. The coastal cell
                  was a duplicate of a real land cell — drop its row entirely. The
                  existing cell serves it (the frontend snaps any search there by
                  coords). Its blank archive is deleted separately.

  case 3 (drop):  no land anywhere in the tile window (e.g. a Maldives atoll).
                  ERA5-Land genuinely has no data — drop the row.

Preserves the zero-duplicate-coords invariant: case-1 destinations are verified
distinct and not colliding with surviving rows.

Usage:
  source .venv/bin/activate
  python apply_coastal_snap.py --dry-run     # report only, write nothing
  python apply_coastal_snap.py               # rewrite cells.csv (backs up first)
Then re-derive names for moved cells:
  python name_cells.py
"""
from __future__ import annotations

import argparse
import csv
import json
import shutil
from pathlib import Path

from select_cells import store_tile

HERE = Path(__file__).resolve().parent
# Root by search, not by depth: this dir sits at a different level on the VM mirror.
REPO = next(p for p in HERE.parents if (p / "data" / "cells.csv").is_file())
CELLS_CSV = REPO / "data" / "cells.csv"
SNAP_MAP = HERE / "coastal_snap_map.json"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--dry-run", action="store_true",
                    help="report the planned changes but write nothing")
    ap.add_argument("--map", default=str(SNAP_MAP))
    args = ap.parse_args()

    snap = json.loads(Path(args.map).read_text())
    mapping = snap["mapping"]
    no_land = {tuple(c) for c in snap["no_land_cells"]}

    rows = list(csv.DictReader(CELLS_CSV.open()))
    fieldnames = list(rows[0].keys())
    by_coord = {(round(float(r["lat"]), 1), round(float(r["lon"]), 1)): r
                for r in rows}
    existing = set(by_coord)

    moving_away = {(e["old_lat"], e["old_lon"]) for e in mapping.values()}

    case_move: list[dict] = []   # (old_coord, land_coord)
    case_drop_existing: list[tuple] = []
    case_drop_noland: list[tuple] = []

    for e in mapping.values():
        old = (e["old_lat"], e["old_lon"])
        land = (e["land_lat"], e["land_lon"])
        if land in existing and land not in moving_away:
            case_drop_existing.append(old)
        else:
            case_move.append(e)
    for c in no_land:
        case_drop_noland.append(c)

    # sanity: case-1 destinations distinct + not colliding with a surviving row
    dests = [(e["land_lat"], e["land_lon"]) for e in case_move]
    assert len(dests) == len(set(dests)), "case-1 destinations are not distinct!"
    drop_coords = set(case_drop_existing) | set(case_drop_noland)
    survivors_after = (existing - {(e["old_lat"], e["old_lon"]) for e in case_move}
                       - drop_coords)
    collide = [d for d in dests if d in survivors_after]
    assert not collide, f"case-1 dest collides with a surviving row: {collide[:5]}"

    print("Apply coastal snap map → cells.csv")
    print(f"  rows now              : {len(rows)}")
    print(f"  case 1 MOVE           : {len(case_move)}")
    print(f"  case 2 DROP (existing): {len(case_drop_existing)}")
    print(f"  case 3 DROP (no land) : {len(case_drop_noland)}  {sorted(case_drop_noland)}")
    print(f"  rows after            : {len(rows) - len(case_drop_existing) - len(case_drop_noland)}")

    # build the new row set
    drop_set = set(case_drop_existing) | set(case_drop_noland)
    move_by_old = {(e["old_lat"], e["old_lon"]): e for e in case_move}

    out_rows: list[dict] = []
    moved = dropped = 0
    for r in rows:
        coord = (round(float(r["lat"]), 1), round(float(r["lon"]), 1))
        if coord in drop_set:
            dropped += 1
            continue
        if coord in move_by_old:
            e = move_by_old[coord]
            tile_id, tile_lat, tile_lon = store_tile(e["land_lat"], e["land_lon"])
            r = dict(r)
            r["lat"] = f"{e['land_lat']:.1f}"
            r["lon"] = f"{e['land_lon']:.1f}"
            r["tile_id"] = tile_id
            r["tile_lat"] = f"{tile_lat:.1f}"
            r["tile_lon"] = f"{tile_lon:.1f}"
            # name left as-is; re-derived by name_cells.py afterward
            moved += 1
        out_rows.append(r)

    # final invariant: zero duplicate coords
    out_coords = [(round(float(r["lat"]), 1), round(float(r["lon"]), 1))
                  for r in out_rows]
    assert len(out_coords) == len(set(out_coords)), "duplicate coords after rewrite!"

    print(f"\n  applied: {moved} moved, {dropped} dropped → {len(out_rows)} rows")
    print("  invariant: zero duplicate coords ✓")

    if args.dry_run:
        print("\n  --dry-run: cells.csv NOT modified.")
        return 0

    backup = CELLS_CSV.with_suffix(".csv.pre_coastal_snap.bak")
    if not backup.exists():
        shutil.copy2(CELLS_CSV, backup)
        print(f"\n  backed up original → {backup.name}")
    with CELLS_CSV.open("w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fieldnames)
        w.writeheader()
        w.writerows(out_rows)
    print(f"  wrote {CELLS_CSV}")
    print("\n  NEXT: re-derive names for the moved cells →  python name_cells.py")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
