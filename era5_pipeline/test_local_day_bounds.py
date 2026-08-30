"""Tests for the whole-local-day rule at a fetched span's edges.

Daily metrics are bucketed on each cell's solar-local day, so a span's edge
buckets hold only part of a day: Austin (-6 h) puts the six evening hours of the
day BEFORE the span in its first bucket, and a +3 h cell puts three hours of the
day AFTER it in its last. Written out, such a row merges by date over a complete
one — measured on the real archive, Austin's 2025-12-31 tmax moved 20.4 -> 15.9
that way. So each span is fetched with a one-day halo and short buckets are
dropped instead of written.

Offline: a synthetic in-memory store, no network.

Run:
  source .venv/bin/activate
  pytest test_local_day_bounds.py -v
"""
from __future__ import annotations

from datetime import date

import numpy as np
import pandas as pd
import pytest
import xarray as xr

from download_cells import process_span, whole_day_mask


def utc_axis(start: str, end: str):
    """Hourly UTC timestamps, inclusive of both ends."""
    return pd.date_range(start, end, freq="h").values


def buckets(time_values, off_h):
    """The daily bucket labels xarray's resample('1D') would produce."""
    shifted = pd.DatetimeIndex(time_values) + pd.Timedelta(hours=off_h)
    return pd.to_datetime(pd.Series(1, index=shifted).resample("1D").sum().index).date


def mask_for(time_values, off_h):
    b = buckets(time_values, off_h)
    return dict(zip(b, whole_day_mask(time_values, off_h, b)))


# --------------------------------------------------------------------------- #
# whole_day_mask: which buckets hold all 24 hours.
# --------------------------------------------------------------------------- #
def test_west_of_utc_drops_both_edge_days():
    """-6 h: the bucket before the span (6 h) and the last one (18 h) are partial."""
    m = mask_for(utc_axis("2026-01-01 00:00", "2026-07-31 23:00"), -6)
    assert not m[date(2025, 12, 31)]
    assert not m[date(2026, 7, 31)]
    assert m[date(2026, 1, 1)] and m[date(2026, 7, 30)]


def test_east_of_utc_drops_both_edge_days():
    """+3 h: the first local day is short 3 h, and a 3-hour day appears past the end."""
    m = mask_for(utc_axis("2026-01-01 00:00", "2026-07-31 23:00"), 3)
    assert not m[date(2026, 1, 1)]
    assert not m[date(2026, 8, 1)]
    assert m[date(2026, 1, 2)] and m[date(2026, 7, 31)]


def test_utc_cell_keeps_every_day():
    m = mask_for(utc_axis("2026-01-01 00:00", "2026-07-31 23:00"), 0)
    assert all(m.values())


def test_the_halo_completes_the_leading_day():
    """Fetching one day early is what makes the span's own first day whole."""
    m = mask_for(utc_axis("2025-12-31 00:00", "2026-07-31 23:00"), -6)
    assert m[date(2025, 12, 31)]          # now has all 24 h
    assert not m[date(2025, 12, 30)]      # the new edge, correctly dropped
    assert not m[date(2026, 7, 31)]       # store has no more hours — still partial


def test_leap_day_is_a_whole_day_like_any_other():
    m = mask_for(utc_axis("2024-02-27 00:00", "2024-03-02 23:00"), -5)
    assert m[date(2024, 2, 29)]


# --------------------------------------------------------------------------- #
# process_span over a synthetic store: the frames it returns hold whole days.
# --------------------------------------------------------------------------- #
# Tile 0_0 = lat indices 0..49, lon indices 0..99 of the store grid.
LATS = np.round(90.0 - np.arange(50) * 0.1, 1)      # 90.0 .. 85.1, descending
LONS = np.round(np.arange(100) * 0.1, 1)            # 0.0 .. 9.9
# Two cells in that window with DIFFERENT solar offsets: round(lon/15) h.
CELL_UTC = {"lat": 89.0, "lon": 1.0}                # offset  0
CELL_EAST = {"lat": 88.0, "lon": 9.0}               # offset +1


