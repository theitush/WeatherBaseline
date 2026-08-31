"""Train the quantile debias models (M2/M3 x base/cross) on the FULL cell grid.

The production training run of ml_debias.ipynb's pipeline, as a script for the
gcloud box (e2-highcpu-16 — 16 vCPUs but only 16 GB RAM, hence the dtype
shrink + per-var column slicing below; the float64/object full-grid frame gets
the process OOM-killed). Per variable (tmax, tmin, precip, wind) it fits a
CatBoost MultiQuantile model — quantiles 1/5/10/25/50/75/90/95/99 in ONE fit,
so q50 is the point correction and the outer pairs give 90%/98% bands:

  M2_base   geo + seasonal + fc_version                      (no cell identity)
  M3_base   M2_base + `key` as a native categorical           <- the shipped one
  M2_cross  M2_base + the other three hres_* values (regime features)
  M3_cross  M3_base + the other three hres_* values

--variants defaults to M3_base ALONE: 4 fits, not 16. The bakeoff is settled and
cannot be reopened by a retrain. M3_cross scores better on every var, but it
consumes the other three hres_* values, so its surface is 5-D — make_debias_tables
can only bake a variant whose sole per-day inputs are (forecast value, date), i.e.
a 2-D surface. M3_base is the best BAKEABLE variant, not the best variant.

Unweighted (extremity weights would bias the quantiles — the
notebook's own Sec.12 rationale). Split, features, trace clamp and fc_version
replicate ml_debias.ipynb exactly (monthly blocks, every 5th to test, 3-day
embargo, seed 0); early stopping uses a validation carve-out from TRAIN blocks
(every 4th non-test block) so test is never touched during fitting.

PIPELINE (each step gates the next; any missing data raises):
  1. preflight   — cells.csv, cell_elevation.csv coverage (make_cell_elevation.py
                   if stale), every cell's hres_*.csv.gz + ledger meta present
  2. era5 slice  — pull_archive_slice.py --all-cells --overwrite (refresh the
                   archive-overlap slices from R2, the source of truth; needs
                   r2.env in the environment)
  3. verify      — both sides loaded for every cell; window starts 2024-03-01;
                   per-cell end within tolerance of the cohort max (stale = error)
  4. train       — 16 MultiQuantile fits, thread_count=-1; each model is saved
                   the moment it finishes and skipped on rerun (resume-safe)
  5. evaluate    — q50 tail table vs raw, 90%/98% band coverage+width, quantile
                   crossing rate, feature importances, per-cell CSV for gating

OUTPUT (models/):
  {variant}_{var}_{TAG}.cbm      TAG = qn{cells}_s{seed}_q{n_quantiles}
  spec_{TAG}.json                knobs, features, cell list, best iterations
  eval_{TAG}.csv                 headline table (also printed)
  per_cell_{TAG}.csv             per cell x var x variant: MAE/p95 raw vs q50

Run on the box (tmux!):
  cd debias && source ../era5_pipeline/.venv/bin/activate
  python train_quantile_debias.py                # full run, resumes if rerun
Debug flags: --limit N (random cell sample) --iters N --retrain --skip-pull
  --allow-partial (missing/stale cells -> warn+drop instead of raise; NOT for
  the real run)
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import date
from pathlib import Path

import numpy as np
import pandas as pd
from catboost import CatBoostRegressor, Pool

HERE = Path(__file__).resolve().parent
# Repo root — walked up to the dir holding data/cells.csv rather than
# counting levels off HERE: debias/ sits at the repo root since the
# 2026-08-30 promotion, but the VM's rsync'd mirror is still the old
# scripts/<dir>/ layout, and both have to keep working.
REPO = next(p for p in HERE.parents if (p / "data" / "cells.csv").is_file())
CELLS_CSV = REPO / "data" / "cells.csv"
ARC_DIR = HERE / "data" / "archive-overlap"
HRES_DIR = HERE / "data" / "hres-forecast-ifs-hres"
LEDGER = HRES_DIR / ".hres_progress.json"
ELEV_CSV = HERE / "data" / "cell_elevation.csv"
MODELS = HERE / "models"

VARS = [
    {"name": "tmax", "col": "tmax_C", "unit": "degC", "nonneg": False},
    {"name": "tmin", "col": "tmin_C", "unit": "degC", "nonneg": False},
    {"name": "precip", "col": "precip_mm", "unit": "mm", "nonneg": True},
    {"name": "wind", "col": "wind_max_ms", "unit": "m/s", "nonneg": True},
    # Daily-MEAN 2 m dew point (2026-08): archive side from ERA5-Land d2m, HRES
    # side from Open-Meteo's daily dew_point_2m_mean under models=ecmwf_ifs.
    {"name": "dewpt", "col": "dewpt_mean_C", "unit": "degC", "nonneg": False},
]
VALUE_COLS = [v["col"] for v in VARS]

# --- knobs (split params replicate ml_debias.ipynb exactly) ---
SEED = 0
# 9 levels. The .25/.75 pair is TRAINED (it used to be interpolated client-side by
# a probit split-normal rule in frontend/src/services/ci.ts); the shoulders carry
# the most probability mass, so they get real heads rather than a parametric guess.
QUANTILES = [0.01, 0.05, 0.10, 0.25, 0.50, 0.75, 0.90, 0.95, 0.99]
MAX_ITERS = 1500          # cap; early stopping picks the real count
OD_WAIT = 75              # stop after this many iterations without val improvement
HOLDOUT_EVERY = 5         # every Nth month-block -> test
VAL_EVERY = 4             # every Nth REMAINING block -> validation (early stopping)
EMBARGO_DAYS = 3          # train rows this close to a test/val block are dropped
HRES_ARCHIVE_START = "2024-03-01"
HRES_FLOOR_BUFFER_DAYS = 1  # extra day back off the archive floor, timezone safety
PRECIP_TRACE_MM = 1       # match prod: <1mm counts as 0 (frontend tieredData.ts)

# Open-Meteo `ecmwf_ifs` IFS cycle changeovers (categorical feature), as in the
# notebook Sec.3. Serving note: a cycle unseen in training falls back to the prior.
FC_CHANGES = [(pd.Timestamp("2026-05-12"), "50r1"),
              (pd.Timestamp("2024-11-12"), "49r1")]
FC_BASE = "48r1"

GEO_FEATURES = ["elevation", "hres_elevation", "elev_diff_m", "dist_to_hres_km",
                "lat", "lon"]
SEASONAL_FEATURES = ["cos_doy", "sin_doy"]
VARIANTS = {  # name -> (with_cell, with_cross)
    "M2_base": (False, False), "M3_base": (True, False),
    "M2_cross": (False, True), "M3_cross": (True, True),
}

BANDS = {"90": (QUANTILES.index(0.05), QUANTILES.index(0.95)),
         "98": (QUANTILES.index(0.01), QUANTILES.index(0.99))}
Q50 = QUANTILES.index(0.50)


class DataError(SystemExit):
    """Missing/stale data. Message says exactly what and how to fix it."""


def fail(problem: str, offenders: list[str], fix: str) -> None:
    shown = ", ".join(offenders[:15]) + (" ..." if len(offenders) > 15 else "")
    raise DataError(f"\nDATA ERROR: {problem} ({len(offenders)} cells)\n"
                    f"  cells: {shown}\n  fix:   {fix}")


def log(msg: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def snap(coord: float) -> float:
    return round(coord * 10) / 10


def key_of(lat: float, lon: float) -> str:
    return f"{snap(lat):.1f}_{snap(lon):.1f}"


def haversine_km(lat1, lon1, lat2, lon2):
    earth_radius_km = 6371.0088
    lat1_rad, lat2_rad = np.radians(lat1), np.radians(lat2)
    dlat, dlon = np.radians(lat2 - lat1), np.radians(lon2 - lon1)
    chord = (np.sin(dlat / 2) ** 2
             + np.cos(lat1_rad) * np.cos(lat2_rad) * np.sin(dlon / 2) ** 2)
    return 2 * earth_radius_km * np.arcsin(np.sqrt(chord))


# ---------------------------------------------------------------- 1. preflight
def preflight(limit: int | None, allow_partial: bool) -> pd.DataFrame:
    """Verify misc files + every cell's forecast data; return static features."""
    for path in (CELLS_CSV, ELEV_CSV, HRES_DIR, LEDGER):
        if not path.exists():
            raise DataError(f"\nDATA ERROR: missing {path}\n"
                            "  this box must mirror the repo data layout "
                            "(cell_elevation.csv: run make_cell_elevation.py)")

    cells = pd.read_csv(CELLS_CSV)
    cells["key"] = [key_of(lat, lon) for lat, lon in zip(cells.lat, cells.lon)]
    log(f"cells.csv: {len(cells)} cells")

    # elevation must cover every current cell (stale pre-dedupe files don't)
    elevation = pd.read_csv(ELEV_CSV)
    cells = cells.merge(elevation, on="cell_id", how="left")
    no_elev = cells[cells.elevation.isna()]
    if len(no_elev):
        fail("cell_elevation.csv is stale/incomplete", no_elev.name.tolist(),
             "../era5_pipeline/.venv/bin/python make_cell_elevation.py "
             "(pip install cfgrib eccodes first if needed)")

    # every cell needs an HRES file AND ledger meta (hres_lat/lon/elevation)
    hres_keys = {p.name.removeprefix("hres_").removesuffix(".csv.gz")
                 for p in HRES_DIR.glob("hres_*.csv.gz")}
    ledger = json.load(open(LEDGER))["done"]
    for problem, missing_mask, fix in (
        ("HRES forecast file missing", ~cells.key.isin(hres_keys),
         "python pull_hres_all.py"),
        ("HRES ledger meta missing (need hres_lat/lon/elevation)",
         pd.Series([k not in ledger or "hres_lat" not in ledger[k]
                    for k in cells.key], index=cells.index),
         "python pull_hres_all.py --overwrite --only NAME  (per listed cell; "
         "bare --overwrite would re-pull ALL cells)"),
    ):
        if missing_mask.any():
            if allow_partial:
                log(f"WARN --allow-partial: {problem}: "
                    f"{int(missing_mask.sum())} cells dropped")
                cells = cells[~missing_mask]
            else:
                fail(problem, cells.loc[missing_mask, "name"].tolist(), fix)

    if limit and limit < len(cells):
        cells = cells.sample(limit, random_state=SEED)  # random: first-N clusters
        log(f"--limit: random sample of {len(cells)} cells")

    meta = pd.DataFrame([{"key": k, "hres_lat": ledger[k]["hres_lat"],
                          "hres_lon": ledger[k]["hres_lon"],
                          "hres_elevation": ledger[k]["hres_elevation"]}
                         for k in cells.key])
    static = cells[["key", "lat", "lon", "elevation"]].merge(meta, on="key")
    static["dist_to_hres_km"] = haversine_km(static.lat, static.lon,
                                             static.hres_lat, static.hres_lon)
    static["elev_diff_m"] = static.elevation - static.hres_elevation
    log(f"preflight OK: {len(static)} cells, elevation + HRES + ledger complete")
    return static


