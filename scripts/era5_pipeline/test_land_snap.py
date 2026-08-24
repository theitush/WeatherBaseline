"""Tests for the nearest-land snap that fixes coastal all-NaN archives (F1).

ERA5-Land is land-only: ocean gridpoints are NaN. A coastal city's nearest
0.1deg gridpoint can land just offshore on a NaN ocean cell, so the old
`.sel(method="nearest")` extracted blank rows. `resolve_land_indices` snaps each
target to the nearest gridpoint that actually has land data.

Two layers:
  - UNIT (this file, default): synthetic mask, fast, offline. The algorithm.
  - INTEGRATION (`-m integration`, needs zarr auth + R2 creds): real ERA5-Land
    store. Asserts a known coastal cell (Edinburgh) recovers finite land data
    one cell away, and an inland cell is byte-for-byte the same as today's R2.

Run:
  source .venv/bin/activate
  pytest test_land_snap.py -v                  # unit only
  pytest test_land_snap.py -v -m integration   # +network (slow)
"""
from __future__ import annotations

import numpy as np
import pytest

from download_cells import resolve_land_indices


# --------------------------------------------------------------------------- #
# Unit: the snap algorithm against a synthetic land/ocean mask.
# --------------------------------------------------------------------------- #
# A 5x5 toy window. Coords mimic the real store: latitude DESCENDING, longitude
# ascending. We mark some cells ocean (NaN) and check the snap.
LATS = np.array([56.4, 56.3, 56.2, 56.1, 56.0])   # descending, like the store
LONS = np.array([356.6, 356.7, 356.8, 356.9, 357.0])


def _mask(ocean_cells):
    """5x5 finite(land) mask; cells in `ocean_cells` (as (i,j)) are False."""
    m = np.ones((5, 5), dtype=bool)
    for i, j in ocean_cells:
        m[i, j] = False
    return m


def test_inland_cell_picks_exact_nearest():
    """An all-land window: every target resolves to its geometric nearest,
    identical to the old behavior (the patch must be a no-op inland)."""
    mask = _mask([])
    # target sits exactly on grid cell (2,2) = (56.2, 356.8)
    idx = resolve_land_indices(mask, LATS, LONS, [(56.2, 356.8)])
    assert idx == [(2, 2)]


def test_nearest_gridpoint_between_cells_rounds_correctly():
    """Off-grid target snaps to the nearest cell center, not a fallback."""
    mask = _mask([])
    # 56.16 is closest to 56.2 (row 2); 356.74 closest to 356.7 (col 1)
    idx = resolve_land_indices(mask, LATS, LONS, [(56.16, 356.74)])
    assert idx == [(2, 1)]


def test_coastal_cell_falls_back_to_nearest_land():
    """Nearest gridpoint is ocean (NaN) -> snap to the closest land cell.

    Mirrors Edinburgh: nearest point offshore, real land one cell away.
    """
    # ocean at the target's nearest cell (2,2); land everywhere else
    mask = _mask([(2, 2)])
    idx = resolve_land_indices(mask, LATS, LONS, [(56.2, 356.8)])
    # the 4-neighborhood is all land and equidistant (1 cell); any is valid,
    # but it must NOT be the ocean cell and must be adjacent.
    (i, j) = idx[0]
    assert (i, j) != (2, 2)
    assert abs(i - 2) + abs(j - 2) == 1


def test_fallback_picks_geometrically_closest_land():
    """When the nearest cell is ocean, the chosen land cell is the closest one
    by grid distance, not just any land cell."""
    # ocean at (2,2) AND its whole row/col except one near land cell at (1,2)
    ocean = [(2, 2), (2, 1), (2, 3), (3, 2), (0, 0), (0, 4), (4, 0), (4, 4)]
    mask = _mask(ocean)
    idx = resolve_land_indices(mask, LATS, LONS, [(56.2, 356.8)])
    # (1,2) is the unique land cell at distance 1 from (2,2)
    assert idx == [(1, 2)]


def test_no_land_in_window_returns_none():
    """A target whose entire window is ocean resolves to None (logged, left
    empty) rather than fabricating a far-away value."""
    mask = _mask([(i, j) for i in range(5) for j in range(5)])
    idx = resolve_land_indices(mask, LATS, LONS, [(56.2, 356.8)])
    assert idx == [None]


def test_multiple_targets_resolved_independently():
    """A mix of inland, coastal, and impossible targets in one call."""
    mask = _mask([(2, 2)])  # one ocean cell
    targets = [
        (56.0, 357.0),   # inland corner -> (4,4)
        (56.2, 356.8),   # over the ocean cell -> falls back
    ]
    idx = resolve_land_indices(mask, LATS, LONS, targets)
    assert idx[0] == (4, 4)
    assert idx[1] is not None and idx[1] != (2, 2)


# --------------------------------------------------------------------------- #
# Integration: against the real ERA5-Land zarr store + current R2 archives.
# --------------------------------------------------------------------------- #
INTEG = pytest.mark.integration


@pytest.fixture(scope="module")
def store():
    from download_cells import open_store
    return open_store()


