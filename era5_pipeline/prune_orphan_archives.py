"""Find (and optionally delete) R2 archive/ objects whose cell is not in cells.csv.

The archive tier holds one object per curated cell, keyed
  archive/archive_{lat:.1f}_{lon:.1f}.csv.gz
(see download_cells.archive_name). cells.csv is the source of truth for which
cells exist. When cells are dropped/moved (e.g. the coastal-snap rewrite), their
old archive objects are left orphaned in R2. This prunes them.

Matching is done on (round(lat,1), round(lon,1)) FLOAT tuples, not formatted
strings, so -0.0 vs 0.0 and other formatting quirks can't cause a false orphan.

Protected keys never deleted: anything not matching archive_*.csv.gz (e.g. the
.overwrite_progress.json resume ledger).

Auth: same R2 S3 API token env vars as r2_upload.py. Run:
  set -a; source r2.env; set +a
  python prune_orphan_archives.py            # dry run: list orphans only
  python prune_orphan_archives.py --delete   # actually delete them
"""
from __future__ import annotations

import argparse
import csv
import re
from pathlib import Path

from r2_upload import R2Uploader

HERE = Path(__file__).resolve().parent
# Root by search, not by depth: this dir sits at a different level on the VM mirror.
REPO = next(p for p in HERE.parents if (p / "data" / "cells.csv").is_file())
CELLS = REPO / "data" / "cells.csv"
KEY_RE = re.compile(r"^archive/archive_(-?\d+\.\d)_(-?\d+\.\d)\.csv\.gz$")


def cells_coords() -> set[tuple[float, float]]:
    """The (lat, lon) rounded to 0.1 for every cell in cells.csv."""
    coords: set[tuple[float, float]] = set()
    with CELLS.open(newline="") as fh:
        for row in csv.DictReader(fh):
            coords.add((round(float(row["lat"]), 1), round(float(row["lon"]), 1)))
    return coords


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--delete", action="store_true", help="actually delete orphans")
    ap.add_argument("--bucket", default=None)
    args = ap.parse_args()

    up = R2Uploader(bucket=args.bucket)
    keep = cells_coords()
    print(f"cells.csv: {len(keep)} unique cell coords")

    objs = up.list_sizes("archive/")
    data_keys = [k for k in objs if KEY_RE.match(k)]
    protected = [k for k in objs if not KEY_RE.match(k)]
    print(f"R2 archive/: {len(objs)} objects "
          f"({len(data_keys)} data, {len(protected)} protected/non-data)")
    for k in protected:
        print(f"  protected (kept): {k}")

    orphans = []
    for k in data_keys:
        m = KEY_RE.match(k)
        lat, lon = round(float(m.group(1)), 1), round(float(m.group(2)), 1)
        if (lat, lon) not in keep:
            orphans.append(k)

    orphan_bytes = sum(objs[k] for k in orphans)
    print(f"\norphans (in R2, not in cells.csv): {len(orphans)} objects, "
          f"{orphan_bytes / 1e6:.1f} MB")

    # Next to this script, like every other output in this dir — the pre-promotion
    # "scripts/era5_pipeline" spelling of the same place no longer exists.
    out = HERE / "orphan_archives.txt"
    out.write_text("\n".join(sorted(orphans)) + ("\n" if orphans else ""))
    print(f"full list written to {out}")
    for k in sorted(orphans)[:20]:
        print(f"  {k}")
    if len(orphans) > 20:
        print(f"  ... and {len(orphans) - 20} more (see {out.name})")

    if not orphans:
        print("\nnothing to delete.")
        return 0
    if not args.delete:
        print("\nDRY RUN — re-run with --delete to remove these.")
        return 0

    print(f"\ndeleting {len(orphans)} orphan objects...")
    done = 0
    for k in orphans:
        up.delete_object(k)
        done += 1
        if done % 50 == 0 or done == len(orphans):
            print(f"  {done}/{len(orphans)}")
    print("done.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