@pytest.fixture
def store():
    """Hourly store over 2025-12-30 .. 2026-01-10, with exactly known dailies.

    t2m rises by 1 K per hour from the axis start, so a local day's max/min are
    its last/first hour — any partial bucket shows up immediately as a wrong
    value, not merely a missing one. tp accumulates 1 mm/h and resets at 01:00
    UTC like the real store; wind is a constant 5 m/s (u=3, v=4).
    """
    time = pd.date_range("2025-12-30 00:00", "2026-01-10 23:00", freq="h")
    n_t, n_la, n_lo = len(time), len(LATS), len(LONS)
    ramp = np.arange(n_t, dtype="float32")[:, None, None]
    t2m = np.broadcast_to(273.15 + ramp, (n_t, n_la, n_lo)).copy()
    hour = time.hour.values
    tp = np.broadcast_to(
        (0.001 * (((hour - 1) % 24) + 1)).astype("float32")[:, None, None],
        (n_t, n_la, n_lo)).copy()
    dims = ("valid_time", "latitude", "longitude")
    coords = {"valid_time": time, "latitude": LATS, "longitude": LONS}
    return xr.Dataset(
        {
            "t2m": (dims, t2m),
            "tp": (dims, tp),
            "u10": (dims, np.full((n_t, n_la, n_lo), 3.0, dtype="float32")),
            "v10": (dims, np.full((n_t, n_la, n_lo), 4.0, dtype="float32")),
        },
        coords=coords,
    )


@pytest.fixture
def frames(store):
    return process_span(store, "0_0", [CELL_UTC, CELL_EAST], 2026, 2026,
                        var_workers=2)


def test_no_partial_day_survives_into_a_frame(frames, store):
    """Every written row must be a full 24-hour local day, both offsets."""
    fetched = pd.DatetimeIndex(
        store.valid_time.sel(valid_time=slice("2025-12-31", "2027-01-01")).values)
    for cell, off_h in ((CELL_UTC, 0), (CELL_EAST, 1)):
        frame = frames[(cell["lat"], cell["lon"])]
        m = mask_for(fetched.values, off_h)
        assert all(m[d] for d in frame["date"]), f"partial day written at {off_h:+d}h"


def test_the_halo_day_is_kept_when_it_is_complete(frames):
    """A -0 h cell's 2025-12-31 IS whole once the halo is fetched, so it lands —
    which is how a top-up repairs a boundary row an earlier run wrote partial."""
    frame = frames[(CELL_UTC["lat"], CELL_UTC["lon"])]
    assert frame["date"].iloc[0] == date(2025, 12, 31)


def test_the_shifted_cell_drops_the_day_its_offset_cannot_complete(frames):
    """+1 h: local 2025-12-31 needs 2025-12-30 23:00 UTC, outside the fetch."""
    frame = frames[(CELL_EAST["lat"], CELL_EAST["lon"])]
    assert frame["date"].iloc[0] == date(2026, 1, 1)


def test_no_day_past_the_end_of_the_fetch(frames):
    """The +1 h cell's 2026-01-11 bucket holds one hour — it must not be written."""
    for cell in (CELL_UTC, CELL_EAST):
        frame = frames[(cell["lat"], cell["lon"])]
        assert frame["date"].iloc[-1] == date(2026, 1, 10)


def test_daily_values_are_the_true_local_day_aggregates(frames, store):
    """t2m ramps 1 K/h, so a whole local day spans exactly 23 K and sums 24 mm."""
    for cell in (CELL_UTC, CELL_EAST):
        frame = frames[(cell["lat"], cell["lon"])]
        interior = frame.iloc[1:-1]
        assert np.allclose(interior["tmax_C"] - interior["tmin_C"], 23.0)
        assert np.allclose(interior["precip_mm"], 24.0)
        assert np.allclose(interior["wind_max_ms"], 5.0)


def test_every_calendar_day_between_the_ends_is_present(frames):
    for cell in (CELL_UTC, CELL_EAST):
        frame = frames[(cell["lat"], cell["lon"])]
        days = pd.to_datetime(frame["date"])
        assert list(days) == list(pd.date_range(days.iloc[0], days.iloc[-1], freq="D"))
