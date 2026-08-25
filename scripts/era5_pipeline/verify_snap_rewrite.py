#!/usr/bin/env python3
"""Verify snap_rewrite_plan.csv against reality BEFORE any R2 object is touched.

Two independent proofs, mirroring the Christmas Island diagnosis
(project memory: the shipped "Flying Fish Cove" archive reproduced exactly from
the West Java gridpoint the snap had silently chosen):

1. Duplicate proof (--dups, no store access, ~50 MB from our own R2 domain):
   every cell the plan drops is dropped because its archive is a duplicate of
   another cell's. Prove it by downloading both archives and comparing every
   row on their common dates:
     - drop_dup_existing: mover's archive == the archive at its destination
       gridpoint (the static survivor's own key).
     - drop_dup_moved / drop_decision: all movers sharing a destination carry
       the same gridpoint's data — compare each against the group's first.
   A pair with different solar offsets can't be row-identical even at the same
   gridpoint (different local-day bucketing) — flagged as a hard failure since
   the plan expects none.

2. Store reproduction (--store, reads the DestinE store): for the deliberate
   over-cap rename-keeps (+ one St Kitts pile-up representative), re-derive
   tmax_C/tmin_C at the plan's destination gridpoint for sample windows with
   the cell's solar offset, exactly as download_cells.process_span buckets
   them, and compare against the shipped archive rows. Proves the destination
   coordinate really is where the shipped data comes from before we relabel
   cells.csv with it.

Run both before apply_snap_rewrite.py. Exit code 0 = every check passed.
"""
from __future__ import annotations

import argparse
import csv
import gzip
import io
import sys
import urllib.request
from collections import defaultdict
from pathlib import Path

import numpy as np
import pandas as pd

from download_cells import open_store, _compute_step

SCRIPT_DIR = Path(__file__).resolve().parent
PLAN_CSV = SCRIPT_DIR / "snap_rewrite_plan.csv"
DATA_BASE = "https://data.weatherbaseline.com"

# (label, start_date, n_days) — two seasons, contiguous days to share chunks.
SAMPLE_WINDOWS = [("winter", "2024-01-10", 5), ("summer", "2024-07-10", 5)]
TOLERANCE_C = 0.0051  # archive stores 3 decimals; allow one rounding ulp


