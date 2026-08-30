"""Audit how far the nearest-land snap moved every cell (the Christmas Island bug).

`resolve_land_indices` snaps a cell whose nearest ERA5-Land gridpoint is ocean
to the nearest land ANYWHERE in its 5x10deg tile window, with no distance cap.
That silently relocated "Flying Fish Cove, Christmas Island" 350 km onto West
Java and shipped a full, plausible-looking archive of the wrong climate. This
audits the whole grid: for every cell, compute where the snap actually lands
and the great-circle distance moved, so a cap can be set from data.

Mirrors find_noland_cells.py: replays process_span's exact window selection and
calls the real resolve_land_indices, reading ONE timestep chunk of t2m per tile
(~47 MB) instead of a full history — land is static, so one chunk's finite-mask
equals the mask a full span builds. Fetched masks are cached to tiny local .npz
files so cap-tuning reruns cost nothing.

Per cell it reports (snap_audit.csv, sorted by distance descending):
  - the cell's own (lat, lon) and its nearest gridpoint (+ whether it is land)
  - the resolved land gridpoint and haversine km moved (snap_km)
  - the true haversine-nearest land gridpoint in the window (min_land_km) —
    the in-code snap minimizes squared INDEX distance, which drifts from
    great-circle nearest at high latitude; this column shows the gap
  - cross_tile_possible: the cell sits close enough to its tile's edge that a
    NEIGHBORING tile could hold nearer land than the chosen snap — such a cell
    is a window artifact, not necessarily a Christmas-Island-style drop
  - tile id, name, population (so impact is rankable)

Guards: after the no-land purge every tile in cells.csv must contain land, so
an all-ocean mask now means a broken query (an all-NaN fetch looks identical to
genuine ocean — exactly what hid the bug). Such tiles are reported loudly and
their masks are NOT cached.

Usage:
  source .venv/bin/activate
  python audit_snap_distances.py                 # all tiles (~331 x ~47 MB!)
  python audit_snap_distances.py --tile 20_10    # specific tile(s)
  python audit_snap_distances.py --workers 6 --report-over 25
Get an explicit go before an all-tiles run — it downloads ~16 GB from the
DestinE store (see the download_cells token rule in memory).
"""
from __future__ import annotations

import argparse
import csv
import math
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import numpy as np

# Reuse the downloader's own logic so this can't diverge from what it audits.
from download_cells import (
    TILE_LAT_CELLS,
    TILE_LON_CELLS,
    _compute_step,
    group_by_tile,
    load_cells,
    log,
    open_store,
    resolve_land_indices,
)

SCRIPT_DIR = Path(__file__).parent
MASK_CACHE_DIR = SCRIPT_DIR / "snap_audit_masks"
AUDIT_CSV = SCRIPT_DIR / "snap_audit.csv"

EARTH_RADIUS_KM = 6371.0088


def haversine_km(lat1, lon1, lat2, lon2):
    """Great-circle distance in km. Accepts scalars or numpy arrays (degrees)."""
    lat1, lon1, lat2, lon2 = (np.radians(np.asarray(x, dtype=float))
                              for x in (lat1, lon1, lat2, lon2))
    half_dlat = (lat2 - lat1) / 2.0
    half_dlon = (lon2 - lon1) / 2.0
    a = (np.sin(half_dlat) ** 2
         + np.cos(lat1) * np.cos(lat2) * np.sin(half_dlon) ** 2)
    return 2.0 * EARTH_RADIUS_KM * np.arcsin(np.sqrt(a))


def fetch_tile_mask(ds, tile_id: str):
    """Build (land_mask, win_lats, win_lons, lon_is_360) for one tile.

    Reads a single timestep chunk of t2m — mirrors find_noland_cells.probe_tile
    (and through it process_span's window selection) exactly.
    """
    lat_name = "latitude" if "latitude" in ds.coords else "lat"
    lon_name = "longitude" if "longitude" in ds.coords else "lon"
    time_name = "valid_time" if "valid_time" in ds.coords else "time"
    lon_is_360 = float(ds[lon_name].max()) > 180.5

    chunk_row, chunk_col = (int(x) for x in tile_id.split("_"))
    lat_i0, lat_i1 = chunk_row * TILE_LAT_CELLS, (chunk_row + 1) * TILE_LAT_CELLS
    lon_i0, lon_i1 = chunk_col * TILE_LON_CELLS, (chunk_col + 1) * TILE_LON_CELLS
    lat_i1 = min(lat_i1, ds.sizes[lat_name])
    lon_i1 = min(lon_i1, ds.sizes[lon_name])

    sub = ds["t2m"].isel({
        lat_name: slice(lat_i0, lat_i1),
        lon_name: slice(lon_i0, lon_i1),
        time_name: slice(0, 24),
    })
    arr = _compute_step(f"t2m {tile_id}", sub)
    land_mask = np.isfinite(arr).any(dim=time_name).values
    return land_mask, arr[lat_name].values, arr[lon_name].values, lon_is_360


