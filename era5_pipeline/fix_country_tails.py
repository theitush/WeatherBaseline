"""Re-derive the country tail of any cell name that contradicts the place it names.

The rule (name_cells.py), unchanged
-----------------------------------
A cell name is "{place}[, parent][, region], {country}", and the country is the
country of the gazetteer city the join picked at the pin. So the tail has to be
the country of the place the label names: a label that says "Thimphu" has to say
"Bhutan".

What broke
----------
The 2026-06-23 rebalance (a2feaf49) added the national and admin-1 capitals whose
densest cell falls below the old population cutoff — which is where Bhutan's three
cells came from — and they landed labelled "Thimphu, India", "Punākha, India",
"Tsirang, India". The place names are right; only the country tail is wrong, and
it made Bhutan invisible to any country count over cells.csv. Re-running today's
join at those exact pins returns cc=BT, so the tails are a stale artifact of that
one data step, not something the naming code still produces (issue #37).

Why not just re-run name_cells.py
---------------------------------
A full re-run undoes the dedupe pass: measured in rename_snapped_cells.py, it
rewrites 3,498 untouched cells from their sub-district back to the bare metro and
re-introduces thousands of duplicate labels. Targeted patch only, same pattern as
rename_snapped_cells.py and name_coord_cells.py.

Why not re-derive every tail from the nearest-city join
-------------------------------------------------------
The join is not the authority on which country a pin is in. Ten cells' tails
disagree with it, and seven are right as they stand: a border town whose nearest
prominent gazetteer city is across the line (Vaduz next to Switzerland's Buchs,
Saint-Louis next to Mauritania, Giurgiu next to Bulgaria's Ruse, Leticia, Rivera,
Pedro Juan Caballero, Aqaba). Only the *internal* contradiction is unambiguous —
the tail disagreeing with the country of the very city the label names, found
within FAR_KM of the pin — and it fires on 3 of 8,620 cells, the Bhutan three.

Usage
-----
  .venv/bin/python fix_country_tails.py --dry-run
  .venv/bin/python fix_country_tails.py
"""
from __future__ import annotations

import argparse
import csv
import re
import shutil
import sys
import unicodedata
from collections import Counter
from pathlib import Path

import numpy as np

import name_cells as nc

HERE = Path(__file__).resolve().parent
# Repo root — walked up to the dir holding data/cells.csv rather than counting
# levels off HERE, so this works from both the current layout and the VM's
# rsync'd scripts/<dir>/ mirror (#35).
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


def fold(s: str) -> str:
    """Casefold + strip accents, so "Punākha" in a label matches "Punakha" in a dump."""
    norm = unicodedata.normalize("NFKD", s.casefold())
    return "".join(c for c in norm if not unicodedata.combining(c)).strip()


def project(lats, lons) -> np.ndarray:
    """Equirectangular km about the equator — name_cells.py's own projection."""
    x = np.radians(lons) * np.cos(np.radians(lats))
    y = np.radians(lats)
    return np.column_stack([x, y]) * nc.R_EARTH_KM


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
    countries = set(cc_to_country.values())

    lats = np.array([float(r["lat"]) for r in rows])
    lons = np.array([float(r["lon"]) for r in rows])

    from scipy.spatial import cKDTree
    tree = cKDTree(project(gaz_lats, gaz_lons))
    # Every gazetteer city close enough to the pin to be the one the label names.
    neighbours = tree.query_ball_point(project(lats, lons), r=nc.FAR_KM)

    proposals: list[tuple[int, str, str, str, float]] = []
    for i, r in enumerate(rows):
        suffix = BEARING.search(r["name"])
        label = BEARING.sub("", r["name"])
        segments = [s.strip() for s in label.split(",")]
        if len(segments) < 2:
            continue                       # a bare place or coords — no country tail
        tail, places = segments[-1], {fold(s) for s in segments[:-1]}
        if tail not in countries:
            continue                       # Photon/Nominatim named it in the local
                                           # language ("西关社区, 中国") — not ours to re-derive
        matches = [(j, nc.haversine_km(lats[i], lons[i], gaz_lats[j], gaz_lons[j]))
                   for j in neighbours[i] if fold(names[j]) in places]
        if not matches or tail in {cc_to_country.get(ccs[j], ccs[j]) for j, _ in matches}:
            continue                       # nothing to check against, or it agrees
        # The label names a place the gazetteer puts in another country. Take the
        # country of the nearest such place — the one the pin actually sits in.
        j, km = min(matches, key=lambda t: t[1])
        country = cc_to_country.get(ccs[j], ccs[j])
        fixed = ", ".join(segments[:-1] + [country]) + (suffix.group(0) if suffix else "")
        proposals.append((i, r["name"], fixed, names[j], km))

    print(f"\n  {len(proposals)} of {len(rows):,} cells name a place the gazetteer puts "
          f"in another country\n", file=sys.stderr)
    print(f"{'cell':>6}  {'was':40}  {'now':40}  via")
    for i, old, new, city, km in proposals:
        print(f"{rows[i]['cell_id']:>6}  {old:40}  {new:40}  {city} ({km:.1f} km)")

    final = Counter(r["name"] for i, r in enumerate(rows)
                    if i not in {p[0] for p in proposals})
    for _i, _old, new, _c, _k in proposals:
        final[new] += 1
    dupes = sorted({new for _i, _o, new, _c, _k in proposals if final[new] > 1})
    if dupes:
        print(f"\n  {len(dupes)} name collision(s) — run disambiguate_dupes.py after:",
              file=sys.stderr)
        for d in dupes:
            print(f"    {d} (x{final[d]})", file=sys.stderr)
    else:
        print("\n  no name collisions", file=sys.stderr)

    if args.dry_run:
        print("  --dry-run: nothing written", file=sys.stderr)
        return 0
    if not proposals:
        print("  nothing to write", file=sys.stderr)
        return 0

    backup = CELLS.with_suffix(".csv.pre_country_tail.bak")
    shutil.copy2(CELLS, backup)
    for i, _old, new, _c, _k in proposals:
        rows[i]["name"] = new
    with CELLS.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fieldnames)
        w.writeheader()
        w.writerows(rows)
    print(f"  backed up -> {backup.name}\n  wrote {CELLS}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