def fetch_archive(base: str) -> pd.DataFrame:
    url = f"{DATA_BASE}/archive/archive_{base}.csv.gz"
    # The zone WAF 403s the default Python-urllib agent; identify ourselves.
    req = urllib.request.Request(url, headers={"User-Agent": "hhwi-snap-rewrite-verify/1.0"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        raw = resp.read()
    # Objects carry Content-Encoding: gzip; the edge transparently decompresses
    # for clients that don't advertise gzip — accept either form.
    if raw[:2] == b"\x1f\x8b":
        raw = gzip.decompress(raw)
    df = pd.read_csv(io.BytesIO(raw))
    return df.set_index("date")


def load_plan() -> list[dict]:
    with PLAN_CSV.open() as f:
        return list(csv.DictReader(f))


def compare_frames(name_a: str, a: pd.DataFrame, name_b: str, b: pd.DataFrame) -> list[str]:
    """Row-exact comparison on common dates; returns human-readable failures."""
    problems = []
    common = a.index.intersection(b.index)
    if len(common) < 20000:
        problems.append(f"only {len(common)} common dates between "
                        f"{name_a} ({len(a)}) and {name_b} ({len(b)})")
    for col in ("tmax_C", "tmin_C", "precip_mm", "wind_max_ms"):
        av, bv = a.loc[common, col].astype(float), b.loc[common, col].astype(float)
        both_nan = av.isna() & bv.isna()
        diff = (av - bv).abs()
        # Values are stored to 3 decimals; build batches differ in float
        # precision below that (the 1950s extension rows carry ~1e-7 noise).
        # Equal within half a quantum IS equal.
        bad = (~both_nan) & ~(diff <= 5.0e-4)
        if bad.any():
            worst = diff[bad].max()
            problems.append(f"{col}: {int(bad.sum())} row(s) differ "
                            f"(max |d|={worst:.4f}) e.g. {diff[bad].idxmax()}")
    return problems


def verify_dups(plan: list[dict]) -> int:
    failures = 0
    cache: dict[str, pd.DataFrame] = {}

    def archive(base):
        if base not in cache:
            cache[base] = fetch_archive(base)
        return cache[base]

    dup_existing = [r for r in plan if r["action"] == "drop_dup_existing"]
    print(f"[dups] {len(dup_existing)} drop_dup_existing pair(s)...")
    for i, r in enumerate(dup_existing, 1):
        if r["offset_old_h"] != r["offset_new_h"]:
            print(f"  FAIL {r['name']}: offset differs "
                  f"({r['offset_old_h']} vs {r['offset_new_h']}) — not mergeable")
            failures += 1
            continue
        try:
            probs = compare_frames(r["name"], archive(r["old_base"]),
                                   r["merge_into"], archive(r["new_base"]))
        except Exception as e:  # noqa: BLE001 — report, count, keep verifying
            probs = [f"fetch/compare error: {e}"]
        if probs:
            failures += 1
            print(f"  FAIL {r['name']}  vs  {r['merge_into']}")
            for p in probs:
                print(f"       {p}")
        if i % 25 == 0:
            print(f"  ... {i}/{len(dup_existing)}")

    # Movers (and decision drops) sharing a destination: same-source proof.
    groups: dict[str, list[dict]] = defaultdict(list)
    for r in plan:
        if r["action"] in ("drop_dup_moved", "drop_decision", "move", "move_repull"):
            groups[r["new_base"]].append(r)
    multi = {k: v for k, v in groups.items() if len(v) > 1}
    print(f"[dups] {len(multi)} shared-destination group(s)...")
    for dest, rows in multi.items():
        ref = rows[0]
        for other in rows[1:]:
            try:
                probs = compare_frames(ref["name"], archive(ref["old_base"]),
                                       other["name"], archive(other["old_base"]))
            except Exception as e:  # noqa: BLE001
                probs = [f"fetch/compare error: {e}"]
            if probs:
                failures += 1
                print(f"  FAIL {other['name']}  vs  {ref['name']}  (dest {dest})")
                for p in probs:
                    print(f"       {p}")
    print(f"[dups] done — {failures} failure(s)")
    return failures


def reproduce_window(ds, lat: float, lon: float, offset_h: int,
                     start: str, n_days: int) -> pd.DataFrame:
    """Daily tmax/tmin at one gridpoint, bucketed by the shifted local day —
    mirrors process_span: shift the UTC axis by offset hours, then group."""
    lat_name = "latitude" if "latitude" in ds.coords else "lat"
    lon_name = "longitude" if "longitude" in ds.coords else "lon"
    time_name = "valid_time" if "valid_time" in ds.coords else "time"
    lon_is_360 = float(ds[lon_name].max()) > 180.5
    slon = lon + 360.0 if (lon_is_360 and lon < 0) else lon

    # Pad the UTC fetch by a day each side so every local day is complete.
    t0 = np.datetime64(start) - np.timedelta64(1, "D")
    t1 = np.datetime64(start) + np.timedelta64(n_days + 1, "D")
    sub = ds["t2m"].sel({lat_name: lat, lon_name: slon}, method="nearest")
    sub = sub.sel({time_name: slice(t0, t1)})
    arr = _compute_step(f"t2m {lat:.1f},{lon:.1f} {start}", sub)

    times = pd.to_datetime(arr[time_name].values) + pd.Timedelta(hours=offset_h)
    frame = pd.DataFrame({"t": arr.values.astype(float)}, index=times)
    daily = frame.groupby(frame.index.date)["t"].agg(["max", "min", "count"])
    daily = daily[daily["count"] == 24]  # whole local days only
    out = pd.DataFrame({
        "tmax_C": np.round(daily["max"] - 273.15, 3),
        "tmin_C": np.round(daily["min"] - 273.15, 3),
    }, index=[d.isoformat() for d in daily.index])
    want = [(np.datetime64(start) + np.timedelta64(i, "D")).astype(str)
            for i in range(n_days)]
    return out.loc[[d for d in want if d in out.index]]


def verify_store(plan: list[dict]) -> int:
    over_cap = [r for r in plan if float(r["snap_km"]) > 25
                and r["action"] in ("move", "move_repull")]
    decision = [r for r in plan if r["action"] == "drop_decision"]
    targets = over_cap + decision[:1]  # one St Kitts representative suffices
    print(f"[store] reproducing {len(targets)} cell(s) x "
          f"{sum(n for _, _, n in SAMPLE_WINDOWS)} sample day(s) "
          f"from the DestinE store...")
    ds = open_store()
    failures = 0
    for r in targets:
        # The shipped archive was bucketed with the OLD coordinate's offset.
        offset = int(r["offset_old_h"])
        lat, lon = float(r["new_lat"]), float(r["new_lon"])
        shipped = fetch_archive(r["old_base"])
        worst = 0.0
        rows = 0
        try:
            for _, start, n_days in SAMPLE_WINDOWS:
                redo = reproduce_window(ds, lat, lon, offset, start, n_days)
                for d in redo.index:
                    if d not in shipped.index:
                        continue
                    rows += 1
                    for col in ("tmax_C", "tmin_C"):
                        delta = abs(float(shipped.loc[d, col]) - float(redo.loc[d, col]))
                        worst = max(worst, delta)
        except Exception as e:  # noqa: BLE001
            print(f"  FAIL {r['name']}: {e}")
            failures += 1
            continue
        ok = rows >= 6 and worst <= TOLERANCE_C
        print(f"  {'ok  ' if ok else 'FAIL'} {r['name']}: {rows} day(s), "
              f"max |d|={worst:.4f} C at dest ({lat},{lon})")
        if not ok:
            failures += 1
    print(f"[store] done — {failures} failure(s)")
    return failures


def verify_movers(plan: list[dict]) -> int:
    """Classify every mover: is its shipped archive really the destination
    gridpoint's data?

    The audit replays TODAY'S v3 tiling, but 1950-2025 history was built under
    the old 64x64 tiling whose snap could choose different land (proved by the
    St Croix / Charlotte Amalie vs Fajardo diffs). A mover whose archive does
    not reproduce from its destination must be re-pulled there (--overwrite),
    never key-copied. Writes mover_provenance.csv: name, ok, rows, worst_dC.
    """
    movers = [r for r in plan if r["action"] in ("move", "move_repull")]
    windows = [("old", "1990-05-10", 5)] + SAMPLE_WINDOWS
    print(f"[movers] reproducing {len(movers)} mover(s) x "
          f"{sum(n for _, _, n in windows)} sample day(s) from the store...")
    ds = open_store()
    failures = 0
    out_rows = []
    mismatches = 0
    for i, r in enumerate(movers, 1):
        offset = int(r["offset_old_h"])
        lat, lon = float(r["new_lat"]), float(r["new_lon"])
        worst = 0.0
        rows = 0
        try:
            shipped = fetch_archive(r["old_base"])
            for _, start, n_days in windows:
                redo = reproduce_window(ds, lat, lon, offset, start, n_days)
                for d in redo.index:
                    if d not in shipped.index:
                        continue
                    rows += 1
                    for col in ("tmax_C", "tmin_C"):
                        delta = abs(float(shipped.loc[d, col]) - float(redo.loc[d, col]))
                        worst = max(worst, delta)
        except Exception as e:  # noqa: BLE001
            print(f"  FAIL {r['name']}: {e}")
            failures += 1
            continue
        ok = rows >= 10 and worst <= TOLERANCE_C
        if not ok:
            mismatches += 1
            print(f"  MISMATCH {r['name']}: {rows} day(s), max |d|={worst:.4f} C "
                  f"— archive is NOT dest ({lat},{lon}) data; needs re-pull")
        out_rows.append({"name": r["name"], "old_base": r["old_base"],
                         "new_base": r["new_base"], "ok": ok,
                         "days": rows, "worst_dC": round(worst, 4)})
        if i % 20 == 0:
            print(f"  ... {i}/{len(movers)}")
    out_path = SCRIPT_DIR / "mover_provenance.csv"
    with out_path.open("w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["name", "old_base", "new_base",
                                          "ok", "days", "worst_dC"])
        w.writeheader()
        w.writerows(out_rows)
    print(f"[movers] done — {mismatches} mismatch(es), {failures} error(s); "
          f"wrote {out_path}")
    return failures


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dups", action="store_true")
    parser.add_argument("--store", action="store_true")
    parser.add_argument("--movers", action="store_true")
    args = parser.parse_args()
    if not (args.dups or args.store or args.movers):
        args.dups = args.store = True

    plan = load_plan()
    failures = 0
    if args.dups:
        failures += verify_dups(plan)
    if args.store:
        failures += verify_store(plan)
    if args.movers:
        failures += verify_movers(plan)
    print(f"\n{'ALL CHECKS PASSED' if failures == 0 else f'{failures} FAILURE(S)'}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