def load_or_fetch_mask(ds, tile_id: str, refresh: bool):
    """Fetch a tile's land mask, or reuse the cached .npz from a prior run.

    An all-ocean mask is never cached: after the no-land purge every tile with
    cells must contain land, so all-ocean now means a broken/failed query.
    """
    cache_path = MASK_CACHE_DIR / f"{tile_id}.npz"
    if cache_path.exists() and not refresh:
        cached = np.load(cache_path)
        return (cached["land_mask"], cached["win_lats"], cached["win_lons"],
                bool(cached["lon_is_360"]), True)
    land_mask, win_lats, win_lons, lon_is_360 = fetch_tile_mask(ds, tile_id)
    if land_mask.any():
        MASK_CACHE_DIR.mkdir(exist_ok=True)
        np.savez_compressed(cache_path, land_mask=land_mask, win_lats=win_lats,
                            win_lons=win_lons, lon_is_360=lon_is_360)
    return land_mask, win_lats, win_lons, lon_is_360, False


def audit_tile(tile_id: str, tile_cells: list[dict], land_mask, win_lats,
               win_lons, lon_is_360: bool) -> list[dict]:
    """Compute per-cell snap distances for one tile (pure math, no I/O)."""
    cell_lons = np.array([c["lon"] for c in tile_cells])
    sel_lons = (np.where(cell_lons < 0, cell_lons + 360.0, cell_lons)
                if lon_is_360 else cell_lons)
    targets = [(c["lat"], float(s)) for c, s in zip(tile_cells, sel_lons)]
    resolved = resolve_land_indices(land_mask, win_lats, win_lons, targets)

    land_rows, land_cols = np.nonzero(land_mask)
    n_rows, n_cols = land_mask.shape
    rows: list[dict] = []
    for cell, (target_lat, target_lon), res in zip(tile_cells, targets, resolved):
        near_row = int(np.abs(win_lats - target_lat).argmin())
        near_col = int(np.abs(win_lons - target_lon).argmin())
        near_lat = round(float(win_lats[near_row]), 2)
        near_lon = round(float(win_lons[near_col]), 2)
        near_is_land = bool(land_mask[near_row, near_col])
        base_km = float(haversine_km(cell["lat"], target_lon, near_lat, near_lon))

        record = {
            "cell_id": cell["cell_id"],
            "name": cell.get("name", ""),
            "population": cell.get("population", ""),
            "tile_id": tile_id,
            "lat": cell["lat"],
            "lon": cell["lon"],
            "near_lat": near_lat,
            "near_lon": near_lon,
            "near_is_land": near_is_land,
            "base_km": round(base_km, 2),
        }
        if res is None:
            # Whole window is ocean — process_span would skip this cell. After
            # the no-land purge this should never happen; treat as broken.
            record.update(res_lat="", res_lon="", snapped=True,
                          snap_km=float("inf"), min_land_km="",
                          cross_tile_possible="", no_land=True)
            rows.append(record)
            continue

        res_row, res_col = res
        res_lat = round(float(win_lats[res_row]), 2)
        res_lon = round(float(win_lons[res_col]), 2)
        snapped = (res_row, res_col) != (near_row, near_col)
        snap_km = float(haversine_km(cell["lat"], target_lon, res_lat, res_lon))

        # True great-circle nearest land in the window, for comparison with the
        # index-metric snap the pipeline uses (they diverge at high latitude).
        land_km = haversine_km(cell["lat"], target_lon,
                               win_lats[land_rows], win_lons[land_cols])
        min_land_km = float(land_km.min())

        # Could a NEIGHBORING tile hold nearer land than the chosen snap? True
        # when the cell's own gridpoint is closer to the window edge than to
        # the chosen land (in gridpoint units) — then this is a tile-boundary
        # artifact to fix by widening the window, not a cell to drop.
        chosen_gp_dist = math.hypot(res_row - near_row, res_col - near_col)
        edge_gp_dist = min(near_row, n_rows - 1 - near_row,
                           near_col, n_cols - 1 - near_col)
        cross_tile_possible = snapped and edge_gp_dist < chosen_gp_dist

        record.update(res_lat=res_lat, res_lon=res_lon, snapped=snapped,
                      snap_km=round(snap_km, 2),
                      min_land_km=round(min_land_km, 2),
                      cross_tile_possible=cross_tile_possible, no_land=False)
        rows.append(record)
    return rows


