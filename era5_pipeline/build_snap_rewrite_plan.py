#!/usr/bin/env python3
"""Turn snap_audit.csv into an executable rewrite manifest (snap_rewrite_plan.csv).

Context (2026-08-25): audit_snap_distances.py measured how far every cell's
archive gridpoint sits from its cells.csv coordinate (the nearest-land snap in
download_cells.py has no distance cap; Christmas Island shipped West Java's
climate for years because of it). USER DECISION: coordinates must point at the
data source, so every legitimately snapped cell has its cells.csv coordinate
MOVED to the resolved land gridpoint (name kept verbatim), while over-cap
cells whose data is some other landmass's climate are dropped or merged.

This script computes, per snapped cell, the action to take:

  move            coords -> resolved gridpoint; four-tier R2 key rename
                  (archive/recent/forecast/debias). Name kept verbatim.
  move_repull     same, but the solar-day offset int(round(lon/15)) changes
                  with the longitude move, so the archive must be RE-PULLED
                  at the new gridpoint with the new offset (daily bucketing
                  shifts), not key-renamed.
  drop_dup_existing  the resolved gridpoint IS an existing cell's coordinate:
                  the archive is a byte-duplicate of that cell's. Remove the
                  row, delete the four old R2 objects. merge_into names the
                  surviving row — but the surviving row takes the HIGHER-
                  POPULATION name of the pair (survivor_name): "Barcelona,
                  Spain" must not vanish in favor of "Nou Barris, Spain" just
                  because Nou Barris happened to sit on the land gridpoint.
                  The surviving row also takes max(population) of the pair —
                  the two cells overlap ambiguously, so summing double-counts.
  drop_dup_moved  two moved cells resolve to the SAME gridpoint: the higher-
                  population one keeps it (action=move), the rest drop.
  drop_decision   USER DECISION 2026-08-25: the four St Kitts pile-ups
                  (The Valley / Marigot / Philipsburg / Gustavia all resolve
                  to 17.4,-62.8, an unclaimed St Kitts gridpoint 15 km from
                  Basseterre's cell). Keeping any of them would plant a second
                  St Kitts cell under a foreign island's name; search snaps
                  their users to Basseterre with an honest distance instead.

The manifest doubles as the join-remap table for everything keyed by the OLD
coordinates: cached HRES pulls, bias-study feathers, per-cell debias tables.
Downstream, remap old_base -> new_base before joining anything historical.

Reads:  snap_audit.csv (audit_snap_distances.py), ../../data/cells.csv
Writes: snap_rewrite_plan.csv (one row per snapped cell, action column)
"""
from __future__ import annotations

import csv
from collections import defaultdict
from pathlib import Path

from cell_keys import cell_base

SCRIPT_DIR = Path(__file__).resolve().parent
AUDIT_CSV = SCRIPT_DIR / "snap_audit.csv"
# Root by search, not by depth: this dir sits at a different level on the VM mirror.
REPO = next(p for p in SCRIPT_DIR.parents if (p / "data" / "cells.csv").is_file())
CELLS_CSV = REPO / "data" / "cells.csv"
PLAN_CSV = SCRIPT_DIR / "snap_rewrite_plan.csv"

CAP_KM = 25.0

# USER DECISION 2026-08-25 — see module docstring. Keyed by cell name because
# cell_id is positional and this file must stay reviewable.
ST_KITTS_PILEUP_DROPS = {
    "The Valley, Anguilla",
    "Marigot, Saint Martin",
    "Philipsburg, Sint Maarten",
    "Gustavia, Saint Barthelemy",
}

# Survivor-name overrides for merges where the population rule picks the worse
# display name AND no other cell carries the clean name (checked 2026-08-25:
# each pair below is the only carrier of its clean name; Doha and Casablanca
# pairs are NOT overridden because other cells keep those names alive).
# Keyed by the MOVED cell's name -> the name the merged row should carry.
MERGE_NAME_OVERRIDES = {
    "Vladivostok City District, Vladivostok, Russia": "Vladivostok, Russia",
    "Localidad 1 Cultural Tayrona - San Pedro Alejandrino, Santa Marta, Colombia":
        "Santa Marta, Colombia",
    "Esmeraldas, Ecuador (N)": "Esmeraldas, Ecuador",
    "Hayy ash Shati, Şalālah, Oman": "Şalālah, Oman",
    "Arrondissement de Sidi Belyout ⵜⴰⴳⵥⵥⵓⵎⵜ ⵏ ⵙⵉⴷⵉ ⴱⵍⵢⵓⵟ مقاطعة سيدي بليوط, Casablanca, Morocco":
        "Errahma, Casablanca, Morocco",
}

