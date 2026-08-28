"""Tests for the dew-point column (dewpt_mean_C) and the machinery that lets it
be backfilled into shipped archives without touching the other columns.

Offline: a synthetic in-memory zarr-shaped store stands in for EarthDataHub, a
fake uploader for R2. Nothing here touches the network.

Run:
  source .venv/bin/activate
  pytest test_dewpoint.py -v
"""
from __future__ import annotations

import gzip
import io
from datetime import date

import numpy as np
import pandas as pd
import pytest
import xarray as xr

import download_cells as dc
import r2_upload
from download_cells import (ARCHIVE_COLUMNS, archive_name, covered_dates,
                            merge_archive_frames, needs_merge_base, parse_vars,
                            process_span, write_archive)


# --------------------------------------------------------------------------- #
# A synthetic store with a known dew point.
# --------------------------------------------------------------------------- #
LATS = np.round(90.0 - np.arange(50) * 0.1, 1)
LONS = np.round(np.arange(100) * 0.1, 1)
CELL_UTC = {"lat": 89.0, "lon": 1.0}     # solar offset 0
CELL_EAST = {"lat": 88.0, "lon": 9.0}    # solar offset +1
DEW_GAP_K = 5.0                          # d2m = t2m - 5 K everywhere


@pytest.fixture
def store():
    """Hourly store over 2025-12-30 .. 2026-01-10.

    t2m rises 1 K/h from the axis start, d2m sits DEW_GAP_K below it, so a whole
    local day's mean dew point is (first hour + 11.5 - 5) K — a partial bucket
    shows up as a wrong value, not merely a missing one. tp accumulates 1 mm/h
    (reset 01:00 UTC), wind is a constant 5 m/s.
    """
    time = pd.date_range("2025-12-30 00:00", "2026-01-10 23:00", freq="h")
    n_t, n_la, n_lo = len(time), len(LATS), len(LONS)
    ramp = np.arange(n_t, dtype="float32")[:, None, None]
    t2m = np.broadcast_to(273.15 + ramp, (n_t, n_la, n_lo)).copy()
    d2m = t2m - np.float32(DEW_GAP_K)
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
            "d2m": (dims, d2m),
            "u10": (dims, np.full((n_t, n_la, n_lo), 3.0, dtype="float32")),
            "v10": (dims, np.full((n_t, n_la, n_lo), 4.0, dtype="float32")),
        },
        coords=coords,
    )


def expected_dew_mean(frame_dates, off_h):
    """Exact float64 daily-mean dew point (degC) for whole local days."""
    axis = pd.date_range("2025-12-30 00:00", "2026-01-10 23:00", freq="h")
    hourly = pd.Series(np.arange(len(axis), dtype="float64") + 273.15 - DEW_GAP_K,
                       index=axis + pd.Timedelta(hours=off_h))
    daily = hourly.resample("1D").mean() - 273.15
    return np.array([daily[pd.Timestamp(d)] for d in frame_dates])


# --------------------------------------------------------------------------- #
# process_span: the dew column, alone and alongside the others.
# --------------------------------------------------------------------------- #
def test_a_full_run_yields_all_six_columns_in_canonical_order(store):
    frames = process_span(store, "0_0", [CELL_UTC, CELL_EAST], 2026, 2026, 2)
    for cell in (CELL_UTC, CELL_EAST):
        assert list(frames[(cell["lat"], cell["lon"])].columns) == ARCHIVE_COLUMNS


def test_a_d2m_only_run_yields_only_date_and_dew(store):
    frames = process_span(store, "0_0", [CELL_UTC, CELL_EAST], 2026, 2026, 2,
                          zarr_vars=["d2m"])
    for cell in (CELL_UTC, CELL_EAST):
        assert list(frames[(cell["lat"], cell["lon"])].columns) == ["date", "dewpt_mean_C"]


def test_dew_mean_is_the_exact_local_day_mean_for_both_offsets(store):
    frames = process_span(store, "0_0", [CELL_UTC, CELL_EAST], 2026, 2026, 2)
    for cell, off_h in ((CELL_UTC, 0), (CELL_EAST, 1)):
        frame = frames[(cell["lat"], cell["lon"])]
        want = expected_dew_mean(frame["date"], off_h)
        assert np.allclose(frame["dewpt_mean_C"], np.round(want, 3), atol=5e-4)
        # ...and it sits exactly DEW_GAP_K below the mean air temperature, which
        # for a 1 K/h ramp is tmin + 11.5.
        assert np.allclose(frame["dewpt_mean_C"], frame["tmin_C"] + 11.5 - DEW_GAP_K,
                           atol=2e-3)


def test_d2m_only_values_match_the_full_run(store):
    full = process_span(store, "0_0", [CELL_UTC], 2026, 2026, 2)
    solo = process_span(store, "0_0", [CELL_UTC], 2026, 2026, 2, zarr_vars=["d2m"])
    key = (CELL_UTC["lat"], CELL_UTC["lon"])
    pd.testing.assert_frame_equal(full[key][["date", "dewpt_mean_C"]], solo[key])


