"""Drop a cell name's leading place when it stands in a different country than its tail.

The rule (name_cells.py + disambiguate_dupes.py), sharpened
-----------------------------------------------------------
A cell name is "{place}[, parent][, region], {country}", built by naming the pin and
then adding the least extra detail needed to make the name unique. Every segment of
it describes ONE point on the ground, so every segment has to be in the country the
tail names. In particular the LEADING segment — the most specific place, the one the
label is really about — must be.

What broke
----------
Two of the 8,620 cells name a place on the far side of a national border:

    3893  37.1,41.2   "Çatalözü, Al Qāmishlī, Al-Hasakah, Syria"   Çatalözü is in Turkey
    8500  29.5,34.9   "Taba, Eilat, Southern District, Israel"     Taba is in Egypt

Not the nearest-city join's doing. At both pins the join picks a single city and
appends no parent — Al Qāmishlī (SY, 6.0 km) and Eilat (IL, 8.0 km) — so PROMINENCE_KM
and PARENT_KM never reach across the line, and guarding them would change nothing
here. The leading place is `disambiguate_dupes.py`'s work: both cells collided with a
neighbour (6881 "Damkhiya Kabira, Al Qāmishlī, ..."; 8482 "Eilat, ...") and the dedupe
pass prepended the finest sub-district OSM reports AT THE PIN. The pin is over the
border, so is the sub-district, and nothing checked.

`fix_country_tails.py` (#37) cannot see this: it asks whether ANY segment of a name
agrees with the tail, and here Al Qāmishlī and Eilat do. This asks the narrower
question about the leading segment alone, against the same authority — a gazetteer
city of that name within FAR_KM of the pin. It fires on exactly these 2 of 8,620.

Why the tail is not re-derived instead
--------------------------------------
Both pins really are across the line, so "Çatalözü, ..., Turkey" or "Taba, ..., Egypt"
would be truer about the ground — but it would leave "Al Qāmishlī, Al-Hasakah" or
"Eilat, Southern District" sitting in the wrong country instead, and 8500 would then
be a second "Taba" beside cell 8694. Dropping the segment the dedupe pass had no right
to add restores the name the naming rule actually produced, and moves no country tail:
these two cells join the border cells #37 documented and left alone, whose nearest
prominent gazetteer city is over a line (Vaduz, Aqaba, Giurgiu, Leticia, ...).

The reverse-geocoder's own country is NOT used as the test. OSM answers "United States"
over Puerto Rico, "Palestinian Territories" inside Israel's labels and "Somaliland" in
Somalia's; comparing it to the tail flags 21 cells, most of them naming variants or
disputed ground rather than errors.

Why not re-run name_cells.py
----------------------------
A full re-run undoes the dedupe pass: measured in rename_snapped_cells.py, it rewrites
3,498 untouched cells from their sub-district back to the bare metro and re-introduces
thousands of duplicate labels. Targeted patch only, same pattern as fix_country_tails.py
and rename_snapped_cells.py. name_cells.py now carries the guard for any future run.

Usage
-----
  .venv/bin/python fix_border_labels.py --dry-run
  .venv/bin/python fix_border_labels.py
"""
from __future__ import annotations

import argparse
import csv
import re
import shutil
import sys
from collections import Counter, defaultdict
from pathlib import Path

import name_cells as nc
from disambiguate_dupes import bearing

HERE = Path(__file__).resolve().parent
# Repo root — walked up to the dir holding data/cells.csv rather than counting levels
# off HERE, so this works from both the current layout and the VM's scripts/ mirror (#35).
REPO = next(p for p in HERE.parents if (p / "data" / "cells.csv").is_file())
CELLS = REPO / "data" / "cells.csv"
AUX = REPO / "data" / "era5-land"

# The dedupe pass tails a bearing or coord onto a name it had to split from a
# neighbour ("Harbin, Heilongjiang, China (NW)"); the country sits before it.
BEARING = re.compile(r"\s*\([^)]*\)$")


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