# ------------------------------------------------- 2. era5 slice + 3. load/verify
def refresh_archive_slices() -> None:
    """pull_archive_slice.py --all-cells --overwrite: rebuild the overlap slices
    from R2, which is the source of truth for the archive (a box's on-disk
    era5-land mirror can silently predate top-ups and cell-coord renames).
    --overwrite because resume would keep stale slices. Needs r2.env in the
    environment; a pure R2 read job, well inside the free tier."""
    cmd = [sys.executable, str(HERE / "pull_archive_slice.py"),
           "--all-cells", "--overwrite"]
    log("refreshing archive-overlap slices: " + " ".join(cmd[1:]))
    if subprocess.run(cmd, cwd=HERE).returncode != 0:
        raise DataError("pull_archive_slice.py failed — see its output above")


def load_and_verify(static: pd.DataFrame, allow_partial: bool) -> pd.DataFrame:
    """Load both sides for every cell, verify coverage, inner-join per day."""
    def load_cell(key):
        arc_path = ARC_DIR / f"archive_{key}.csv.gz"
        if not arc_path.exists():
            return key, None, None
        archive = pd.read_csv(arc_path).rename(
            columns={c: f"era5_{c}" for c in VALUE_COLS})
        forecast = pd.read_csv(HRES_DIR / f"hres_{key}.csv.gz").rename(
            columns={c: f"hres_{c}" for c in VALUE_COLS})
        ranges = (archive.date.min(), archive.date.max(),
                  forecast.date.min(), forecast.date.max())
        joined = archive.merge(forecast, on="date", how="inner")
        joined["key"] = key
        return key, joined, ranges

    t0 = time.time()
    with ThreadPoolExecutor(max_workers=16) as pool:
        loaded = list(pool.map(load_cell, static.key.tolist()))
    log(f"loaded {len(loaded)} cells in {time.time() - t0:.0f}s")

    no_archive = [k for k, frame, _ in loaded if frame is None]
    if no_archive:
        if allow_partial:
            log(f"WARN --allow-partial: dropping {len(no_archive)} cells with no "
                "archive slice")
        else:
            fail("no archive-overlap slice (era5 side missing/stale on disk)",
                 no_archive,
                 "python pull_archive_slice.py --all-cells --overwrite")

    ranges = pd.DataFrame(
        [(k, *r) for k, frame, r in loaded if frame is not None],
        columns=["key", "arc_start", "arc_end", "hres_start", "hres_end"])
    # HRES only needs to reach as far as the era5-land archive actually does —
    # that's the real join limit, and it's ground truth (not a guess about the
    # archive's monthly update cadence) since arc_end was just rebuilt above.
    hres_floor = (pd.to_datetime(ranges.arc_end).min()
                  - pd.Timedelta(days=HRES_FLOOR_BUFFER_DAYS))
    checks = [
        ("archive slice starts late", ranges.arc_start != HRES_ARCHIVE_START,
         "re-run pull_archive_slice.py --overwrite for these cells"),
        ("HRES starts late", ranges.hres_start != HRES_ARCHIVE_START,
         "python pull_hres_all.py --overwrite"),
        ("archive slice stale (trails cohort)",
         pd.to_datetime(ranges.arc_end)
         < pd.to_datetime(ranges.arc_end).max() - pd.Timedelta(days=14),
         "top up the R2 archive, then pull_archive_slice.py --all-cells "
         "--overwrite"),
        (f"HRES stale (before archive floor {hres_floor.date()})",
         pd.to_datetime(ranges.hres_end) < hres_floor,
         "python pull_hres_all.py --overwrite"),
    ]
    for problem, mask, fix in checks:
        if mask.any():
            if allow_partial:
                log(f"WARN --allow-partial: {problem}: {int(mask.sum())} cells kept")
            else:
                fail(problem, ranges.loc[mask, "key"].tolist(), fix)

    df = pd.concat([f for _, f, _ in loaded if f is not None], ignore_index=True)
    df = df.merge(static, on="key", how="left")
    df["date"] = pd.to_datetime(df["date"])
    for source in ("era5", "hres"):  # blanks read as strings -> NaN
        for col in VALUE_COLS:
            df[f"{source}_{col}"] = pd.to_numeric(df[f"{source}_{col}"],
                                                  errors="coerce")
        precip = f"{source}_precip_mm"
        df.loc[df[precip] < PRECIP_TRACE_MM, precip] = 0.0
    log(f"joined frame: {df.shape[0]:,} rows x {df.shape[1]} cols, "
        f"{df.key.nunique()} cells, {df.date.min().date()}..{df.date.max().date()}")
    return df


