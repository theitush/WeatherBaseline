"""Bake the M3_base bias fits into static per-cell interpolation tables for R2.

Step 1 of plans/im-thinking-to-ship-kind-bee.md. The site serves raw HRES-derived
values for forecast/recent days while the archive (and all percentile math) is on
the ERA5-Land scale; the `M3_base_{var}_{TAG}.cbm` fits correct that mismatch. The
fits are ~1 GB total — never Worker-runnable — so instead of a live Python service
we EVALUATE the existing fits on a small per-cell grid and let the client bilinear-
interpolate. No retraining.

Key insight: M3_base's only per-day inputs are the forecast value + the date
(cos_doy/sin_doy, fc_version); every other feature is static per cell. So per
cell x var the model collapses to a smooth 2D surface  delta = f(hres_value, doy).
We sample that surface on a (doy x hres) grid and write it out.

Per cell x var, for each grid point we predict all 9 quantiles, sort ascending
(precip crosses), and ship ALL NINE *bias deltas* — a 9-point predictive CDF the
client can interpolate for exceedance claims ("p(top 10%) once ERA5-Land settles").
The client adds a delta to the raw forecast value: corrected = clip(value + d, 0..).
Each non-median head carries a per-level ONE-SIDED conformal shift baked in
(cqr_per_level_validity.ipynb is the validity study: every calibrated tail lands
within 0.35pp of nominal). The shifts are SIGNED — a negative one pulls in an
over-shooting head — and independent, so a row can re-cross; it is re-isotonized
around the PINNED median. CQR never touches q50, so the point value is CQR-free.
Column names keep the legacy trio dlo/dmid/dhi (= q05/q50/q95), and d25/d75 are
TRAINED heads as of the q9 fits — they replace the probit split-normal rule the
client used to interpolate them with (PROBIT_Q25_Q75_W in ci.ts).

GATING (locked 2026-07-04; gated cells given empirical bands 2026-07-05): read
models/per_cell_{TAG}.csv. Cell x vars where the M3_base POINT correction hurts —
mean|err| UP by more than --gate-threshold (default 0.1) vs raw — do NOT get the
model surface. They instead get an EMPIRICAL band from the raw residual
bias = ERA5-Land - HRES with the MEDIAN head pinned to 0 (the point stays raw; the
gated model q50 is discarded): NON-precip a constant per-cell band; PRECIP a
forecast-CONDITIONAL band (residual quantiles binned by forecast magnitude and
POOLED across the gated precip cells) because a constant precip band collapses on
heavy-rain days (~27% coverage at the top-1% forecast) while the conditional one
holds ~90% across regimes. Same schema as the model tables, so the client applies
every cell identically with NO gating logic. Validity: cqr_per_level_validity.ipynb.

OUTPUT (one gzip per cell, --out-dir, mirrors the R2 `debias/` key) — now EVERY
cell gets a file (model surface where trusted, empirical band where gated):
  debias_{lat}_{lon}.csv.gz
    columns: var,doy,hres,d01,dlo,d10,d25,dmid,d75,d90,dhi,d99
  (deltas, 2 dp)  ~4 x 53 x 13 ~= 2.7K rows ~= 20-40 KB/cell.

REGEN at the next IFS cutover: fc_version is pinned to the current cycle below.

Runs in scripts/era5_pipeline/.venv (needs the full archive-overlap + hres-forecast
data the fits were trained on). Reuses train_quantile_debias.py for the data
pipeline (preflight/load_and_verify/add_features/split/shrink) and feature layout.

  cd scripts/bias_study && ../era5_pipeline/.venv/bin/python make_debias_tables.py
Debug: --limit N (random cells) --allow-partial (warn+drop stale) --self-check-cells N
"""
from __future__ import annotations

import argparse
import gzip
import time
from pathlib import Path

import numpy as np
import pandas as pd

import train_quantile_debias as tqd
from catboost import CatBoostRegressor

HERE = Path(__file__).resolve().parent