FIELDNAMES = ["cell_id", "name", "population", "tile_id", "lat", "lon",
              "near_lat", "near_lon", "near_is_land", "base_km",
              "res_lat", "res_lon", "snapped", "snap_km", "min_land_km",
              "cross_tile_possible", "no_land"]


def write_csv(rows: list[dict]) -> None:
    with AUDIT_CSV.open("w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=FIELDNAMES)
        writer.writeheader()
        writer.writerows(rows)
    print(f"\nWrote {len(rows)} cell(s) to {AUDIT_CSV}")


def print_summary(rows: list[dict], report_over_km: float) -> None:
    no_land = [r for r in rows if r["no_land"]]
    snapped = [r for r in rows if r["snapped"] and not r["no_land"]]
    print(f"\n=== Snap audit: {len(rows)} cells, {len(snapped)} snapped, "
          f"{len(no_land)} with NO land in window ===")
    if no_land:
        print("!! NO-LAND cells (all-ocean window — broken query or a cell the "
              "no-land purge missed):")
        for r in no_land:
            print(f"   {r['cell_id']}  {r['lat']},{r['lon']}  "
                  f"tile {r['tile_id']}  {r['name']}")
    if not snapped:
        return
    distances = np.array([r["snap_km"] for r in snapped])
    print(f"snap distance km: median {np.median(distances):.1f}  "
          f"p95 {np.percentile(distances, 95):.1f}  max {distances.max():.1f}")
    over = [r for r in snapped if r["snap_km"] > report_over_km]
    print(f"\n{len(over)} snapped cell(s) over {report_over_km:g} km:")
    for r in sorted(over, key=lambda r: -r["snap_km"]):
        cross = "  [cross-tile land possible]" if r["cross_tile_possible"] else ""
        print(f"  {r['snap_km']:8.1f} km  {r['lat']:6.1f},{r['lon']:6.1f}  "
              f"tile {r['tile_id']:>6}  pop {r['population']:>9}  "
              f"{r['name']}{cross}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tile", help="tile_id(s), comma-separated; default: all")
    parser.add_argument("--workers", type=int, default=6,
                        help="concurrent tile fetches (default 6)")
    parser.add_argument("--report-over", type=float, default=25.0,
                        help="list every snapped cell over this km (default 25)")
    parser.add_argument("--refresh", action="store_true",
                        help="refetch masks even when cached")
    args = parser.parse_args()

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

    cached_count = sum(1 for t in tiles
                       if (MASK_CACHE_DIR / f"{t}.npz").exists()
                       and not args.refresh)
    print(f"Auditing {len(tiles)} tile(s), {sum(len(c) for c in tiles.values())} "
          f"cell(s); {cached_count} mask(s) cached, "
          f"{len(tiles) - cached_count} to fetch (~47 MB each)...")

    ds = open_store() if cached_count < len(tiles) else None
    all_rows: list[dict] = []
    suspicious_tiles: list[str] = []
    done = 0
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = {
            pool.submit(load_or_fetch_mask, ds, tile_id, args.refresh): tile_id
            for tile_id in tiles
        }
        for future in as_completed(futures):
            tile_id = futures[future]
            land_mask, win_lats, win_lons, lon_is_360, from_cache = future.result()
            done += 1
            if not land_mask.any():
                suspicious_tiles.append(tile_id)
                log(f"!! tile {tile_id}: ALL-OCEAN mask — broken query or "
                    f"missed no-land cells; NOT cached")
            all_rows.extend(audit_tile(tile_id, tiles[tile_id], land_mask,
                                       win_lats, win_lons, lon_is_360))
            source = "cache" if from_cache else "fetch"
            log(f"[{done}/{len(tiles)}] tile {tile_id} ({source})")

    all_rows.sort(key=lambda r: (-(r["snap_km"] if r["snap_km"] != float("inf")
                                   else 1e9), r["cell_id"]))
    write_csv(all_rows)
    print_summary(all_rows, args.report_over)
    if suspicious_tiles:
        print(f"\n!! {len(suspicious_tiles)} ALL-OCEAN tile(s) (see above): "
              f"{', '.join(sorted(suspicious_tiles))}")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