# ------------------------------------------------------- 4. features + split
# Seasonal phase stays on RAW day-of-year. Quantizing it to the 53 weekly bake
# anchors was tried and rejected 2026-07-28 (A/B, 300 cells, seed 0): the theory
# was that ~1500 trees split cos/sin at arbitrary thresholds, so the fitted doy
# response is a staircase finer than the bake grid can carry — i.e. it aliases.
# Real, but it costs nothing measurable. Test MAE identical to 4 dp (mixed signs);
# END-TO-END SERVED error — |era5 - (hres + interpolated dmid)| through the actual
# baked table — identical to ±0.002 on values of 0.5-0.9. The sub-week structure
# is tree noise, so aliasing it is harmless. Don't re-add without a metric that
# shows a gain; self_check CANNOT adjudicate it (it scores a step-function model
# against a linear interpolant, so it penalises quantization by construction).
def add_features(df: pd.DataFrame) -> pd.DataFrame:
    day_of_year = df["date"].dt.dayofyear
    df["cos_doy"] = np.cos(2 * np.pi * day_of_year / 365.25)
    df["sin_doy"] = np.sin(2 * np.pi * day_of_year / 365.25)
    df["season"] = (df["date"].dt.month % 12 // 3).map(
        {0: "DJF", 1: "MAM", 2: "JJA", 3: "SON"})
    # sorted() is LOAD-BEARING: FC_CHANGES is declared newest-first, and each mask
    # is `date >= change_date`, so applying them in declaration order lets the
    # OLDER cycle's mask overwrite the newer one's rows — 50r1 never survived, and
    # make_debias_tables then baked against a category the model had never seen.
    # Oldest-first means the latest applicable cycle wins, as intended.
    fc_version = pd.Series(FC_BASE, index=df.index)
    for change_date, cycle in sorted(FC_CHANGES):
        fc_version = fc_version.mask(df["date"] >= change_date, cycle)
    df["fc_version"] = fc_version

    for var in VARS:
        name, col = var["name"], var["col"]
        pct_rank = df.groupby(["key", "season"])[f"era5_{col}"].rank(
            method="average", pct=True)
        df[f"dec_{name}"] = np.where(pct_rank <= 0.1, "low",
                                     np.where(pct_rank >= 0.9, "high", "mid"))
        df[f"dec1_{name}"] = np.where(pct_rank <= 0.01, "p01",
                                      np.where(pct_rank >= 0.99, "p99", "mid"))
        # fdec ranks the FORECAST: known at prediction time, so conformal
        # calibration may condition on it; dec/dec1 rank the truth and are
        # evaluation-only labels.
        fc_rank = df.groupby(["key", "season"])[f"hres_{col}"].rank(
            method="average", pct=True)
        df[f"fdec_{name}"] = np.where(fc_rank <= 0.1, "low",
                                      np.where(fc_rank >= 0.9, "high", "mid"))
        df[f"bias_{name}"] = df[f"era5_{col}"] - df[f"hres_{col}"]
    log("features: seasonal phase, fc_version "
        f"({df.fc_version.value_counts().to_dict()}), deciles (truth dec/dec1 "
        "+ forecast fdec), bias targets")
    return df