@INTEG
def test_edinburgh_recovers_finite_land_one_cell_away(store):
    """Edinburgh (56.0,-3.2) snaps offshore today (all-NaN R2 archive). With the
    land snap it must resolve to a finite land cell ~1 grid cell north, with a
    summer t2m in the FINDINGS-verified ~11-17 C range."""
    from download_cells import TILE_LAT_CELLS, TILE_LON_CELLS
    lat_n, lon_n, time_n = "latitude", "longitude", "valid_time"
    tlat, tlon = 56.0, 356.8  # -3.2 in 0..360

    r, c = 6, 35  # Edinburgh tile 6_35
    la = slice(r * TILE_LAT_CELLS, (r + 1) * TILE_LAT_CELLS)
    lo = slice(c * TILE_LON_CELLS, (c + 1) * TILE_LON_CELLS)
    sub = store["t2m"].sel({time_n: "2020-06-15T12:00:00"}).isel(
        {lat_n: la, lon_n: lo}).compute()
    lats, lons = sub[lat_n].values, sub[lon_n].values
    finite = np.isfinite(sub.values)

    # nearest gridpoint is ocean (this is the live bug)
    li = int(np.abs(lats - tlat).argmin())
    ci = int(np.abs(lons - tlon).argmin())
    assert not finite[li, ci], "expected Edinburgh's nearest gridpoint to be ocean"

    (i, j) = resolve_land_indices(finite, lats, lons, [(tlat, tlon)])[0]
    assert finite[i, j], "snap must land on a finite (land) cell"
    assert abs(i - li) + abs(j - ci) <= 2, "land should be within ~1-2 cells"
    t_c = float(sub.values[i, j]) - 273.15
    assert 8.0 < t_c < 20.0, f"recovered t2m {t_c:.1f}C out of expected range"


@INTEG
def test_inland_cell_snap_is_noop_vs_current(store):
    """An inland desert cell (Amman tile 11_3) whose nearest gridpoint is already
    land must resolve to that exact gridpoint -- the patch changes nothing where
    the old snap was already correct."""
    from download_cells import TILE_LAT_CELLS, TILE_LON_CELLS
    lat_n, lon_n, time_n = "latitude", "longitude", "valid_time"
    tlat, tlon = 31.9, 35.9  # Amman-ish, deep inland

    r, c = 11, 3
    la = slice(r * TILE_LAT_CELLS, (r + 1) * TILE_LAT_CELLS)
    lo = slice(c * TILE_LON_CELLS, (c + 1) * TILE_LON_CELLS)
    sub = store["t2m"].sel({time_n: "2020-06-15T12:00:00"}).isel(
        {lat_n: la, lon_n: lo}).compute()
    lats, lons = sub[lat_n].values, sub[lon_n].values
    finite = np.isfinite(sub.values)

    li = int(np.abs(lats - tlat).argmin())
    ci = int(np.abs(lons - tlon).argmin())
    assert finite[li, ci], "inland anchor's nearest gridpoint should be land"
    idx = resolve_land_indices(finite, lats, lons, [(tlat, tlon)])
    assert idx == [(li, ci)], "inland snap must equal the plain nearest index"


def _r2_year_frame(lat, lon, year):
    """One cell-year of the CURRENT R2 archive as a DataFrame (date as date)."""
    import gzip
    import io

    import pandas as pd

    from r2_upload import R2Uploader
    up = R2Uploader()
    key = f"archive/archive_{lat:.1f}_{lon:.1f}.csv.gz"
    body = up.client.get_object(Bucket=up.bucket, Key=key)["Body"].read()
    with gzip.open(io.BytesIO(body), "rt") as fh:
        df = pd.read_csv(fh)
    df["date"] = pd.to_datetime(df["date"]).dt.date
    return df[pd.to_datetime(df["date"]).dt.year == year].reset_index(drop=True)


@INTEG
def test_process_span_coastal_recovers_nonblank(store):
    """End-to-end: process_span on Edinburgh's tile now yields a fully-populated
    frame, where the live R2 archive for that cell is entirely blank."""
    import pandas as pd

    from download_cells import process_span
    cell = {"cell_id": 8250, "lat": 56.0, "lon": -3.2, "tile_id": "5_55"}
    frame = process_span(store, "5_55", [cell], 2020, 2020, var_workers=4)[(56.0, -3.2)]
    assert frame["tmax_C"].notna().all(), "patched coastal frame still has blanks"
    assert 0.0 < frame["tmax_C"].min() and frame["tmax_C"].max() < 35.0
    # the live R2 archive for this cell is the all-blank F1 symptom
    old = _r2_year_frame(56.0, -3.2, 2020)
    assert old["tmax_C"].notna().sum() == 0, "expected R2 Edinburgh to be blank"


@INTEG
def test_process_span_inland_byte_for_byte_matches_r2(store):
    """End-to-end regression: process_span on an inland cell (Amman tile 9_5)
    reproduces the CURRENT R2 archive to full precision — the patch must not
    perturb a single value where the old snap was already on land."""
    import pandas as pd

    from download_cells import process_span
    cell = {"cell_id": 0, "lat": 31.9, "lon": 35.9, "tile_id": "9_5"}
    new = process_span(store, "9_5", [cell], 2020, 2020, var_workers=4)[(31.9, 35.9)].copy()
    new["date"] = pd.to_datetime(new["date"]).dt.date
    old = _r2_year_frame(31.9, 35.9, 2020)
    m = new.merge(old, on="date", suffixes=("_new", "_r2"))
    assert len(m) > 360
    for col in ["tmax_C", "tmin_C", "precip_mm", "wind_max_ms"]:
        assert (m[f"{col}_new"] - m[f"{col}_r2"]).abs().max() < 1e-6, f"{col} drifted"