FIELDNAMES = [
    "cell_id", "name", "population", "action", "merge_into",
    "survivor_name", "survivor_population",
    "old_lat", "old_lon", "new_lat", "new_lon", "snap_km",
    "old_base", "new_base",
    "offset_old_h", "offset_new_h", "offset_flip",
    "old_tile_id", "new_tile_id", "new_tile_lat", "new_tile_lon",
    "tile_changed",
]


def solar_offset_hours(lon_deg: float) -> int:
    """Whole-hour local solar offset — MUST mirror download_cells.py."""
    lon180 = lon_deg if lon_deg <= 180 else lon_deg - 360
    return int(round(lon180 / 15.0))


def tile_of(lat: float, lon: float) -> tuple[str, float, float]:
    """New-scheme (50 lat x 100 lon index) tile for a gridpoint.

    Store grid: lat 90.0 -> -57.1 step -0.1 (idx r*50..), lon 0.0 -> 359.9
    (idx c*100..). Returns (tile_id, tile_lat, tile_lon) as cells.csv holds
    them: tile_lat = top edge, tile_lon = west edge.
    """
    lon360 = lon if lon >= 0 else lon + 360
    lat_idx = round((90.0 - lat) / 0.1)
    lon_idx = round(lon360 / 0.1)
    row, col = lat_idx // 50, lon_idx // 100
    return f"{row}_{col}", round(90.0 - row * 5.0, 1), round(col * 10.0, 1)


def base(lat: float, lon: float) -> str:
    """R2 key base: `{lat}_{lon}` — object key is {tier}/{tier}_{base}.csv.gz.
    Via cell_keys so a -0.0 axis becomes "0.0" like every other key."""
    return cell_base(lat, lon)


