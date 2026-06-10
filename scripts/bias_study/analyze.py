"""Analyze the archive (ERA5-Land) vs IFS-HRES overlap dataset.

Tests the bias hypotheses (see PLAN). Reads scripts/bias_study/data/overlap.csv
(tidy long: cell_id,name,regime,lat,lon,date,var,baseline,hres) and prints a
per-variable, per-cell, per-regime report. Bias is defined HRES - baseline,
i.e. how the forecast tier reads relative to the climatology it's ranked
against. Positive => forecast reads high vs baseline.

  python analyze.py
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parent
CSV = HERE / "data" / "overlap.csv"
WET_MM = 1.0  # wet-day threshold for precip frequency
DRY_MM = 0.1  # IFS drizzle threshold


def load() -> pd.DataFrame:
    df = pd.read_csv(CSV)
    df["baseline"] = pd.to_numeric(df["baseline"], errors="coerce")
    df["hres"] = pd.to_numeric(df["hres"], errors="coerce")
    df = df.dropna(subset=["baseline", "hres"])
    df["diff"] = df["hres"] - df["baseline"]
    df["date"] = pd.to_datetime(df["date"])
    df["month"] = df["date"].dt.month
    return df


def fmt(x, n=2):
    return "  n/a" if pd.isna(x) else f"{x:+.{n}f}"


def per_cell_temp(df):
    """H1/H2/H3: temperature bias & spread by cell, for tmax/tmin."""
    print("\n" + "=" * 78)
    print("TEMPERATURE  (bias = HRES - ERA5-Land, degC)   H1 flat<0.5  H2 tmin noisier")
    print("=" * 78)
    for var in ("tmax", "tmin"):
        sub = df[df["var"] == var]
        print(f"\n  --- {var} ---")
        print(f"  {'cell':16s} {'regime':18s} {'bias':>7s} {'rmse':>7s} {'std':>7s}  n")
        for (name, regime), g in sub.groupby(["name", "regime"], sort=False):
            bias = g["diff"].mean()
            rmse = np.sqrt((g["diff"] ** 2).mean())
            std = g["diff"].std()
            print(f"  {name:16s} {regime:18s} {fmt(bias):>7s} {rmse:7.2f} {std:7.2f}  {len(g)}")


def regime_summary(df):
    """Systematic vs random split per var x regime."""
    print("\n" + "=" * 78)
    print("SYSTEMATIC vs RANDOM  by var x regime   (|bias|/rmse near 1 => correctable)")
    print("=" * 78)
    print(f"  {'var':9s} {'regime':18s} {'bias':>8s} {'rmse':>7s} {'|b|/rmse':>9s}  n")
    for var in ("tmax", "tmin", "precip", "wind_max"):
        sub = df[df["var"] == var]
        for regime, g in sub.groupby("regime", sort=False):
            bias = g["diff"].mean()
            rmse = np.sqrt((g["diff"] ** 2).mean())
            ratio = abs(bias) / rmse if rmse else np.nan
            print(f"  {var:9s} {regime:18s} {fmt(bias):>8s} {rmse:7.2f} "
                  f"{(f'{ratio:.2f}' if not pd.isna(ratio) else 'n/a'):>9s}  {len(g)}")


def wind_ratio(df):
    """H4/H5: HRES/baseline wind ratio per cell + tail behaviour."""
    print("\n" + "=" * 78)
    print("WIND  (H4: HRES/ERA5-Land ratio; ERA5-Land under-reps wind 20-30%)")
    print("       ratio>1 => HRES windier than baseline => percentiles inflated")
    print("=" * 78)
    sub = df[df["var"] == "wind_max"]
    print(f"  {'cell':16s} {'regime':18s} {'mean_b':>7s} {'mean_h':>7s} "
          f"{'ratio':>6s} {'p95_b':>6s} {'p95_h':>6s} {'tail_r':>6s}")
    for (name, regime), g in sub.groupby(["name", "regime"], sort=False):
        mb, mh = g["baseline"].mean(), g["hres"].mean()
        ratio = mh / mb if mb else np.nan
        p95b, p95h = g["baseline"].quantile(.95), g["hres"].quantile(.95)
        tail = p95h / p95b if p95b else np.nan
        print(f"  {name:16s} {regime:18s} {mb:7.2f} {mh:7.2f} {ratio:6.2f} "
              f"{p95b:6.2f} {p95h:6.2f} {tail:6.2f}")


def precip_freq(df):
    """H6/H7: wet/dry-day frequency sensitivity + extremes."""
    print("\n" + "=" * 78)
    print(f"PRECIP  (H6 wet-day freq; H7 extremes)   wet>={WET_MM}mm  dry<{DRY_MM}mm")
    print("=" * 78)
    sub = df[df["var"] == "precip"]
    print(f"  {'cell':16s} {'regime':18s} {'dry_b%':>6s} {'dry_h%':>6s} "
          f"{'wet_b%':>6s} {'wet_h%':>6s} {'p99_b':>6s} {'p99_h':>6s}")
    for (name, regime), g in sub.groupby(["name", "regime"], sort=False):
        db = (g["baseline"] < DRY_MM).mean() * 100
        dh = (g["hres"] < DRY_MM).mean() * 100
        wb = (g["baseline"] >= WET_MM).mean() * 100
        wh = (g["hres"] >= WET_MM).mean() * 100
        p99b, p99h = g["baseline"].quantile(.99), g["hres"].quantile(.99)
        print(f"  {name:16s} {regime:18s} {db:6.1f} {dh:6.1f} {wb:6.1f} {wh:6.1f} "
              f"{p99b:6.1f} {p99h:6.1f}")


def percentile_impact(df):
    """Phase 3: how many percentile points the bias moves a typical forecast.

    For each cell x var, take the HRES p90 value and ask what percentile it sits
    at within the BASELINE climatology vs within the HRES climatology. The gap is
    the cosmetic distortion users would see.
    """
    print("\n" + "=" * 78)
    print("PERCENTILE IMPACT  (HRES p90 ranked vs baseline climo - HRES climo)")
    print("   gap = pctile points the bias moves the headline number")
    print("=" * 78)
    print(f"  {'var':9s} {'regime':18s} {'avg_gap_pts':>11s}")
    for var in ("tmax", "tmin", "precip", "wind_max"):
        sub = df[df["var"] == var]
        for regime, gr in sub.groupby("regime", sort=False):
            rg = []
            for _, g in gr.groupby("name"):
                val = g["hres"].quantile(.90)
                rg.append((g["hres"] < val).mean() * 100 - (g["baseline"] < val).mean() * 100)
            print(f"  {var:9s} {regime:18s} {np.mean(rg):11.1f}")


def main():
    df = load()
    print(f"loaded {len(df)} paired obs across {df['name'].nunique()} cells, "
          f"{df['date'].min().date()}..{df['date'].max().date()}")
    per_cell_temp(df)
    regime_summary(df)
    wind_ratio(df)
    precip_freq(df)
    percentile_impact(df)


if __name__ == "__main__":
    main()
