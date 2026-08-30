"""The ONE place a cell's lat/lon becomes an R2 object key or a local filename.

Every tier object and every on-disk archive is named by the cell's snapped
0.1deg centre, formatted to one decimal:

  {tier}/{tier}_{lat}_{lon}.csv.gz      e.g. archive/archive_32.1_34.8.csv.gz

The readers are JavaScript — `snap(x).toFixed(1)` in worker/src/cellStore.js
(objectKey) and frontend/src/services/tieredData.ts — and JS has no negative
zero to keep: Math.round(-0.4) is -0 and (-0).toFixed(1) is "0.0". Python's
f"{x:.1f}" keeps the sign ("-0.0"), so the eight cells cells.csv stores with a
lon of -0.0 (Canary Wharf 51.5,-0.0; Tottenham; Beckenham; Enfield Town;
Castelló de la Plana; Gao; Sinkassé; Tulaku) were uploaded as
archive_51.5_-0.0.csv.gz — a key no browser ever asked for (the page fetches
archive_51.5_0.0.csv.gz and got a 404). Fixed 2026-08-28: the eight R2 objects
were renamed to their `_0.0` keys (originals kept under deprecated/) and every
Python formatter now routes through `coord_str`, which drops the sign. Keep it
that way — never build a key or filename with a bare `:.1f`.

Dependency-free on purpose: download_cells.py (which defers its boto3 import),
the snap-rewrite planning scripts and debias/ all import this.
"""
from __future__ import annotations


def coord_str(x: float) -> str:
    """One already-snapped coordinate as its 1-dp key string.

    Matches JS `toFixed(1)` on a snapped value: "-0.0" becomes "0.0"; every
    other value is untouched (-0.1 stays "-0.1", -78.4 stays "-78.4").
    """
    s = f"{x:.1f}"
    return "0.0" if s == "-0.0" else s


def cell_base(lat: float, lon: float) -> str:
    """`{lat}_{lon}` — the cell part of every key, e.g. "32.1_34.8"."""
    return f"{coord_str(lat)}_{coord_str(lon)}"


def tier_name(tier: str, lat: float, lon: float) -> str:
    """Filename of a tier object, e.g. "archive_32.1_34.8.csv.gz" — the key
    without its prefix, and what download_cells.py writes to disk."""
    return f"{tier}_{cell_base(lat, lon)}.csv.gz"


def tier_key(tier: str, lat: float, lon: float) -> str:
    """Full R2 object key, e.g. "archive/archive_32.1_34.8.csv.gz"."""
    return f"{tier}/{tier_name(tier, lat, lon)}"