def test_the_dew_mean_survives_a_float32_store_at_three_decimals(store):
    """A float32 running sum over 24 values of ~290 K is noisy at 1e-3; the
    reduction accumulates in float64 so the archive's 3 dp are exact."""
    frames = process_span(store, "0_0", [CELL_UTC], 2026, 2026, 2, zarr_vars=["d2m"])
    frame = frames[(CELL_UTC["lat"], CELL_UTC["lon"])]
    want = np.round(expected_dew_mean(frame["date"], 0), 3)
    assert np.array_equal(frame["dewpt_mean_C"].to_numpy(), want)


def test_no_partial_day_reaches_a_d2m_only_frame(store):
    frames = process_span(store, "0_0", [CELL_UTC, CELL_EAST], 2026, 2026, 2,
                          zarr_vars=["d2m"])
    utc = frames[(CELL_UTC["lat"], CELL_UTC["lon"])]
    east = frames[(CELL_EAST["lat"], CELL_EAST["lon"])]
    assert utc["date"].iloc[0] == date(2025, 12, 31)    # the halo day, whole at UTC
    assert east["date"].iloc[0] == date(2026, 1, 1)     # +1 h: the halo day is short 1 h
    assert east["date"].iloc[-1] == date(2026, 1, 10)   # the 1-hour tail is dropped


def test_a_var_set_deriving_no_column_is_rejected(store):
    with pytest.raises(ValueError):
        process_span(store, "0_0", [CELL_UTC], 2026, 2026, 2, zarr_vars=["u10"])


# --------------------------------------------------------------------------- #
# --vars parsing and the widened merge-base guard.
# --------------------------------------------------------------------------- #
def test_parse_vars_defaults_to_every_stored_var():
    assert parse_vars(None) == dc.ZARR_VARS


def test_parse_vars_keeps_store_order_and_rejects_unknowns():
    assert parse_vars("v10, d2m ,t2m") == ["t2m", "d2m", "v10"]
    with pytest.raises(ValueError):
        parse_vars("d2m,rh2m")
    with pytest.raises(ValueError):
        parse_vars(" , ")


def test_a_partial_variable_upload_requires_the_merge_base():
    assert needs_merge_base(True, 1950, ["d2m"])
    assert needs_merge_base(True, 2026, dc.ZARR_VARS)
    assert not needs_merge_base(True, 1950, dc.ZARR_VARS)
    assert not needs_merge_base(False, 1950, ["d2m"])


# --------------------------------------------------------------------------- #
# The per-column merge: a dew-only frame must not blank shipped columns.
# --------------------------------------------------------------------------- #
def air_frame(dates, precip=(0.0, 1.5, 12.25)):
    return pd.DataFrame({
        "date": [date.fromisoformat(d) for d in dates],
        "tmax_C": [20.0 + i for i in range(len(dates))],
        "tmin_C": [12.0 + i for i in range(len(dates))],
        "precip_mm": list(precip)[: len(dates)],
        "wind_max_ms": [3.0] * len(dates),
    })


def dew_frame(dates, start=15.0):
    return pd.DataFrame({
        "date": [date.fromisoformat(d) for d in dates],
        "dewpt_mean_C": [start + i for i in range(len(dates))],
    })


HISTORY = ["1950-01-01", "2026-05-30", "2026-05-31"]


def test_merge_adds_dew_and_keeps_every_shipped_value():
    base = air_frame(HISTORY)
    merged = merge_archive_frames(base, dew_frame(HISTORY[1:]))
    merged = dc.canonical_columns(merged.sort_values("date"))
    assert list(merged.columns) == ARCHIVE_COLUMNS
    for col in ("tmax_C", "tmin_C", "precip_mm", "wind_max_ms"):
        assert merged[col].tolist() == base[col].tolist()
    assert merged["dewpt_mean_C"].tolist()[1:] == [15.0, 16.0]
    assert np.isnan(merged["dewpt_mean_C"].iloc[0])   # off-span row: no dew yet


def test_merge_appends_dates_the_archive_never_had():
    merged = merge_archive_frames(air_frame(HISTORY), dew_frame(["2026-06-01"]))
    merged = merged.sort_values("date")
    assert merged["date"].tolist()[-1] == date(2026, 6, 1)
    assert np.isnan(merged["tmax_C"].iloc[-1])


def test_a_full_column_frame_still_wins_shared_dates():
    base = air_frame(HISTORY)
    new = air_frame(["2026-05-31", "2026-06-01"], precip=(9.0, 9.5))
    new["tmax_C"] = [40.0, 41.0]
    merged = merge_archive_frames(base, new).sort_values("date")
    row = merged[merged["date"] == date(2026, 5, 31)].iloc[0]
    assert row["tmax_C"] == 40.0 and row["precip_mm"] == 9.0
    assert merged[merged["date"] == date(1950, 1, 1)].iloc[0]["tmax_C"] == 20.0


