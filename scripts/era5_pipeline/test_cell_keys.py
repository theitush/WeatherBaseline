"""Tests for cell_keys — the one lat/lon -> R2 key / filename formatter.

The bug this guards against: cells.csv stores eight cells with lon `-0.0`
(Canary Wharf 51.5,-0.0 etc.). Python's f"{-0.0:.1f}" is "-0.0", so the
pipeline uploaded archive_51.5_-0.0.csv.gz while the JS readers
(worker/src/cellStore.js objectKey, frontend tieredData.ts) ask for
archive_51.5_0.0.csv.gz — a 404 for every visitor of those cells. Every
formatter now routes through cell_keys, and this file pins the convention:
no key or filename ever carries a "-0.0" axis.

Run (from scripts/era5_pipeline/):
  source .venv/bin/activate
  pytest test_cell_keys.py -v
"""
from __future__ import annotations

import csv
from pathlib import Path

import pytest

from cell_keys import cell_base, coord_str, tier_key, tier_name

CELLS_CSV = Path(__file__).resolve().parents[2] / "data" / "cells.csv"


# --------------------------------------------------------------------------- #
# coord_str: the sign fix itself.
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize(
    ("value", "expected"),
    [
        (-0.0, "0.0"),      # the bug: negative zero must not keep its sign
        (-0.04, "0.0"),     # rounds to zero -> no sign either
        (0.0, "0.0"),
        (0.04, "0.0"),
        (51.5, "51.5"),
        (-0.1, "-0.1"),     # a real negative tenth keeps its sign
        (-78.4, "-78.4"),   # ordinary negatives are untouched
        (180.0, "180.0"),
        (-13.6, "-13.6"),
    ],
)
def test_coord_str(value, expected):
    assert coord_str(value) == expected


def test_coord_str_matches_js_to_fixed_on_snapped_values():
    """The JS readers do `(Math.round(x*10)/10).toFixed(1)`; Math.round(-0.4)
    is -0 and (-0).toFixed(1) is "0.0". Emulate that and compare on a sweep
    of tenths either side of zero, plus the sub-tenth values that round to it."""
    def js_key(x: float) -> str:
        snapped = round(x * 10) / 10          # Python round() -> int: no -0
        return f"{snapped:.1f}"
    for tenths in range(-20, 21):
        x = tenths / 10
        assert coord_str(x) == js_key(x), x
    for x in (-0.04, -0.01, -0.0, 0.01, 0.04):
        assert coord_str(x) == js_key(x) == "0.0", x


# --------------------------------------------------------------------------- #
# The composed key/filename forms.
# --------------------------------------------------------------------------- #
def test_cell_base_and_keys_for_negative_zero_lon():
    assert cell_base(51.5, -0.0) == "51.5_0.0"
    assert tier_name("archive", 51.5, -0.0) == "archive_51.5_0.0.csv.gz"
    assert tier_key("archive", 51.5, -0.0) == "archive/archive_51.5_0.0.csv.gz"
    assert tier_key("recent", 51.5, -0.0) == "recent/recent_51.5_0.0.csv.gz"


def test_cell_base_ordinary_cells_unchanged():
    assert cell_base(32.1, 34.8) == "32.1_34.8"
    assert cell_base(-13.6, -172.6) == "-13.6_-172.6"
    assert tier_key("archive", 56.0, -3.2) == "archive/archive_56.0_-3.2.csv.gz"


def test_negative_zero_lat_axis_too():
    """Nothing special about lon: a -0.0 latitude is normalised the same way."""
    assert cell_base(-0.0, 18.3) == "0.0_18.3"
    assert cell_base(-0.0, -0.0) == "0.0_0.0"


# --------------------------------------------------------------------------- #
# The callers actually route through it.
# --------------------------------------------------------------------------- #
def test_download_cells_names_route_through_cell_keys():
    from download_cells import OverwriteLedger, archive_name, recent_name
    assert archive_name(51.5, -0.0) == "archive_51.5_0.0.csv.gz"
    assert recent_name(51.5, -0.0) == "recent_51.5_0.0.csv.gz"
    assert archive_name(-13.6, -172.6) == "archive_-13.6_-172.6.csv.gz"
    # the --overwrite resume ledger keys cells the same way, so a -0.0 cell is
    # one ledger entry regardless of which sign the caller passes
    assert OverwriteLedger._cell_key(51.5, -0.0) == OverwriteLedger._cell_key(51.5, 0.0)
    assert "-0.0" not in OverwriteLedger._span_key(51.5, -0.0, 1950, 1969)


def test_snap_rewrite_key_for_normalises_plan_bases():
    from apply_snap_rewrite import key_for
    from build_snap_rewrite_plan import base
    assert base(51.5, -0.0) == "51.5_0.0"
    # a stale/hand-edited plan base with the old sign still maps to the live key
    assert key_for("archive", "51.5_-0.0") == "archive/archive_51.5_0.0.csv.gz"
    assert key_for("debias-v9", "-13.6_-172.6") == "debias-v9/debias-v9_-13.6_-172.6.csv.gz"


def test_no_cells_csv_cell_formats_to_a_negative_zero_key():
    """The real cell list: cells.csv keeps -0.0 for eight cells (the file is
    deliberately untouched); every derived key must still read `_0.0`."""
    with CELLS_CSV.open(newline="") as fh:
        rows = list(csv.DictReader(fh))
    assert len(rows) > 8000
    neg_zero_rows = [r for r in rows if r["lon"] == "-0.0" or r["lat"] == "-0.0"]
    assert len(neg_zero_rows) == 8, [r["name"] for r in neg_zero_rows]
    for r in rows:
        key = tier_key("archive", float(r["lat"]), float(r["lon"]))
        assert "-0.0" not in key, (r["name"], key)
    assert {tier_key("archive", float(r["lat"]), float(r["lon"])) for r in neg_zero_rows} == {
        "archive/archive_51.5_0.0.csv.gz", "archive/archive_51.6_0.0.csv.gz",
        "archive/archive_5.7_0.0.csv.gz", "archive/archive_51.4_0.0.csv.gz",
        "archive/archive_40.0_0.0.csv.gz", "archive/archive_16.3_0.0.csv.gz",
        "archive/archive_11.1_0.0.csv.gz", "archive/archive_51.7_0.0.csv.gz",
    }
