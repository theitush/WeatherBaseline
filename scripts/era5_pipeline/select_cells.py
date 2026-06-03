"""Pick the top-N populated ERA5-Land grid cells from the GHSL population grid.

Replaces the GeoNames cities5000 list (download_cities.py) with a population-
ranked selection of actual ERA5-Land 0.1deg grid cells. Two reasons this is
better for our pipeline:

  1. No interpolation. Each selected target IS an ERA5-Land cell centre, so the
     fetch pipeline reads the cell directly -- no +/-WINDOW_DEG window, no
     bilinear interp, no coastal-NaN fallback. A whole class of edge cases gone.
  2. Uniform, reproducible definition. "The N most-populated 0.1deg land cells"
     is physical and global, vs. the GeoNames gazetteer's uneven coverage.

What it does
------------
  download -> GHS-POP global raster (population count per pixel)
  aggregate -> sum population into ERA5-Land 0.1deg cells (the resolutions
               differ: GHSL is 100m/1km, ERA5-Land is 0.1deg ~= 11km)
  rank      -> argsort cells by total population, descending
  filter    -> keep only land cells (population > 0 is a reasonable proxy;
               ERA5-Land is land-only so ocean cells would be NaN anyway)
  select    -> take the top N
  bin       -> assign each cell to its 6.4deg zarr storage tile and report the
               tile count -- THIS is the number the request-quota math needs.

Output
------
  data/cells.csv          -- the selection: columns
                             cell_id,lat,lon,population,tile_id,tile_lat,tile_lon
  data/era5-land/pop_grid.npz  -- cached aggregated population grid (the slow part).
                             Reused on re-runs so a different --top-n is instant;
                             pass --refresh to recompute it. Keyed by raster
                             name so a new GHS-POP file is not silently reused.
  prints a tile-count summary + an estimated request budget for the zarr pull.

The ERA5-Land grid
------------------
  0.1deg regular grid. Cell centres at lat in {-90.0, -89.9, ...}, lon likewise.
  The zarr store chunks 64x64 cells per spatial tile => 6.4deg tiles. We bin on
  the same 64-cell stride so tile_id maps 1:1 to a zarr spatial chunk.

GHSL product
------------
  GHS-POP, epoch 2020 or 2025. Use the 30 ARC-SECOND WGS84 (EPSG:4326)
  product: ~1km pixels, native lat/lon so no reprojection is needed, and
  exactly 12x12 pixels per 0.1deg cell. Downsample by SUMMATION -- population
  is a COUNT, so coarsening means sum, never mean.

Usage
-----
  source .venv/bin/activate
  pip install rasterio   # not in requirements.txt yet
  python select_cells.py --top-n 10000 --ghsl path/to/GHS_POP_*_4326_30ss.tif

If --ghsl is omitted the script prints the download URL and exits, so we don't
silently pull a multi-GB raster without the user choosing the product/epoch.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
DATA = HERE.parents[1] / "data" / "era5-land"
OUT = HERE.parents[1] / "data" / "cells.csv"
# Cached aggregated population grid. Computing it means reading a multi-GB
# GHS-POP raster and scatter-adding ~1e9 pixels -- slow. Cache it so re-running
# with a different --top-n is instant. Keyed by raster name+epoch so a
# different GHS-POP file does not silently reuse a stale grid.
POP_CACHE = DATA / "pop_grid.npz"

# ERA5-Land grid: 0.1deg regular. The zarr store packs 64x64 cells per spatial
# chunk, so the "tile" for quota math is a 64-cell block = 6.4deg.
GRID_DEG = 0.1
TILE_CELLS = 64
TILE_DEG = GRID_DEG * TILE_CELLS  # 6.4

# The EarthDataHub zarr store indexes its coordinate arrays as:
#   latitude  90.0 .. -57.1 step -0.1   (index 0 = lat 90.0, descending)
#   longitude   0.0 .. 359.9 step  0.1  (index 0 = lon  0.0, ascending, 0..360)
# A chunk = 64 consecutive indices on each axis. tile_id MUST be derived from
# THESE indices, not from this script's internal -180..180 lon grid, or it
# won't map 1:1 to a zarr spatial chunk -- a per-tile fetch would then straddle
# up to 4 chunks and 4x the request budget.
STORE_LAT0 = 90.0  # store latitude[0]
STORE_LON0 = 0.0   # store longitude[0]


def store_tile(lat: float, lon: float) -> tuple[str, float, float]:
    """Map a cell centre to its zarr store-chunk tile.

    Returns (tile_id, tile_lat, tile_lon) where tile_id is "{chunk_row}_{chunk_col}"
    and tile_lat/tile_lon are the chunk's NW corner in the store's coords
    (lon in 0..360). This is the chunk a per-tile zarr fetch reads exactly once.
    """
    lat_idx = round((STORE_LAT0 - lat) / GRID_DEG)
    lon_idx = round((lon % 360.0 - STORE_LON0) / GRID_DEG)
    chunk_row = lat_idx // TILE_CELLS
    chunk_col = lon_idx // TILE_CELLS
    return (
        f"{chunk_row}_{chunk_col}",
        round(STORE_LAT0 - chunk_row * TILE_DEG, 1),
        round(STORE_LON0 + chunk_col * TILE_DEG, 1),
    )

# GHS-POP landing page. The catalogue offers, per epoch (2020/2025):
#   WGS84 (EPSG:4326):  3 arc-second (~100m)  and  30 arc-second (~1km)
#   Mollweide (equal-area): 100m and 1km
# We want a WGS84 GeoTIFF so aggregation to our 0.1deg lat/lon grid is a plain
# index bin -- no reprojection. Use the 30 ARC-SECOND WGS84 product: ~1km
# pixels (12x12 per 0.1deg cell), modest file size. The 3" (~100m) WGS84
# product is correct too but is overkill for an 11km target grid and far
# larger. A Mollweide raster would need reprojection this script does not do.
GHSL_INFO_URL = "https://human-settlement.emergency.copernicus.eu/download.php?ds=pop"


def era5_grid() -> tuple[np.ndarray, np.ndarray]:
    """Return (lats, lons) of ERA5-Land cell centres.

    lat: 90.0 .. -90.0 step -0.1 (1801 cells)   -- descending, ERA5 convention
    lon: -180.0 .. 179.9 step 0.1 (3600 cells)
    """
    lats = np.round(np.arange(90.0, -90.0 - GRID_DEG / 2, -GRID_DEG), 1)
    lons = np.round(np.arange(-180.0, 180.0 - GRID_DEG / 2, GRID_DEG), 1)
    return lats, lons


def aggregate_to_grid(ghsl_path: Path, lats: np.ndarray, lons: np.ndarray) -> np.ndarray:
    """Sum GHS-POP pixels into the ERA5-Land 0.1deg grid.

    Returns a (n_lat, n_lon) array of total population per cell.

    Population is a per-pixel COUNT, so coarsening is a SUM. We read the raster
    in row blocks (it is large) and scatter-add each pixel into its target cell
    via np.add.at on flat indices -- O(pixels), no full reprojection needed
    because a WGS84 GHS-POP raster is already lat/lon.
    """
    try:
        import rasterio
    except ImportError:
        print("ERROR: rasterio not installed. Run: pip install rasterio", file=sys.stderr)
        raise SystemExit(2)

    pop = np.zeros((len(lats), len(lons)), dtype=np.float64)
    # Cell EDGES, so np.searchsorted maps a pixel coord to a cell index.
    lat_edges = np.concatenate([[90.0], lats - GRID_DEG / 2])  # descending
    lon_edges = np.concatenate([lons - GRID_DEG / 2, [180.0]])  # ascending

    with rasterio.open(ghsl_path) as src:
        if src.crs is None or src.crs.to_epsg() != 4326:
            print(
                f"WARNING: GHS-POP CRS is {src.crs}, expected EPSG:4326 (WGS84).\n"
                "         Use the WGS84 lat/lon GHS-POP product, or reproject first.\n"
                "         Aggregation below assumes lat/lon pixels.",
                file=sys.stderr,
            )
        nodata = src.nodata
        # Process in horizontal stripes to keep memory bounded.
        for _, window in src.block_windows(1):
            block = src.read(1, window=window).astype(np.float64)
            if nodata is not None:
                block[block == nodata] = 0.0
            block[block < 0] = 0.0  # GHS-POP uses negative sentinels in some tiles
            if not block.any():
                continue
            rows = np.arange(window.row_off, window.row_off + window.height)
            cols = np.arange(window.col_off, window.col_off + window.width)
            # pixel centre coords -> world coords via the affine transform
            xs, _ = src.transform * (cols + 0.5, np.zeros_like(cols))
            _, ys = src.transform * (np.zeros_like(rows), rows + 0.5)
            # map each pixel to an ERA5 cell index
            lat_idx = np.searchsorted(-lat_edges, -ys) - 1  # negate: lat is descending
            lon_idx = np.searchsorted(lon_edges, xs) - 1
            lat_idx = np.clip(lat_idx, 0, len(lats) - 1)
            lon_idx = np.clip(lon_idx, 0, len(lons) - 1)
            li = lat_idx[:, None] + np.zeros_like(cols)[None, :]
            ci = np.zeros_like(rows)[:, None] + lon_idx[None, :]
            np.add.at(pop, (li.ravel(), ci.ravel()), block.ravel())

    print(f"  aggregated GHS-POP -> {pop.shape} grid, total pop = {pop.sum():,.0f}",
          file=sys.stderr)
    return pop


def load_cached_pop(ghsl_path: Path, lats: np.ndarray, lons: np.ndarray) -> np.ndarray | None:
    """Return the cached aggregated grid if it matches this raster, else None.

    The cache stores the source raster's name so a different GHS-POP file (a
    new epoch, a different resolution) does not silently reuse a stale grid.
    Grid shape is also checked in case GRID_DEG ever changes.
    """
    if not POP_CACHE.exists():
        return None
    try:
        cached = np.load(POP_CACHE, allow_pickle=False)
    except Exception as e:  # noqa: BLE001
        print(f"  cache {POP_CACHE.name} unreadable ({e}); recomputing", file=sys.stderr)
        return None
    if str(cached.get("source")) != ghsl_path.name:
        print(f"  cache is for {cached.get('source')!r}, not {ghsl_path.name!r}; "
              "recomputing", file=sys.stderr)
        return None
    pop = cached["pop"]
    if pop.shape != (len(lats), len(lons)):
        print(f"  cache grid {pop.shape} != expected {(len(lats), len(lons))}; "
              "recomputing", file=sys.stderr)
        return None
    print(f"  reusing cached population grid {POP_CACHE.name} "
          f"(source: {ghsl_path.name})", file=sys.stderr)
    return pop


def save_cached_pop(pop: np.ndarray, ghsl_path: Path) -> None:
    """Persist the aggregated grid so a re-run skips the slow raster pass."""
    POP_CACHE.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(POP_CACHE, pop=pop, source=ghsl_path.name)
    print(f"  cached population grid -> {POP_CACHE}", file=sys.stderr)


def select_top_cells(pop: np.ndarray, lats: np.ndarray, lons: np.ndarray, top_n: int):
    """Return the top-N populated cells as a list of dicts, ranked descending.

    Land filter: a 0.1deg cell with zero summed population is either ocean or
    genuinely empty -- either way ERA5-Land would give us nothing useful, so we
    drop it before ranking. We never select more cells than have population > 0.
    """
    flat = pop.ravel()
    populated = int((flat > 0).sum())
    if top_n > populated:
        print(f"  WARNING: requested top-{top_n} but only {populated:,} cells have "
              f"population > 0; selecting {populated:,}.", file=sys.stderr)
        top_n = populated

    # argpartition for the top-N, then sort just those N descending.
    top_flat = np.argpartition(flat, -top_n)[-top_n:]
    top_flat = top_flat[np.argsort(flat[top_flat])[::-1]]

    n_lon = len(lons)
    cells = []
    for rank, idx in enumerate(top_flat):
        r, c = divmod(int(idx), n_lon)
        lat, lon = float(lats[r]), float(lons[c])
        # 6.4deg tile = the zarr spatial chunk this cell lives in. Derived from
        # the STORE's coordinate indices (see store_tile) so tile_id maps 1:1
        # to a chunk -- our internal lon grid is -180..180, the store's 0..360.
        tile_id, tile_lat, tile_lon = store_tile(lat, lon)
        cells.append({
            "cell_id": rank,                       # 0 = most populous
            "lat": round(lat, 1),
            "lon": round(lon, 1),
            "population": int(round(flat[idx])),
            "tile_id": tile_id,
            "tile_lat": tile_lat,
            "tile_lon": tile_lon,
        })
    return cells


def select_region_cells(pop: np.ndarray, lats: np.ndarray, lons: np.ndarray,
                        bbox: tuple[float, float, float, float], floor: float):
    """Return EVERY cell inside a lat/lon bbox with population >= floor.

    Unlike select_top_cells (a global population ranking), this takes ALL
    populated cells in a region so a country of interest gets dense coverage
    regardless of where its towns fall in the global ranking. Cells carry
    cell_id=-1 here; main() reassigns ids after merging with the global set.

    bbox is (lat_lo, lat_hi, lon_lo, lon_hi) in degrees. floor drops near-empty
    desert/ocean-edge cells (population is a per-cell sum; a fractional value is
    GHSL noise, not a settlement).
    """
    lat_lo, lat_hi, lon_lo, lon_hi = bbox
    lat_sel = np.where((lats >= lat_lo) & (lats <= lat_hi))[0]
    lon_sel = np.where((lons >= lon_lo) & (lons <= lon_hi))[0]
    cells = []
    for r in lat_sel:
        for c in lon_sel:
            p = pop[r, c]
            if p < floor:
                continue
            lat, lon = float(lats[r]), float(lons[c])
            tile_id, tile_lat, tile_lon = store_tile(lat, lon)
            cells.append({
                "cell_id": -1,  # reassigned after merge
                "lat": round(lat, 1),
                "lon": round(lon, 1),
                "population": int(round(p)),
                "tile_id": tile_id,
                "tile_lat": tile_lat,
                "tile_lon": tile_lon,
            })
    print(f"  region {bbox} floor>={floor:g}: {len(cells):,} cells",
          file=sys.stderr)
    return cells


def merge_cells(global_cells: list[dict], region_cells: list[dict]):
    """Union the global top-N with region cells, dedup on (lat, lon).

    Ranking is by population descending so cell_id stays "0 = most populous"
    across the merged set. A cell present in both keeps its (identical) row once.
    """
    by_coord = {}
    for cell in global_cells + region_cells:
        by_coord[(cell["lat"], cell["lon"])] = cell
    merged = sorted(by_coord.values(), key=lambda c: c["population"], reverse=True)
    for rank, cell in enumerate(merged):
        cell["cell_id"] = rank
    return merged


def report_budget(cells: list[dict], n_years: int, n_vars: int) -> None:
    """Print the tile count and the resulting zarr request-quota estimate.

    request budget = n_tiles * n_years * time_chunks_per_year * n_vars
    where time_chunks_per_year = 4: the hourly store chunks 2880h = 120 days,
    and a calendar year (8760-8784 h) crosses 4 of those fixed chunk windows
    (boundaries are not aligned to Jan 1). Measured against the live store.
    This is THE number that decides whether the full pull fits inside the
    500,000/month EarthDataHub quota.
    """
    tiles = sorted({c["tile_id"] for c in cells})
    n_tiles = len(tiles)
    time_chunks = 4
    requests = n_tiles * n_years * time_chunks * n_vars

    # cities-per-tile distribution -- shows how much sharing we get
    from collections import Counter
    per_tile = Counter(c["tile_id"] for c in cells)
    counts = sorted(per_tile.values(), reverse=True)

    print("\n=== tile binning ===", file=sys.stderr)
    print(f"  {len(cells):,} cells -> {n_tiles:,} distinct 6.4deg tiles", file=sys.stderr)
    print(f"  cells per tile: max={counts[0]}, median={counts[len(counts) // 2]}, "
          f"min={counts[-1]}", file=sys.stderr)
    print("\n=== zarr request budget (full pull) ===", file=sys.stderr)
    print(f"  {n_tiles} tiles x {n_years} years x {time_chunks} time-chunks "
          f"x {n_vars} vars", file=sys.stderr)
    print(f"  = {requests:,} requests", file=sys.stderr)
    quota = 500_000
    if requests <= quota:
        print(f"  FITS the {quota:,}/month quota "
              f"({100 * requests / quota:.0f}% of it).", file=sys.stderr)
    else:
        months = -(-requests // quota)  # ceil
        print(f"  EXCEEDS the {quota:,}/month quota -- spread over {months} months, "
              f"or cut years/vars.", file=sys.stderr)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--top-n", type=int, default=10000,
                    help="number of most-populated ERA5-Land cells to select")
    ap.add_argument("--ghsl", type=Path, default=None,
                    help="path to a WGS84 GHS-POP GeoTIFF; omit to print the download URL")
    ap.add_argument("--n-years", type=int, default=76,
                    help="years in the planned pull, for the request-budget estimate")
    ap.add_argument("--n-vars", type=int, default=4,
                    help="stored zarr variables to fetch (t2m, tp, u10, v10 = 4)")
    ap.add_argument("--refresh", action="store_true",
                    help="recompute the population grid even if a cache exists")
    ap.add_argument("--region", action="append", default=None,
                    metavar="lat_lo,lat_hi,lon_lo,lon_hi[,floor]",
                    help="add EVERY populated cell in this bbox (>= floor people, "
                         "default 100) on top of the global top-N, for dense "
                         "coverage of a country of interest. Repeatable.")
    args = ap.parse_args()

    if args.ghsl is None:
        print("No --ghsl raster given. Download a WGS84 (EPSG:4326) GHS-POP GeoTIFF:")
        print(f"  {GHSL_INFO_URL}")
        print("Pick: GHS-POP, epoch 2020 or 2025, 30 arc-second (~1km), "
              "coordinate system WGS84 (EPSG:4326).")
        print("Then re-run:  python select_cells.py --ghsl <file.tif> "
              f"--top-n {args.top_n}")
        return 1

    if not args.ghsl.exists():
        print(f"ERROR: {args.ghsl} not found", file=sys.stderr)
        return 2

    lats, lons = era5_grid()
    print(f"ERA5-Land grid: {len(lats)} x {len(lons)} cells "
          f"({GRID_DEG}deg)", file=sys.stderr)

    pop = None if args.refresh else load_cached_pop(args.ghsl, lats, lons)
    if pop is None:
        pop = aggregate_to_grid(args.ghsl, lats, lons)
        save_cached_pop(pop, args.ghsl)
    cells = select_top_cells(pop, lats, lons, args.top_n)

    if args.region:
        region_cells = []
        for spec in args.region:
            parts = [float(x) for x in spec.split(",")]
            if len(parts) not in (4, 5):
                print(f"ERROR: --region needs 4 or 5 comma values, got {spec!r}",
                      file=sys.stderr)
                return 2
            bbox = tuple(parts[:4])
            floor = parts[4] if len(parts) == 5 else 100.0
            region_cells += select_region_cells(pop, lats, lons, bbox, floor)
        before = len(cells)
        cells = merge_cells(cells, region_cells)
        print(f"  merged: {before:,} global + {len(region_cells):,} region "
              f"-> {len(cells):,} unique cells", file=sys.stderr)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    import csv
    with OUT.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=list(cells[0].keys()))
        w.writeheader()
        w.writerows(cells)
    print(f"\nWrote {len(cells):,} cells to {OUT}", file=sys.stderr)

    report_budget(cells, args.n_years, args.n_vars)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
