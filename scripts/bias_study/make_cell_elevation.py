"""Derive each cell's elevation from ERA5-Land itself -> data/cell_elevation.csv

THE source of the `elevation` feature in the bias study (ml_debias.ipynb and the
training scripts). Elevation must come from ERA5-Land's own orography — NOT the
Open-Meteo elevation API (that's a 90 m DEM; different surface than the model
the archive temperatures live on).

INPUT — data/geo.grib: the ERA5-Land static **geopotential** field (`z`,
m^2/s^2, global 0.1 deg, 1801x3600). Downloaded once from CDS (Copernicus
Climate Data Store, dataset "reanalysis-era5-land", variable "geopotential",
any single time — the field is time-invariant). Elevation = z / 9.80665.

Cells are already snapped to the same 0.1 deg grid (cells.csv is canonical),
so the nearest-gridpoint lookup is exact, not an interpolation.

OUTPUT — data/cell_elevation.csv with columns `cell_id,elevation` (metres,
1 decimal), one row per cells.csv row. Any existing file is backed up to
cell_elevation.csv.bak first, and a value comparison against it is printed.

HISTORY — the original cell_elevation.csv was produced by an undocumented
one-off from the same grib, keyed by cell_id. The coastal-snap + sub-district
dedupe rework of cells.csv (2026-06/07) reassigned ids, silently scrambling
~2/3 of the joins (median error 209 m). This script exists so the file can
always be regenerated from the current cells.csv. Rerun it after ANY change
to cells.csv.

Deps — cfgrib + eccodes (self-contained wheels) in the pipeline venv:
  ../era5_pipeline/.venv/bin/pip install cfgrib eccodes

Usage (from scripts/bias_study/):
  ../era5_pipeline/.venv/bin/python make_cell_elevation.py
"""
from __future__ import annotations

import shutil
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import xarray as xr

HERE = Path(__file__).resolve().parent
CELLS_CSV = HERE.parent.parent / "data" / "cells.csv"
GEO_GRIB = HERE / "data" / "geo.grib"
OUT_CSV = HERE / "data" / "cell_elevation.csv"
GRAVITY = 9.80665  # m/s^2, WMO standard


def main() -> int:
    if not GEO_GRIB.exists():
        sys.exit(f"missing {GEO_GRIB} — download ERA5-Land geopotential from CDS "
                 "(dataset reanalysis-era5-land, variable geopotential, any time)")

    geopotential = xr.open_dataset(GEO_GRIB, engine="cfgrib")["z"]
    cells = pd.read_csv(CELLS_CSV)

    # grib longitudes are 0..359.9; cells.csv is -180..180
    lons = xr.DataArray(cells.lon.to_numpy() % 360, dims="cell")
    lats = xr.DataArray(cells.lat.to_numpy(), dims="cell")
    elevation = geopotential.sel(latitude=lats, longitude=lons,
                                 method="nearest").to_numpy() / GRAVITY

    n_nan = int(np.isnan(elevation).sum())
    if n_nan:
        bad = cells.loc[np.isnan(elevation), "name"].head(10).tolist()
        sys.exit(f"{n_nan} cells hit a NaN gridpoint (not land-snapped?): {bad}")

    if OUT_CSV.exists():
        old = pd.read_csv(OUT_CSV)
        merged = cells.assign(new=elevation).merge(old, on="cell_id", how="left")
        diff = (merged.elevation - merged.new).abs()
        print(f"replacing old file: {len(old)} rows, {int(merged.elevation.isna().sum())} "
              f"current cells had no row; of the rest {int((diff > 100).sum())} "
              f"({100 * (diff > 100).mean():.1f}%) were off by >100 m")
        shutil.copy2(OUT_CSV, OUT_CSV.with_suffix(".csv.bak"))

    out = pd.DataFrame({"cell_id": cells.cell_id,
                        "elevation": np.round(elevation, 1)})
    out.to_csv(OUT_CSV, index=False)
    print(f"wrote {OUT_CSV.name}: {len(out)} cells  "
          f"(min {out.elevation.min():.1f} m, max {out.elevation.max():.1f} m)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