def test_a_dew_frame_never_touches_precip_on_a_shared_date():
    base = air_frame(HISTORY)
    merged = merge_archive_frames(base, dew_frame(["2026-05-31"]))
    row = merged[merged["date"] == date(2026, 5, 31)].iloc[0]
    assert row["precip_mm"] == 12.25 and row["tmax_C"] == 22.0
    assert row["dewpt_mean_C"] == 15.0


# write_archive end to end, through the R2 merge base --------------------------
class FakeUploader:
    bucket = "fake"

    def __init__(self, responses):
        self.responses = list(responses)
        self.uploaded = []

    def get_bytes(self, key):
        item = self.responses.pop(0) if self.responses else None
        if isinstance(item, Exception):
            raise item
        return item

    def upload_file(self, path, key):
        self.uploaded.append((str(path), key))

    def delete_object(self, key):
        pass


def gz(df):
    buf = io.BytesIO()
    with gzip.GzipFile(fileobj=buf, mode="wb") as fh:
        fh.write(df.to_csv(index=False).encode())
    return buf.getvalue()


LAT, LON = 30.3, -97.7


@pytest.fixture(autouse=True)
def isolate(tmp_path, monkeypatch):
    monkeypatch.setattr(dc, "OUT_DIR", tmp_path / "archive")
    monkeypatch.setattr(dc, "_R2_SEEDED", set())
    monkeypatch.setattr(dc, "_SKIPPED_CELLS", [])
    monkeypatch.setattr(dc.time, "sleep", lambda _s: None)
    yield


def test_write_archive_backfills_dew_onto_the_r2_copy(tmp_path):
    up = FakeUploader([gz(air_frame(HISTORY))])
    write_archive(LAT, LON, dew_frame(HISTORY), uploader=up, require_base=True)
    out = pd.read_csv(tmp_path / "archive" / archive_name(LAT, LON))
    assert list(out.columns) == ARCHIVE_COLUMNS
    assert out["precip_mm"].tolist() == [0.0, 1.5, 12.25]
    assert out["dewpt_mean_C"].tolist() == [15.0, 16.0, 17.0]


def test_write_archive_skips_the_cell_when_the_base_is_unreadable(tmp_path):
    """A dew-only frame written fresh would be a 2-column archive — never."""
    up = FakeUploader([RuntimeError("500 Internal Error")] * dc._R2_BASE_RETRIES)
    with pytest.raises(dc.MergeBaseUnavailable):
        write_archive(LAT, LON, dew_frame(HISTORY), uploader=up, require_base=True)
    assert not (tmp_path / "archive" / archive_name(LAT, LON)).exists()


# --------------------------------------------------------------------------- #
# Column-aware resume, both halves.
# --------------------------------------------------------------------------- #
def write_local(tmp_path, df):
    path = tmp_path / "archive" / archive_name(LAT, LON)
    path.parent.mkdir(parents=True, exist_ok=True)
    df.to_csv(path, index=False, compression="gzip")
    return path


def test_local_coverage_ignores_an_archive_that_predates_the_column(tmp_path):
    write_local(tmp_path, air_frame(HISTORY))
    counts, newest = dc.local_coverage_for_tile([{"lat": LAT, "lon": LON}])
    assert (counts, newest) == ({}, None)


def test_local_coverage_counts_only_rows_carrying_the_column(tmp_path):
    df = merge_archive_frames(air_frame(HISTORY), dew_frame(HISTORY[1:]))
    write_local(tmp_path, df.sort_values("date"))
    counts, newest = dc.local_coverage_for_tile([{"lat": LAT, "lon": LON}])
    assert counts == {2026: 2}          # 1950 has no dew point yet
    assert newest == date(2026, 5, 31)


def test_r2_coverage_applies_the_same_rule(tmp_path):
    air_only = gz(air_frame(HISTORY))
    assert r2_upload.coverage_from_archive_bytes(air_only, "dewpt_mean_C") == ({}, None)
    # ...but with no column asked for, it is the plain row count it always was.
    counts, newest = r2_upload.coverage_from_archive_bytes(air_only, None)
    assert counts == {1950: 1, 2026: 2} and newest == date(2026, 5, 31)
    with_dew = gz(merge_archive_frames(air_frame(HISTORY), dew_frame(HISTORY[1:]))
                  .sort_values("date"))
    counts, newest = r2_upload.coverage_from_archive_bytes(with_dew, "dewpt_mean_C")
    assert counts == {2026: 2} and newest == date(2026, 5, 31)


def test_covered_dates_on_a_text_handle_rewinds_between_reads():
    text = merge_archive_frames(air_frame(HISTORY), dew_frame(HISTORY[:1])).to_csv(index=False)
    dates = covered_dates(io.StringIO(text), "dewpt_mean_C")
    assert dates.dt.date.tolist() == [date(1950, 1, 1)]


def test_missing_years_refetches_everything_for_an_air_only_tile(tmp_path):
    write_local(tmp_path, air_frame(HISTORY))
    todo = dc.missing_years([{"lat": LAT, "lon": LON}], [1950, 2025, 2026], True,
                            None, date(2026, 7, 31))
    assert todo == [1950, 2025, 2026]