def split(df: pd.DataFrame) -> pd.DataFrame:
    """Notebook split (monthly blocks, every 5th -> test, 3d embargo) plus a
    validation carve-out from the REMAINING blocks for early stopping."""
    origin = df["date"].min().normalize()
    block_id = ((df["date"].dt.year - origin.year) * 12
                + (df["date"].dt.month - origin.month))
    all_blocks = np.unique(block_id)
    test_blocks = set(all_blocks[::HOLDOUT_EVERY])
    remaining = [b for b in all_blocks if b not in test_blocks]
    val_blocks = set(remaining[::VAL_EVERY])
    df["role"] = np.where(block_id.isin(test_blocks), "test",
                          np.where(block_id.isin(val_blocks), "val", "train"))

    held_dates = pd.DatetimeIndex(
        np.unique(df.loc[df.role != "train", "date"]))
    embargoed = held_dates
    for offset in range(1, EMBARGO_DAYS + 1):
        embargoed = embargoed.union(held_dates + pd.Timedelta(days=offset)) \
                             .union(held_dates - pd.Timedelta(days=offset))
    df.loc[(df.role == "train") & df.date.isin(embargoed), "role"] = "embargo"

    counts = df.role.value_counts()
    log(f"split: {len(all_blocks)} blocks -> test {len(test_blocks)}, "
        f"val {len(val_blocks)} | rows " +
        ", ".join(f"{r}={counts.get(r, 0):,}" for r in
                  ("train", "val", "test", "embargo")))
    season_table = df.pivot_table(index="season", columns="role",
                                  values="date", aggfunc="count")
    print(season_table[["train", "val", "test"]].to_string(), flush=True)
    return df