# Grid resolution (plan Step 1.1). doy: 53 weekly anchors, 1..365, client wraps
# circularly. hres: 13 anchors spanning each cell's TRAINING hres range — linear
# for tmax/tmin/wind; quantile-spaced for precip since the mass sits at 0.
DOY_ANCHORS = np.arange(1, 366, 7)                 # 1, 8, ..., 365  (53 points)
N_HRES_ANCHORS = 15
# precip mass sits at 0, so anchor densely near 0 (quantiles) but also union a
# few linear points so no single hres gap (e.g. p99.5->max) is wide enough to
# make bilinear interp blow up on a heavy-rain day.
PRECIP_ANCHOR_QUANTILES = [0.0, 0.5, 0.75, 0.9, 0.95, 0.98, 0.99, 0.995, 1.0]
N_PRECIP_LINEAR = 6

QUANTILE_LEVELS = tqd.QUANTILES   # [.01, .05, .10, .25, .50, .75, .90, .95, .99]
Q50 = QUANTILE_LEVELS.index(0.50)      # index into the per-row SORTED 9-vector
# per-cell csv columns for the sorted heads, in level order. dlo/dmid/dhi keep
# their legacy names (= q05/q50/q95) so an already-deployed ci.ts keeps parsing a
# new table unchanged — it reads columns BY NAME and ignores ones it doesn't know,
# so a 9-column table is readable by the 7-column client. That makes the R2
# promotion order-independent: tables may ship before or after the frontend.
LEVEL_COLUMNS = ["d01", "dlo", "d10", "d25", "dmid", "d75", "d90", "dhi", "d99"]

# gated tables are doy-constant (the empirical fits do not condition on doy); two
# straddling anchors are enough for the client's circular interp — with the delta
# equal across both, the doy weight cancels exactly, so any pair works.
GATED_DOY_ANCHORS = np.array([1, 183], dtype=np.int16)


