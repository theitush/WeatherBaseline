"""Re-apply the cell naming rule at the pins the snap rewrite moved.

The rule (name_cells.py + disambiguate_dupes.py), unchanged
----------------------------------------------------------
Name the place at the pin, then add the least extra detail needed to make the
name unique:  "City, Country" -> "+ parent city" -> "+ admin-1 region" ->
"+ sub-district" -> "+ compass bearing". Every one of the 8,620 shipped names is
that rule applied at its own gridpoint.

What broke
----------
`apply_snap_rewrite.py` moved 121 cells onto the ERA5-Land gridpoint their archive
is actually read from, but kept the name computed at the OLD location. So those
cells — and only those — name a place the pin isn't at: "Road Town, British Virgin
Islands" over a gridpoint 116 km away in north-east Puerto Rico.

This re-runs the rule at their new pins. Nothing else in cells.csv is touched: the
other 8,499 cells were named from their own coords and never moved.

Do NOT "fix" them with a full name_cells.py re-run
--------------------------------------------------
Re-running only the nearest-city join over every cell UNDOES the dedupe pass —
measured here, it rewrites 3,498 of the untouched cells from their district back
to the bare metro ("Lake Town, Kolkata, West Bengal, India" -> "Kolkata, India"),
which is both less precise about the pin and re-introduces thousands of duplicate
labels. Targeted patch only, same pattern as name_coord_cells.py.

Renaming cannot hide a place from search: the app geocodes the query and snaps the
result to the nearest cell (frontend/src/services/cellIndex.ts), so "Road Town"
still resolves here — it just gets an honest label and its true distance badge.

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


def with_country(label: str, country: str) -> str:
    """Append the country unless it already tails the label (name_cells.py's rule)."""
    country = country.strip()
    return f"{label}, {country}" if country and not label.endswith(country) else label


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dry-run", action="store_true", help="print the plan, write nothing")
    ap.add_argument("--no-photon", action="store_true",
                    help="skip the reverse-geocode for cells with no gazetteer city "
                         "within FAR_KM; they keep their current name instead")
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
    admin1_to_name = load_aux("admin1CodesASCII.txt", 0, 1)

    lats = [float(rows[i]["lat"]) for i in targets]
    lons = [float(rows[i]["lon"]) for i in targets]
    nn_names, nn_cc, nn_a1, nn_dist = nc.nearest_city_join(lats, lons, *gaz)

    # Names held by the cells we are NOT touching — what a new label must not clash
    # with, and the input to the region-splice step.
    untouched = Counter(r["name"] for i, r in enumerate(rows) if i not in set(targets))
    cache = nc.load_revgeo_cache()

    proposals: list[tuple[int, str, str, float, float]] = []
    for n, i in enumerate(targets):
        snap_km = float(plan[rows[i]["cell_id"]]["snap_km"])
        if nn_dist[n] > nc.FAR_KM:
            # No gazetteer city near the pin — reverse-geocode it, exactly as
            # name_cells.py does for its sparse cells. Cached, so re-runs are free.
            key = f"{lats[n]:.2f},{lons[n]:.2f}"
            if cache.get(key) is None and not args.no_photon:
                print(f"  reverse-geocoding {rows[i]['name']} "
                      f"(nearest gazetteer city {nn_dist[n]:.0f} km away) ...",
                      file=sys.stderr)
                # Photon first (name_cells.py's fallback), then Nominatim, which
                # has the full OSM admin hierarchy and resolves the points Photon's
                # gazetteer misses — the same escalation name_coord_cells.py makes.
                rev = nc.photon_reverse(lats[n], lons[n])
                if rev is None:
                    from name_coord_cells import nominatim_reverse
                    rev = nominatim_reverse(lats[n], lons[n])
                cache[key] = rev
                nc.save_revgeo_cache(cache)
            rev = cache.get(key)
            label = with_country(rev[0], rev[1]) if rev else rows[i]["name"]
            proposals.append((i, rows[i]["name"], label, snap_km, nn_dist[n]))
            continue

        country = cc_to_country.get(nn_cc[n], nn_cc[n])
        label = with_country(nn_names[n], country)
        # Region splice — only when the concise label is already taken and the
        # region actually adds a segment (name_cells.py's rule).
        if untouched.get(label):
            reg = admin1_to_name.get(f"{nn_cc[n]}.{nn_a1[n]}", "")
            segments = {s.strip().casefold() for s in nn_names[n].split(",")}
            if reg and reg.casefold() not in segments:
                label = with_country(f"{nn_names[n]}, {reg}", country)
        proposals.append((i, rows[i]["name"], label, snap_km, nn_dist[n]))

    changed = [p for p in proposals if p[1] != p[2]]
    print(f"\n  {len(changed)} of {len(targets)} moved cells get a new name "
          f"({len(targets) - len(changed)} already named their pin)\n", file=sys.stderr)
    print(f"{'old km':>7} {'new km':>7}  {'was':44}  now")
    for i, old, new, snap_km, city_km in sorted(changed, key=lambda p: -p[3]):
        flag = "" if city_km < snap_km else "   <-- NOT closer"
        print(f"{snap_km:7.1f} {city_km:7.1f}  {old[:44]:44}  {new}{flag}")

    worse = [p for p in changed if p[4] >= p[3]]
    print(f"\n  renames that move the label CLOSER to the pin: "
          f"{len(changed) - len(worse)}/{len(changed)}", file=sys.stderr)

    final = Counter(untouched)
    for _i, _old, new, _s, _c in proposals:
        final[new] += 1
    dupes = sorted({new for _i, _o, new, _s, _c in proposals if final[new] > 1})
    if dupes:
        print(f"  {len(dupes)} collision(s) — run disambiguate_dupes.py after:",
              file=sys.stderr)
        for d in dupes:
            print(f"    {d} (x{final[d]})", file=sys.stderr)
    else:
        print("  no name collisions", file=sys.stderr)

    if args.dry_run:
        print("  --dry-run: nothing written", file=sys.stderr)
        return 0

    backup = CELLS.with_suffix(".csv.pre_snap_rename.bak")
    shutil.copy2(CELLS, backup)
    for i, _old, new, _s, _c in proposals:
        rows[i]["name"] = new
    with CELLS.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fieldnames)
        w.writeheader()
        w.writerows(rows)
    print(f"  backed up -> {backup.name}\n  wrote {CELLS}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