def country_tail(name: str) -> str:
    """The country segment of a cell name, bearing/coord suffix stripped."""
    return BEARING.sub("", name).rsplit(",", 1)[-1].strip()


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dry-run", action="store_true", help="print the plan, write nothing")
    args = ap.parse_args()

    with CELLS.open(encoding="utf-8") as f:
        reader = csv.DictReader(f)
        fieldnames = list(reader.fieldnames or [])
        rows = list(reader)
    print(f"  cells: {len(rows):,}", file=sys.stderr)

    gaz_lats, gaz_lons, names, _pops, ccs, _a1s = nc.load_gazetteer()
    cc_to_country = load_aux("countryInfo.txt", 0, 4)
    country_to_cc = {v: k for k, v in cc_to_country.items()}
    place_index = nc.build_place_index(names)

    lats = [float(r["lat"]) for r in rows]
    lons = [float(r["lon"]) for r in rows]

    # --- The rule: the leading place must be in the country the tail names. ---
    found: list[tuple[int, str, str]] = []      # (row, leading place, its country)
    for i, r in enumerate(rows):
        segments = [s.strip() for s in BEARING.sub("", r["name"]).split(",")]
        if len(segments) < 2:
            continue                            # coords, or a bare place — no tail
        tail_cc = country_to_cc.get(segments[-1])
        if tail_cc is None:
            continue                            # Photon/Nominatim named it in the local
                                                # language — not ours to re-derive
        near = nc.place_country_codes(place_index, gaz_lats, gaz_lons, ccs,
                                      lats[i], lons[i], segments[0])
        if not near or tail_cc in near:
            continue                            # gazetteer silent, or it agrees
        found.append((i, segments[0], cc_to_country.get(near[0], near[0])))

    print(f"\n  {len(found)} of {len(rows):,} cells lead with a place the gazetteer puts "
          f"in another country\n", file=sys.stderr)
    if not found:
        print("  nothing to do", file=sys.stderr)
        return 0

    # --- The repair: drop that segment, then re-establish uniqueness. ---
    # Names every OTHER cell holds; a shortened label may not collide with one. The
    # backstop is disambiguate_dupes.py's own: a compass bearing from the centroid of
    # the cells sharing the label, then the cell's exact coords.
    targets = {i for i, _p, _c in found}
    taken = {r["name"] for i, r in enumerate(rows) if i not in targets}
    by_base: dict[str, list[int]] = defaultdict(list)
    for i, r in enumerate(rows):
        by_base[BEARING.sub("", r["name"])].append(i)

    proposals: list[tuple[int, str, str, str, str]] = []
    for i, place, place_country in found:
        suffix = BEARING.search(rows[i]["name"])
        segments = [s.strip() for s in BEARING.sub("", rows[i]["name"]).split(",")]
        if len(segments) - 1 < 2:
            print(f"  cell {rows[i]['cell_id']}: dropping {place!r} would leave only "
                  f"a country — skipped", file=sys.stderr)
            continue
        base = ", ".join(segments[1:])
        cand = base + (suffix.group(0) if suffix else "")
        if cand in taken:
            group = sorted(set(by_base[base]) | {i})
            clat = sum(lats[k] for k in group) / len(group)
            clon = sum(lons[k] for k in group) / len(group)
            cand = f"{base} ({bearing(clat, clon, lats[i], lons[i])})"
        if cand in taken:
            cand = f"{base} ({lats[i]:.1f}, {lons[i]:.1f})"
        taken.add(cand)
        proposals.append((i, rows[i]["name"], cand, place, place_country))

    print(f"{'cell':>6}  {'was':44}  {'now':40}  leading place")
    for i, old, new, place, place_country in proposals:
        print(f"{rows[i]['cell_id']:>6}  {old:44}  {new:40}  {place} is in {place_country}")
    sys.stdout.flush()

    # --- The whole-grid check: no cell's country tail may move. ---
    # Every tail in the file, not just the recognised ones, so a repair that turned a
    # country into something unrecognisable would show up too.
    before = Counter(country_tail(r["name"]) for r in rows)
    after = Counter(before)
    for i, old, new, _p, _c in proposals:
        after[country_tail(old)] -= 1
        after[country_tail(new)] += 1
    after = Counter({k: v for k, v in after.items() if v})
    real = sum(1 for k in after if k in country_to_cc)
    print(f"\n  country tails: {len(before)} distinct before, {len(after)} after "
          f"({real} of them named countries) — "
          f"{'identical counts' if before == after else 'CHANGED'}", file=sys.stderr)
    if before != after:
        for k in sorted(set(before) | set(after)):
            if before[k] != after[k]:
                print(f"    {k}: {before[k]} -> {after[k]}", file=sys.stderr)
        sys.exit("  refusing to write: the repair moved a country tail")

    final = Counter(r["name"] for i, r in enumerate(rows) if i not in targets)
    for _i, _old, new, _p, _c in proposals:
        final[new] += 1
    dupes = sorted(n for n, c in final.items() if c > 1)
    print(f"  duplicate names after: {len(dupes)}", file=sys.stderr)
    for d in dupes:
        print(f"    {d} (x{final[d]})", file=sys.stderr)

    if args.dry_run:
        print("  --dry-run: nothing written", file=sys.stderr)
        return 0
    if dupes:
        sys.exit("  refusing to write: the repair left a duplicate name")

    backup = CELLS.with_suffix(".csv.pre_border_label.bak")
    shutil.copy2(CELLS, backup)
    for i, _old, new, _p, _c in proposals:
        rows[i]["name"] = new
    with CELLS.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fieldnames)
        w.writeheader()
        w.writerows(rows)
    print(f"  backed up -> {backup.name}\n  wrote {CELLS}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