def main() -> int:
    with AUDIT_CSV.open() as f:
        audit = list(csv.DictReader(f))
    with CELLS_CSV.open(newline="") as f:
        cells = list(csv.DictReader(f))

    by_name = {c["name"]: c for c in cells}
    assert len(by_name) == len(cells), "cells.csv names are not unique"

    snapped = [r for r in audit if r["snapped"] == "True"]
    for r in snapped:
        r["snap_km"] = float(r["snap_km"])
        # audit res_lon is store-space 0..360; cells.csv wants -180..180
        res_lon = float(r["res_lon"])
        r["new_lon"] = round(res_lon if res_lon <= 180 else res_lon - 360, 1)
        r["new_lat"] = round(float(r["res_lat"]), 1)

    # Coordinates of cells that are NOT moving (for dup-with-existing checks).
    moving_names = {r["name"] for r in snapped}
    static_coords = {
        (round(float(c["lat"]), 1), round(float(c["lon"]), 1)): c["name"]
        for c in cells if c["name"] not in moving_names
    }

    # Group movers by destination gridpoint to find move-vs-move collisions.
    dest_groups: dict[tuple, list[dict]] = defaultdict(list)
    for r in snapped:
        dest_groups[(r["new_lat"], r["new_lon"])].append(r)

    rows = []
    for r in snapped:
        cell = by_name[r["name"]]
        old_lat, old_lon = round(float(cell["lat"]), 1), round(float(cell["lon"]), 1)
        dest = (r["new_lat"], r["new_lon"])
        off_old = solar_offset_hours(old_lon)
        off_new = solar_offset_hours(r["new_lon"])
        new_tile, new_tlat, new_tlon = tile_of(*dest)

        def pop_of(name: str) -> int:
            return int(by_name[name]["population"] or 0)

        merge_into = survivor_name = ""
        survivor_pop = ""
        if r["name"] in ST_KITTS_PILEUP_DROPS:
            # Decision drops never rename their survivor: the gridpoint is
            # St Kitts and keeps its St Kitts name regardless of populations.
            action = "drop_decision"
            merge_into = survivor_name = "Basseterre, Saint Kitts and Nevis"
            survivor_pop = pop_of(merge_into)
        elif dest in static_coords:
            action = "drop_dup_existing"
            merge_into = static_coords[dest]
            if r["snap_km"] > CAP_KM:
                # Over-cap merge: the mover's name belongs to a place the data
                # is NOT from (St Croix's data is Fajardo's). Renaming Fajardo
                # to "St Croix" would be the West-Java-as-Flying-Fish-Cove bug
                # again — the local name always survives.
                survivor_name = merge_into
            else:
                survivor_name = MERGE_NAME_OVERRIDES.get(
                    r["name"], max(r["name"], merge_into, key=pop_of))
            survivor_pop = max(pop_of(r["name"]), pop_of(merge_into))
        else:
            group = [g for g in dest_groups[dest]
                     if g["name"] not in ST_KITTS_PILEUP_DROPS]
            keeper = max(group, key=lambda g: pop_of(g["name"]))
            if r is not keeper:
                action = "drop_dup_moved"
                merge_into = survivor_name = keeper["name"]
                survivor_pop = max(pop_of(g["name"]) for g in group)
            else:
                action = "move_repull" if off_old != off_new else "move"

        rows.append({
            "cell_id": cell["cell_id"], "name": r["name"],
            "population": cell["population"],
            "action": action, "merge_into": merge_into,
            "survivor_name": survivor_name, "survivor_population": survivor_pop,
            "old_lat": old_lat, "old_lon": old_lon,
            "new_lat": dest[0], "new_lon": dest[1],
            "snap_km": r["snap_km"],
            "old_base": base(old_lat, old_lon), "new_base": base(*dest),
            "offset_old_h": off_old, "offset_new_h": off_new,
            "offset_flip": off_old != off_new,
            "old_tile_id": cell["tile_id"], "new_tile_id": new_tile,
            "new_tile_lat": new_tlat, "new_tile_lon": new_tlon,
            "tile_changed": new_tile != cell["tile_id"],
        })

    # Over-cap cells the user chose to keep must be explicit, not accidental:
    # everything over the cap that is not dropped is a deliberate rename-keep.
    over_kept = [x for x in rows if x["snap_km"] > CAP_KM
                 and x["action"] in ("move", "move_repull")]

    rows.sort(key=lambda x: (-x["snap_km"], x["name"]))
    with PLAN_CSV.open("w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=FIELDNAMES)
        writer.writeheader()
        writer.writerows(rows)

    counts = defaultdict(int)
    for x in rows:
        counts[x["action"]] += 1
    print(f"Wrote {len(rows)} row(s) to {PLAN_CSV}")
    for action in ("move", "move_repull", "drop_dup_existing",
                   "drop_dup_moved", "drop_decision"):
        print(f"  {action:18s} {counts[action]}")
    drops = sum(v for k, v in counts.items() if k.startswith("drop"))
    print(f"  cells.csv: {len(cells)} -> {len(cells) - drops}")

    if over_kept:
        print(f"\n{len(over_kept)} over-cap rename-keep(s) (deliberate, honest UI distance):")
        for x in over_kept:
            print(f"  {x['snap_km']:7.1f} km  {x['name']}  ({x['action']})")
    flips = [x for x in rows if x["offset_flip"] and x["action"].startswith("move")]
    print(f"\noffset flips needing re-pull: {len(flips)}")
    for x in flips:
        print(f"  {x['name']}: {x['offset_old_h']:+d}h -> {x['offset_new_h']:+d}h")
    tile_moves = [x for x in rows if x["tile_changed"] and x["action"].startswith("move")]
    print(f"tile crossings among moves: {len(tile_moves)}")
    for x in tile_moves:
        print(f"  {x['name']}: {x['old_tile_id']} -> {x['new_tile_id']}")
    renames = [x for x in rows if x["survivor_name"]
               and x["survivor_name"] != x["merge_into"]]
    print(f"\nmerges where the surviving row takes the dropped cell's name: "
          f"{len(renames)}")
    for x in renames:
        print(f"  {x['merge_into']}  ->  {x['survivor_name']}  "
              f"(pop {x['survivor_population']})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