def shrink(df: pd.DataFrame) -> pd.DataFrame:
    """float64 -> float32, strings -> category. Runs AFTER features + split so
    no ranking/split math changes (CatBoost quantizes to float32 anyway). The
    full-grid frame is several GB of float64 + per-row str objects without
    this, and the per-var slices in main() copy from it."""
    for col in df.columns:
        if df[col].dtype == np.float64:
            df[col] = df[col].astype(np.float32)
        elif (isinstance(df[col].dtype, pd.StringDtype)  # pandas>=3 str cols
              or df[col].dtype == object):               # pandas 2 str cols
            df[col] = df[col].astype("category")
    log(f"shrunk frame to {df.memory_usage(deep=True).sum() / 2**30:.2f} GiB "
        "(float32 + categoricals)")
    return df


# ------------------------------------------------------------ 5. train + eval
def hres_col(var_name: str) -> str:
    return f"hres_{next(v['col'] for v in VARS if v['name'] == var_name)}"


def feature_cols(var_name: str, with_cell: bool, with_cross: bool) -> list[str]:
    cols = [hres_col(var_name)]
    if with_cross:
        cols += [hres_col(v["name"]) for v in VARS if v["name"] != var_name]
    cols += GEO_FEATURES + SEASONAL_FEATURES + ["fc_version"]
    if with_cell:
        cols.append("key")
    return cols