def log(msg: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def current_fc_version() -> str:
    """The IFS cycle in force today — what forecast/recent days will carry."""
    version = tqd.FC_BASE
    for change_date, cycle in sorted(tqd.FC_CHANGES):   # ascending; latest wins
        if pd.Timestamp.today() >= change_date:
            version = cycle
    return version


def per_level_shift(residuals: np.ndarray, level: float) -> float:
    """One-sided split-conformal shift for one quantile head: the finite-sample
    empirical level-quantile of y - q_hat. Upper heads round the rank UP
    (coverage >= level), lower heads round DOWN (tail below stays <= level).
    Shifts are SIGNED — never clip at zero."""
    ordered = np.sort(residuals)
    n = len(ordered)
    if level > 0.5:
        rank = min(int(np.ceil((n + 1) * level)), n)
    else:
        rank = max(int(np.floor((n + 1) * level)), 1)
    return float(ordered[rank - 1])


def gated_keys(model_tag: str, threshold: float) -> dict[str, set[str]]:
    """Per var, the cell keys whose M3_base point correction hurts by > threshold
    (mae_q50 - mae_raw > threshold). Those cell x vars are dropped from the tables."""
    per_cell = pd.read_csv(tqd.MODELS / f"per_cell_{model_tag}.csv")
    per_cell = per_cell[per_cell.variant == "M3_base"].copy()
    per_cell["damage"] = per_cell.mae_q50 - per_cell.mae_raw
    out = {}
    for var in tqd.VARS:
        name = var["name"]
        hurt = per_cell[(per_cell["var"] == name) & (per_cell.damage > threshold)]
        out[name] = set(hurt.key)
        log(f"  gate {name}: {len(hurt)} / "
            f"{int((per_cell['var'] == name).sum())} cells dropped "
            f"(damage > {threshold})")
    return out


def hres_anchors_for(values: np.ndarray, is_precip: bool) -> np.ndarray:
    """The hres grid anchors for one cell x var from its TRAINING forecast values."""
    if is_precip:
        anchors = np.concatenate([
            np.quantile(values, PRECIP_ANCHOR_QUANTILES),
            np.linspace(values.min(), values.max(), N_PRECIP_LINEAR)])
        anchors = np.unique(anchors)
    else:
        anchors = np.linspace(values.min(), values.max(), N_HRES_ANCHORS)
    anchors = np.unique(np.round(anchors, 2))
    if len(anchors) < 2:            # constant-forecast cell: keep 2 so it can interp
        anchors = np.array([anchors[0], anchors[0] + 0.01])
    return anchors


def build_grid(static: pd.DataFrame, anchors_by_key: dict[str, np.ndarray],
               hres_name: str, fc_version: str):
    """One stacked frame of every (cell, hres-anchor, doy-anchor) point for a var,
    plus the aligned key/doy/hres columns for the output table."""
    cos_anchor = np.cos(2 * np.pi * DOY_ANCHORS / 365.25)
    sin_anchor = np.sin(2 * np.pi * DOY_ANCHORS / 365.25)
    n_doy = len(DOY_ANCHORS)

    cols = {c: [] for c in ("key", "doy", hres_name, "cos_doy", "sin_doy",
                            "elevation", "hres_elevation", "elev_diff_m",
                            "dist_to_hres_km", "lat", "lon")}
    for cell in static.itertuples():
        anchors = anchors_by_key[cell.key]
        n = len(anchors) * n_doy
        cols["key"].append(np.full(n, cell.key, dtype=object))
        cols["doy"].append(np.tile(DOY_ANCHORS, len(anchors)))
        cols[hres_name].append(np.repeat(anchors, n_doy))
        cols["cos_doy"].append(np.tile(cos_anchor, len(anchors)))
        cols["sin_doy"].append(np.tile(sin_anchor, len(anchors)))
        for geo in ("elevation", "hres_elevation", "elev_diff_m",
                    "dist_to_hres_km", "lat", "lon"):
            cols[geo].append(np.full(n, getattr(cell, geo)))

    frame = pd.DataFrame({c: np.concatenate(v) for c, v in cols.items()})
    frame["fc_version"] = fc_version
    return frame


def pin_median_isotonic(preds: np.ndarray) -> np.ndarray:
    """Restore per-row monotonicity WITHOUT moving the median: running max
    upward from q50, running min downward. The independent per-level shifts
    (and 2-dp rounding) can cross neighbouring heads; the client bilinear-
    interpolates each column separately, and interpolating column-monotone
    anchors stays monotone, so this keeps the served CDF valid everywhere."""
    for j in range(Q50 + 1, preds.shape[1]):
        np.maximum(preds[:, j], preds[:, j - 1], out=preds[:, j])
    for j in range(Q50 - 1, -1, -1):
        np.minimum(preds[:, j], preds[:, j + 1], out=preds[:, j])
    return preds


def predict_deltas(model: CatBoostRegressor, frame: pd.DataFrame,
                   feature_cols: list[str], shifts: np.ndarray) -> np.ndarray:
    """All 7 sorted bias-delta heads for every row, per-level shifts baked in,
    re-isotonized around the pinned (CQR-free) median. Rounded to the shipped
    2 dp HERE so the isotonic pass covers rounding-induced crossings too."""
    preds = np.sort(np.asarray(model.predict(frame[feature_cols])), axis=1)
    return pin_median_isotonic(np.round(preds + shifts, 2))


def compute_level_shifts(model, test, name, feature_cols) -> np.ndarray:
    """The six one-sided conformal shifts for this var (q50 stays 0 — the point
    value ships CQR-free), aligned to QUANTILE_LEVELS. The old recipe held out
    half of test to EVALUATE coverage; the evaluation now lives in
    cqr_per_level_validity.ipynb, so calibrate on the full test split (the fits
    never saw it) for the lowest-variance shifts."""
    preds = np.sort(np.asarray(model.predict(test[feature_cols])), axis=1)
    y = test[f"bias_{name}"].to_numpy()
    shifts = np.zeros(len(QUANTILE_LEVELS))
    for i, level in enumerate(QUANTILE_LEVELS):
        if i != Q50:
            shifts[i] = per_level_shift(y - preds[:, i], level)
    return shifts


def gated_shift_vector(residuals: np.ndarray) -> np.ndarray:
    """The 7 one-sided empirical shifts (the level-quantile of the raw residual
    bias) for a gated cell, aligned to QUANTILE_LEVELS, with the MEDIAN head
    pinned to 0 — the gated point stays RAW (its M3_base q50 was gated out). Band
    location comes from the asymmetric tail shifts, not from moving the point."""
    shifts = np.zeros(len(QUANTILE_LEVELS))
    for i, level in enumerate(QUANTILE_LEVELS):
        if i != Q50:
            shifts[i] = per_level_shift(residuals, level)
    return shifts


def fit_precip_conditional(fit_precip: pd.DataFrame, hcol: str):
    """Forecast-conditional precip band (cqr_per_level_validity.ipynb): residual
    quantiles fit WITHIN forecast-magnitude bins, POOLED across all gated precip
    cells so the heavy bins keep enough samples. Returns (edges, {bin: 7-vector}),
    each vector's median head 0. A constant per-cell precip band collapses on
    heavy-rain days (~27% coverage at the top-1% forecast); binning on the forecast
    holds ~90% across regimes because the band width fans with the forecast."""
    fc = fit_precip[hcol].to_numpy()
    residual = fit_precip["bias_precip"].to_numpy()
    wet = fc[fc >= tqd.PRECIP_TRACE_MM]
    inner = np.quantile(wet, [0.20, 0.40, 0.60, 0.75, 0.87, 0.95])
    inner = np.unique(inner[inner > tqd.PRECIP_TRACE_MM])
    edges = np.concatenate([[-np.inf, float(tqd.PRECIP_TRACE_MM)], inner, [np.inf]])
    which = np.clip(np.searchsorted(edges, fc, side="right") - 1, 0, len(edges) - 2)
    bin_shifts = {}
    for b in range(len(edges) - 1):
        rows = residual[which == b]
        bin_shifts[b] = gated_shift_vector(rows if len(rows) else residual)
    return edges, bin_shifts


def gated_cell_table(name: str, anchors: np.ndarray,
                     deltas_by_anchor: np.ndarray) -> pd.DataFrame:
    """A gated cell's var table in the SAME schema as the model tables: doy-constant
    (two straddling anchors), one 7-delta row per hres anchor. The client bilinear-
    interpolates it exactly like a model surface — no gating logic on that side."""
    n_doy = len(GATED_DOY_ANCHORS)
    tiled = np.repeat(deltas_by_anchor, n_doy, axis=0)      # (anchors*doy, 7)
    return pd.DataFrame({
        "var": name,
        "doy": np.tile(GATED_DOY_ANCHORS, len(anchors)),
        "hres": np.round(np.repeat(anchors, n_doy), 2),
        **{col: tiled[:, i] for i, col in enumerate(LEVEL_COLUMNS)}})


def circular_interp(table: pd.DataFrame, hres_anchors: np.ndarray,
                    doy_query: float, hres_query: float, col: str) -> float:
    """Bilinear lookup the client will mirror: circular-linear over the two
    straddling doy anchors x linear over the two straddling hres anchors."""
    hres_query = float(np.clip(hres_query, hres_anchors[0], hres_anchors[-1]))
    hi = int(np.searchsorted(hres_anchors, hres_query))
    lo = max(hi - 1, 0)
    hi = min(hi, len(hres_anchors) - 1)
    h0, h1 = hres_anchors[lo], hres_anchors[hi]
    tw = 0.0 if h1 == h0 else (hres_query - h0) / (h1 - h0)

    # straddling doy anchors on the 1..365 circle
    below = DOY_ANCHORS[DOY_ANCHORS <= doy_query]
    above = DOY_ANCHORS[DOY_ANCHORS >= doy_query]
    d0 = below.max() if len(below) else DOY_ANCHORS.max()
    d1 = above.min() if len(above) else DOY_ANCHORS.min()
    span = (d1 - d0) % 365 or 1
    dw = ((doy_query - d0) % 365) / span

    def at(d, h):
        row = table[(table.doy == d) & (np.isclose(table.hres, h))]
        return float(row[col].iloc[0])

    c00, c01 = at(d0, h0), at(d0, h1)
    c10, c11 = at(d1, h0), at(d1, h1)
    return (1 - dw) * ((1 - tw) * c00 + tw * c01) + dw * ((1 - tw) * c10 + tw * c11)


def self_check(model, static, anchors_by_key, tables_by_key, name, col,
               feature_cols, shifts, fc_version, n_cells, rng):
    """Exact model prediction vs table interpolation at random OFF-grid points,
    for a handful of cells. Big errors here mean the grid is too coarse."""
    keys = list(tables_by_key)            # single-var cell tables for this var
    if not keys:
        return
    sample = rng.choice(keys, size=min(n_cells, len(keys)), replace=False)
    static_by_key = static.set_index("key")
    errs = {level_col: [] for level_col in LEVEL_COLUMNS}
    for key in sample:
        anchors = anchors_by_key[key]
        table = tables_by_key[key]
        geo = static_by_key.loc[key]
        for _ in range(8):
            doy_q = float(rng.integers(1, 366))
            hres_q = float(rng.uniform(anchors[0], anchors[-1]))
            feat = pd.DataFrame([{
                col: hres_q, "cos_doy": np.cos(2 * np.pi * doy_q / 365.25),
                "sin_doy": np.sin(2 * np.pi * doy_q / 365.25),
                "elevation": geo.elevation, "hres_elevation": geo.hres_elevation,
                "elev_diff_m": geo.elev_diff_m, "dist_to_hres_km": geo.dist_to_hres_km,
                "lat": geo.lat, "lon": geo.lon, "fc_version": fc_version, "key": key}])
            truth = dict(zip(LEVEL_COLUMNS,
                             predict_deltas(model, feat, feature_cols, shifts)[0]))
            for tcol in errs:
                got = circular_interp(table, anchors, doy_q, hres_q, tcol)
                errs[tcol].append(abs(got - truth[tcol]))
    worst = max(errs, key=lambda c: np.max(errs[c]))
    stats = ", ".join(
        f"{c} p99={np.quantile(v, 0.99):.3f}" for c, v in errs.items())
    log(f"  self-check {name} ({len(sample)} cells x 8 pts): {stats} | "
        f"worst max {worst}={np.max(errs[worst]):.3f}")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out-dir", default=str(HERE / "data" / "debias"),
                    help="local mirror dir for the per-cell tables")
    ap.add_argument("--model-tag", default="qn8727_s0_q9",
                    help="TAG of the shipped fits + per_cell CSV to bake")
    ap.add_argument("--gate-threshold", type=float, default=0.1,
                    help="drop cell x vars where mae_q50 - mae_raw exceeds this")
    ap.add_argument("--limit", type=int, help="random sample of N cells (debug)")
    ap.add_argument("--allow-partial", action="store_true",
                    help="DEBUG: warn+drop missing/stale cells instead of raising")
    ap.add_argument("--self-check-cells", type=int, default=20,
                    help="cells sampled for the interpolation self-check (0=off)")
    args = ap.parse_args()

    fc_version = current_fc_version()
    log(f"IFS cycle pinned to fc_version={fc_version} "
        "(regen at the next cutover — see tqd.FC_CHANGES)")

    # --- data pipeline (reuse the trainer; NO archive refresh — bake exactly what
    #     the fits saw) ---
    static = tqd.preflight(args.limit, args.allow_partial)
    df = tqd.load_and_verify(static, args.allow_partial)
    df = tqd.add_features(df)
    df = tqd.split(df)
    df = tqd.shrink(df)
    train = df[df.role == "train"]

    gates = gated_keys(args.model_tag, args.gate_threshold)
    seed_rng = np.random.default_rng(tqd.SEED)

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    per_cell_tables: dict[str, list[pd.DataFrame]] = {k: [] for k in static.key}
    for var in tqd.VARS:
        name, is_precip = var["name"], var["name"] == "precip"
        hcol = tqd.hres_col(name)               # e.g. 'hres_tmax_C' — the fc value
        feature_cols = tqd.feature_cols(name, with_cell=True, with_cross=False)
        model = CatBoostRegressor()
        model.load_model(str(tqd.MODELS / f"M3_base_{name}_{args.model_tag}.cbm"))

        var_rows = df[df[f"bias_{name}"].notna()]
        test = var_rows[var_rows.role == "test"]
        shifts = compute_level_shifts(model, test, name, feature_cols)
        log(f"== {name}: shifts "
            + " ".join(f"{LEVEL_COLUMNS[i]}={shifts[i]:+.3f}"
                       for i in range(len(shifts)) if i != Q50)
            + f", test {len(test):,} rows ==")

        # per-cell hres anchors from TRAINING forecast values
        kept = static[~static.key.isin(gates[name])]
        train_var = train[train[f"bias_{name}"].notna()]
        anchors_by_key = {
            key: hres_anchors_for(values.to_numpy(), is_precip)
            for key, values in train_var.groupby("key", observed=True)[hcol]
            if key not in gates[name]}
        kept = kept[kept.key.isin(anchors_by_key)]   # a gated/absent cell has none

        grid = build_grid(kept, anchors_by_key, hcol, fc_version)
        deltas = predict_deltas(model, grid, feature_cols, shifts)
        table = pd.DataFrame({
            "var": name, "doy": grid.doy.to_numpy(np.int16),
            "hres": np.round(grid[hcol].to_numpy(), 2),
            **{level_col: deltas[:, i] for i, level_col in enumerate(LEVEL_COLUMNS)},
            "key": grid.key.to_numpy()})

        tables_by_key = {}
        for key, cell_table in table.groupby("key", sort=False):
            cell_table = cell_table.drop(columns="key")
            per_cell_tables[key].append(cell_table)
            tables_by_key[key] = cell_table

        if args.self_check_cells:
            self_check(model, kept, anchors_by_key, tables_by_key, name, hcol,
                       feature_cols, shifts, fc_version, args.self_check_cells,
                       seed_rng)
        del model, grid, table

        # --- gated cells: same schema, empirical band instead of the model surface
        #     (non-precip constant, precip forecast-conditional; median head 0) ---
        gated_fit = df[df.key.isin(gates[name]) & df[f"bias_{name}"].notna()
                       & df.role.isin(("train", "test"))]
        train_fc_by_key = {key: values.to_numpy() for key, values
                           in train_var.groupby("key", observed=True)[hcol]}
        if is_precip and len(gated_fit):
            precip_edges, precip_bin_shifts = fit_precip_conditional(gated_fit, hcol)
        gated_written = 0
        for key, group in gated_fit.groupby("key", observed=True):
            forecasts = train_fc_by_key.get(key)
            if forecasts is None or len(forecasts) == 0:   # no train fc -> serve raw
                continue
            if is_precip:
                anchors = hres_anchors_for(forecasts, True)
                bins = np.clip(np.searchsorted(precip_edges, anchors, side="right") - 1,
                               0, len(precip_edges) - 2)
                deltas = pin_median_isotonic(
                    np.round(np.array([precip_bin_shifts[b] for b in bins]), 2))
            else:
                anchors = np.unique(np.round([forecasts.min(), forecasts.max()], 2))
                if len(anchors) < 2:                       # constant-forecast cell
                    anchors = np.array([anchors[0], anchors[0] + 0.01])
                shift = gated_shift_vector(group[f"bias_{name}"].to_numpy())
                deltas = pin_median_isotonic(
                    np.round(np.tile(shift, (len(anchors), 1)), 2))
            per_cell_tables[key].append(gated_cell_table(name, anchors, deltas))
            gated_written += 1
        log(f"  gated {name}: {gated_written} empirical "
            f"{'conditional' if is_precip else 'constant'} tables "
            f"of {len(gates[name])} gated cells")

    # --- write one gzip per cell (model surface + gated empirical bands) ---
    written = 0
    for key, parts in per_cell_tables.items():
        if not parts:                       # no data at all -> client serves raw
            continue
        cell_table = pd.concat(parts, ignore_index=True)
        path = out_dir / f"debias_{key}.csv.gz"
        with gzip.open(path, "wt", newline="") as f:
            cell_table.to_csv(f, index=False, float_format="%.2f")
        written += 1
    log(f"wrote {written} per-cell tables -> {out_dir}  "
        f"(upload step: r2_upload.py, key debias/<name>)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
