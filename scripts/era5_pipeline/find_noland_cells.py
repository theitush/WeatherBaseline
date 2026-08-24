"""Find cells whose ERA5-Land tile window is entirely ocean (no land gridpoint).

ERA5-Land is land-only (ocean gridpoints are NaN). A handful of cells — small
atolls/islands like Male, Maldives — snap to a 0.1deg window that has NO land at
all, so download_cells.py's process_span SKIPS them (it refuses to write a blank
archive, cf. Finding F1). That skip is correct, but it also means the cell's
archive never exists, which makes the resume check treat the whole tile as
"not done" and REFETCH it on every run forever (never converging). The clean fix
is to drop these permanently-unfillable cells from cells.csv.

This finds them authoritatively by replaying EXACTLY what process_span does —
same tile-window selection, same nearest-LAND resolution (resolve_land_indices)
— but reading only ONE timestep-chunk of t2m per tile (~47 MB) instead of the
full hourly history. Land is static, so one chunk's finite-mask == the mask
process_span builds over a whole span. Imports the real downloader functions so
it can't drift from the skip logic it's mirroring.

Usage:
  source .venv/bin/activate
  python find_noland_cells.py                    # probe all tiles, write list
  python find_noland_cells.py --tile 13_11,9_5   # probe specific tile(s)
  python find_noland_cells.py --workers 6
Writes noland_cells.csv (cell_id,lat,lon,tile_id,name); remove those from
cells.csv with:  python find_noland_cells.py --remove
"""
from __future__ import annotations

import argparse
import csv
from concurrent.futures import ThreadPoolExecutor, as_completed

import numpy as np

# Reuse the downloader's own logic so this can't diverge from what it skips.
from download_cells import (
    CELLS_CSV,
    TILE_LAT_CELLS,
    TILE_LON_CELLS,
    _compute_step,
    group_by_tile,
    load_cells,
    log,
    open_store,
    resolve_land_indices,
)

NOLAND_CSV = CELLS_CSV.parent / "noland_cells.csv"


def probe_tile(ds, tile_id: str, tile_cells: list[dict]) -> list[dict]:
    """Return the cells in this tile whose window has NO land (would be skipped).

    Mirrors process_span's window selection and nearest-land snap, but on a
    single day of t2m. A cell resolves to None (no land anywhere in the window)
    iff process_span would skip it.
    """
    lat_name = "latitude" if "latitude" in ds.coords else "lat"
    lon_name = "longitude" if "longitude" in ds.coords else "lon"
    time_name = "valid_time" if "valid_time" in ds.coords else "time"

    lon_max = float(ds[lon_name].max())
    lon_is_360 = lon_max > 180.5
    lons = np.array([c["lon"] for c in tile_cells])
    sel_lons = np.where(lons < 0, lons + 360.0, lons) if lon_is_360 else lons

    chunk_row, chunk_col = (int(x) for x in tile_id.split("_"))
    lat_i0, lat_i1 = chunk_row * TILE_LAT_CELLS, (chunk_row + 1) * TILE_LAT_CELLS
    lon_i0, lon_i1 = chunk_col * TILE_LON_CELLS, (chunk_col + 1) * TILE_LON_CELLS
    lat_i1 = min(lat_i1, ds.sizes[lat_name])
    lon_i1 = min(lon_i1, ds.sizes[lon_name])

    # One day is plenty (land is static); the whole time-chunk downloads either
    # way, so any-finite over 24 h == process_span's any-finite-over-span mask.
    sub = ds["t2m"].isel({
        lat_name: slice(lat_i0, lat_i1),
        lon_name: slice(lon_i0, lon_i1),
        time_name: slice(0, 24),
    })
    arr = _compute_step(f"t2m {tile_id}", sub)
    finite = np.isfinite(arr).any(dim=time_name).values
    win_lats = arr[lat_name].values
    win_lons = arr[lon_name].values

    targets = [(c["lat"], float(s)) for c, s in zip(tile_cells, sel_lons)]
    idx = resolve_land_indices(finite, win_lats, win_lons, targets)
    return [c for c, i in zip(tile_cells, idx) if i is None]


def find_noland(tiles: dict[str, list[dict]], workers: int) -> list[dict]:
    ds = open_store()
    noland: list[dict] = []
    done = 0
    total = len(tiles)
    with ThreadPoolExecutor(max_workers=workers) as ex:
        futs = {ex.submit(probe_tile, ds, t, c): t for t, c in tiles.items()}
        for fut in as_completed(futs):
            tile_id = futs[fut]
            hits = fut.result()
            done += 1
            if hits:
                noland.extend(hits)
                for c in hits:
                    log(f"NO LAND  {tile_id}  cell {c['cell_id']}  "
                        f"{c['lat']:.1f},{c['lon']:.1f}  {c.get('name','')}")
            log(f"[{done}/{total}] tiles probed; {len(noland)} no-land cells so far")
    return sorted(noland, key=lambda c: c["cell_id"])


def write_list(noland: list[dict]) -> None:
    with NOLAND_CSV.open("w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["cell_id", "lat", "lon", "tile_id", "name"])
        for c in noland:
            w.writerow([c["cell_id"], c["lat"], c["lon"], c["tile_id"],
                        c.get("name", "")])
    print(f"\nWrote {len(noland)} no-land cell(s) to {NOLAND_CSV}")


def remove_from_cells() -> None:
    """Drop the cells listed in noland_cells.csv from cells.csv (keeps a .bak)."""
    if not NOLAND_CSV.exists():
        raise SystemExit(f"{NOLAND_CSV} not found — run the probe first.")
    with NOLAND_CSV.open() as f:
        drop_ids = {int(r["cell_id"]) for r in csv.DictReader(f)}
    if not drop_ids:
        print("noland_cells.csv is empty — nothing to remove.")
        return
    with CELLS_CSV.open(newline="") as f:
        rows = list(csv.reader(f))
    header, body = rows[0], rows[1:]
    id_col = header.index("cell_id")
    kept = [r for r in body if int(r[id_col]) not in drop_ids]
    removed = len(body) - len(kept)
    bak = CELLS_CSV.with_suffix(".csv.pre_noland.bak")
    bak.write_bytes(CELLS_CSV.read_bytes())
    with CELLS_CSV.open("w", newline="") as f:
        w = csv.writer(f)
        w.writerow(header)
        w.writerows(kept)
    print(f"Removed {removed} cell(s) from {CELLS_CSV} "
          f"({len(kept)} remain). Backup: {bak}")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--tile", help="tile_id(s), comma-separated; default: all")
    ap.add_argument("--workers", type=int, default=6,
                    help="concurrent tile probes (default 6)")
    ap.add_argument("--remove", action="store_true",
                    help="skip probing; remove noland_cells.csv ids from cells.csv")
    args = ap.parse_args()

    if args.remove:
        remove_from_cells()
        return 0

    cells = load_cells()
    by_tile = group_by_tile(cells)
    if args.tile:
        wanted = [t.strip() for t in args.tile.split(",") if t.strip()]
        missing = [t for t in wanted if not by_tile.get(t)]
        if missing:
            print(f"no cells in tile(s): {', '.join(missing)}")
            return 1
        tiles = {t: by_tile[t] for t in wanted}
    else:
        tiles = by_tile

    print(f"Probing {len(tiles)} tile(s) for all-ocean windows "
          f"({args.workers} concurrent)...")
    noland = find_noland(tiles, args.workers)
    write_list(noland)
    if noland:
        print("Review noland_cells.csv, then remove them with:")
        print("  python find_noland_cells.py --remove")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