def fit_or_load(var_name, variant, train, val, cols, cat_features, iters,
                retrain, tag):
    model_path = MODELS / f"{variant}_{var_name}_{tag}.cbm"
    model = CatBoostRegressor()
    if model_path.exists() and not retrain:
        model.load_model(str(model_path))
        log(f"  {variant}_{var_name}: loaded cache ({model_path.name})")
        return model, None
    loss = "MultiQuantile:alpha=" + ",".join(str(q) for q in QUANTILES)
    model = CatBoostRegressor(
        iterations=iters, depth=6, learning_rate=0.05, loss_function=loss,
        l2_leaf_reg=3.0, random_seed=SEED, thread_count=-1,
        od_type="Iter", od_wait=OD_WAIT, use_best_model=True, verbose=200)
    t0 = time.time()
    model.fit(Pool(train[cols], train[f"bias_{var_name}"],
                   cat_features=cat_features),
              eval_set=Pool(val[cols], val[f"bias_{var_name}"],
                            cat_features=cat_features))
    minutes = (time.time() - t0) / 60
    model.save_model(str(model_path))
    log(f"  {variant}_{var_name}: trained {model.tree_count_} trees "
        f"in {minutes:.1f} min -> {model_path.name}")
    return model, model.tree_count_


def evaluate_variant(test, var, preds):
    """Headline metrics for one var x variant on the test rows."""
    name, nonneg = var["name"], var["nonneg"]
    truth = test[f"era5_{next(v['col'] for v in VARS if v['name'] == name)}"] \
        .to_numpy()
    hres = test[hres_col(name)].to_numpy()
    bias = test[f"bias_{name}"].to_numpy()

    corrected = hres + preds[:, Q50]
    if nonneg:
        corrected = np.clip(corrected, 0, None)
    residual = truth - corrected
    raw_err = truth - hres
    decile = test[f"dec_{name}"].to_numpy()
    tail1 = test[f"dec1_{name}"].to_numpy()

    def tail_mae(err, labels, low, high):
        return 0.5 * (np.abs(err[labels == low]).mean()
                      + np.abs(err[labels == high]).mean())

    row = {
        "raw_tailMAE": tail_mae(raw_err, decile, "low", "high"),
        "tailMAE": tail_mae(residual, decile, "low", "high"),
        "raw_tail1MAE": tail_mae(raw_err, tail1, "p01", "p99"),
        "tail1MAE": tail_mae(residual, tail1, "p01", "p99"),
        "raw_MAE": np.abs(raw_err).mean(), "MAE": np.abs(residual).mean(),
        "crossing_%": 100 * (np.diff(preds, axis=1) < 0).any(axis=1).mean(),
    }
    for band, (lo, hi) in BANDS.items():
        inside = (bias >= preds[:, lo]) & (bias <= preds[:, hi])
        row[f"cov{band}"] = inside.mean()
        row[f"width{band}"] = (preds[:, hi] - preds[:, lo]).mean()
        row[f"cov{band}_tails"] = inside[decile != "mid"].mean()
    for metric in ("tail", "tail1", ""):
        m = f"{metric}MAE" if metric else "MAE"
        row[f"{metric or 'all'}_impr_%"] = 100 * (1 - row[m] / row[f"raw_{m}"])
    return row, residual


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--limit", type=int, help="random sample of N cells (debug)")
    ap.add_argument("--iters", type=int, default=MAX_ITERS,
                    help=f"iteration cap (default {MAX_ITERS}; early stopping "
                         "picks the effective count)")
    ap.add_argument("--retrain", action="store_true",
                    help="refit even if a cached .cbm exists")
    ap.add_argument("--skip-pull", action="store_true",
                    help="skip the archive-slice refresh (reuse current slices)")
    ap.add_argument("--allow-partial", action="store_true",
                    help="DEBUG: warn+drop missing/stale cells instead of raising")
    ap.add_argument("--variants", nargs="+", default=["M3_base"],
                    choices=sorted(VARIANTS),
                    help="variants to fit (default: M3_base, the only one shipped). "
                         "The full 4-variant bakeoff is settled and cannot change: "
                         "M3_cross scores better but takes the other three hres_* "
                         "values, so its surface is 5-D and cannot be baked into a "
                         "static per-cell table. Pass all four only to redo the "
                         "comparison for its own sake.")
    args = ap.parse_args()
    variants = {name: VARIANTS[name] for name in args.variants}

    static = preflight(args.limit, args.allow_partial)
    if not args.skip_pull:
        refresh_archive_slices()
    df = load_and_verify(static, args.allow_partial)
    df = add_features(df)
    df = split(df)
    df = shrink(df)

    MODELS.mkdir(exist_ok=True)
    # The quantile count is IN the tag. fit_or_load reuses any cached .cbm whose
    # path exists, so without this a rerun would silently load the shipped 7-level
    # fits while the code indexes a 9-level layout — Q50 would read the 0.90 head
    # and produce plausible garbage rather than crashing.
    tag = f"qn{df.key.nunique()}_s{SEED}_q{len(QUANTILES)}"
    spec = {"tag": tag, "seed": SEED, "quantiles": QUANTILES,
            "iters_cap": args.iters, "od_wait": OD_WAIT,
            "holdout_every": HOLDOUT_EVERY, "val_every": VAL_EVERY,
            "embargo_days": EMBARGO_DAYS,
            "date_min": str(df.date.min().date()),
            "date_max": str(df.date.max().date()),
            "n_rows": int(len(df)), "n_cells": int(df.key.nunique()),
            "variants": {v: feature_cols("tmax", *variants[v])
                         for v in variants},
            "trained_at": time.strftime("%Y-%m-%d %H:%M:%S"),
            "tree_counts": {}, "cells": sorted(df.key.unique())}

    headline_rows, per_cell_rows = [], []
    for var in VARS:
        name = var["name"]
        # slice to this var's columns BEFORE copying: four per-var copies of
        # the full frame is most of the peak RSS
        var_cols = (feature_cols(name, with_cell=True, with_cross=True)
                    + [f"era5_{var['col']}", f"bias_{name}", f"dec_{name}",
                       f"dec1_{name}", "role"])
        var_df = df.loc[df[f"bias_{name}"].notna(), var_cols]
        train = var_df[var_df.role == "train"]
        val = var_df[var_df.role == "val"]
        test = var_df[var_df.role == "test"]
        log(f"== {name}: train {len(train):,} / val {len(val):,} / "
            f"test {len(test):,} rows ==")
        for variant, (with_cell, with_cross) in variants.items():
            cols = feature_cols(name, with_cell, with_cross)
            cat_features = ["fc_version"] + (["key"] if with_cell else [])
            model, trees = fit_or_load(name, variant, train, val, cols,
                                       cat_features, args.iters, args.retrain,
                                       tag)
            if trees:
                spec["tree_counts"][f"{variant}_{name}"] = trees
            preds = model.predict(test[cols])
            row, residual = evaluate_variant(test, var, preds)
            headline_rows.append({"var": name, "variant": variant, **row})

            importance = dict(zip(cols, model.get_feature_importance()))
            top = sorted(importance.items(), key=lambda kv: -kv[1])[:5]
            log("    importance: " + ", ".join(f"{k}={v:.0f}" for k, v in top))

            cell_frame = pd.DataFrame({
                "key": test.key.to_numpy(),
                "abs_raw": np.abs(test[f"bias_{name}"].to_numpy()),
                "abs_q50": np.abs(residual)})
            grouped = cell_frame.groupby("key").agg(
                n=("abs_raw", "size"), mae_raw=("abs_raw", "mean"),
                mae_q50=("abs_q50", "mean"),
                p95_raw=("abs_raw", lambda s: s.quantile(0.95)),
                p95_q50=("abs_q50", lambda s: s.quantile(0.95))).reset_index()
            grouped.insert(0, "variant", variant)
            grouped.insert(0, "var", name)
            per_cell_rows.append(grouped)

    headline = pd.DataFrame(headline_rows)
    order = ["var", "variant", "raw_tailMAE", "tailMAE", "tail_impr_%",
             "raw_tail1MAE", "tail1MAE", "tail1_impr_%", "raw_MAE", "MAE",
             "all_impr_%", "cov90", "width90", "cov90_tails", "cov98",
             "width98", "cov98_tails", "crossing_%"]
    print("\n== headline: q50 as point correction; coverage on the bias "
          "target ==", flush=True)
    print(headline[order].round(3).to_string(index=False), flush=True)

    headline.to_csv(MODELS / f"eval_{tag}.csv", index=False)
    pd.concat(per_cell_rows).to_csv(MODELS / f"per_cell_{tag}.csv", index=False)
    with open(MODELS / f"spec_{tag}.json", "w") as f:
        json.dump(spec, f, indent=1)
    log(f"done. models + eval_{tag}.csv + per_cell_{tag}.csv + spec -> {MODELS}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
