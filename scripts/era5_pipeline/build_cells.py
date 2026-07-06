"""Canonical rebuild of data/cells.csv, end to end.

For a long time the cell list was maintained by running several scripts by hand in
a specific order and remembering which came after which. This orchestrator encodes
that order in one place so a rebuild is reproducible and no step gets forgotten.

Pipeline (each step is idempotent -- a no-op when it has nothing to do)
----------------------------------------------------------------------
  1. apply_coastal_snap.py   Move every coastal/blank cell onto its nearest ERA5-Land
                             LAND gridpoint (Finding F1), from coastal_snap_map.json.
                             On an already-snapped cells.csv the old coords are gone,
                             so there is nothing left to move/drop -> no-op.
  2. name_cells.py           Derive each cell's `name` from the GeoNames gazetteer,
                             splice in the admin-1 region for cross-region clashes,
                             and (final step, folded in) refine same-metro duplicates
                             to sub-district so every cell's name is unique. All
                             network lookups are cached, so a warm rerun is instant.
  3. name_coord_cells.py     Backfill any cell still labelled by bare "lat, lon" via
                             Nominatim and seed revgeo_cache so step 2 reproduces it
                             next time. No-op once every cell has a real name.

This does NOT run select_cells.py -- that regenerates the curated 10K list from
scratch and is a separate, deliberate upstream action. build_cells operates on the
existing data/cells.csv.

Usage
-----
  source .venv/bin/activate
  python build_cells.py                 # run the full pipeline
  python build_cells.py --skip-coastal  # names only (coords already snapped)
"""
from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent


def run(script: str, *script_args: str) -> None:
    """Run one pipeline step with the current interpreter; abort on failure."""
    cmd = [sys.executable, str(HERE / script), *script_args]
    print(f"\n=== {script} {' '.join(script_args)} ".ljust(72, "="), flush=True)
    result = subprocess.run(cmd)
    if result.returncode != 0:
        sys.exit(f"\n{script} failed (exit {result.returncode}); pipeline aborted.")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--skip-coastal", action="store_true",
                    help="skip the coastal-snap step (coords already on land)")
    ap.add_argument("--no-photon", action="store_true",
                    help="pass through to name_cells: skip the Photon fallback")
    ap.add_argument("--no-dedupe", action="store_true",
                    help="pass through to name_cells: skip the sub-district dedupe")
    args = ap.parse_args()

    if not args.skip_coastal:
        run("apply_coastal_snap.py")

    name_args = []
    if args.no_photon:
        name_args.append("--no-photon")
    if args.no_dedupe:
        name_args.append("--no-dedupe")
    run("name_cells.py", *name_args)

    run("name_coord_cells.py")

    print("\n" + "=" * 72)
    print("cells.csv rebuild complete.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
