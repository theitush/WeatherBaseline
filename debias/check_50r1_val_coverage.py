"""Per-level coverage on the 20 val-split 50r1 days.

The test split has ZERO 50r1 days (blocks end before the cycle starts), so the
shipped conformal shifts are calibrated on 48r1/49r1 residuals only. This is the
only held-ish-out read on the cycle the baked tables are pinned to. Val days were
seen by early stopping (mild optimism), so the honest comparison is 50r1-val vs
non-50r1-val, not 50r1-val vs nominal alone.

Protocol mirrors production baking: shifts = per-level split conformal on the FULL
test split (compute_level_shifts), applied with round(2) + pin_median_isotonic.
"""
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from catboost import CatBoostRegressor

BIAS_STUDY = Path("/home/ita/HowHotWasIt/scripts/bias_study")
sys.path.insert(0, str(BIAS_STUDY))
import train_quantile_debias as tqd
import make_debias_tables as mdt

MODEL_TAG = "qn8620_s0_q9"
QUANTILE_LEVELS = [0.01, 0.05, 0.10, 0.25, 0.50, 0.75, 0.90, 0.95, 0.99]
MEDIAN_INDEX = QUANTILE_LEVELS.index(0.50)

frame = pd.read_feather(BIAS_STUDY / "data" / "pipeline_frame_full.feather")

val_rows_all = frame[frame.role == "val"]
val_50r1_days = sorted(val_rows_all.loc[val_rows_all.fc_version == "50r1", "date"].unique())
print(f"val 50r1 days: {len(val_50r1_days)}  ({pd.Timestamp(val_50r1_days[0]).date()}"
      f" .. {pd.Timestamp(val_50r1_days[-1]).date()})")

def predict_sorted(model, X, chunk=200_000):
    out = [np.sort(np.asarray(model.predict(X.iloc[s:s + chunk])), axis=1)
           for s in range(0, len(X), chunk)]
    return np.concatenate(out, axis=0)

report_rows = []
for var in tqd.VARS:
    name = var["name"]
    features = tqd.feature_cols(name, with_cell=True, with_cross=False)
    model = CatBoostRegressor()
    model.load_model(str(tqd.MODELS / f"M3_base_{name}_{MODEL_TAG}.cbm"))

    test = frame[(frame.role == "test") & frame[f"bias_{name}"].notna()]
    test_preds = predict_sorted(model, test[features])
    test_y = test[f"bias_{name}"].to_numpy()
    shifts = np.zeros(len(QUANTILE_LEVELS))
    for i, level in enumerate(QUANTILE_LEVELS):
        if i != MEDIAN_INDEX:
            shifts[i] = mdt.per_level_shift(test_y - test_preds[:, i], level)

    val = frame[(frame.role == "val") & frame[f"bias_{name}"].notna()]
    val_preds = predict_sorted(model, val[features])
    del model
    adjusted = mdt.pin_median_isotonic(np.round(val_preds + shifts, 2))
    val_y = val[f"bias_{name}"].to_numpy()
    is_50r1 = (val.fc_version == "50r1").to_numpy()

    # season-matched control: May val days from OTHER cycles (50r1-val is all May 2026)
    is_may_other = ((val.date.dt.month == 5) & (val.fc_version != "50r1")).to_numpy()
    for i, level in enumerate(QUANTILE_LEVELS):
        if i == MEDIAN_INDEX:
            continue
        covered = val_y <= adjusted[:, i]
        report_rows.append({
            "var": name, "level": level,
            "val_50r1_pct": 100 * covered[is_50r1].mean(),
            "val_may_other_pct": 100 * covered[is_may_other].mean(),
            "val_other_pct": 100 * covered[~is_50r1].mean(),
            "n_50r1": int(is_50r1.sum()), "n_may_other": int(is_may_other.sum()),
            "n_other": int((~is_50r1).sum()),
        })
    done = pd.DataFrame([r for r in report_rows if r["var"] == name])
    print(f"[{name}] shifts applied; 50r1 rows {done.n_50r1.iloc[0]:,},"
          f" other val rows {done.n_other.iloc[0]:,}", flush=True)

report = pd.DataFrame(report_rows)
report["gap_50r1_vs_may_pp"] = report.val_50r1_pct - report.val_may_other_pct
report["gap_50r1_vs_other_pp"] = report.val_50r1_pct - report.val_other_pct
pivot = report.pivot(index="var", columns="level",
                     values=["val_50r1_pct", "val_may_other_pct", "val_other_pct",
                             "gap_50r1_vs_may_pp", "gap_50r1_vs_other_pp"])
pd.set_option("display.width", 250)
print(f"\nMay-other control days: {report.n_may_other.iloc[0]:,} rows")
for block in ["val_50r1_pct", "val_may_other_pct", "gap_50r1_vs_may_pp",
              "gap_50r1_vs_other_pp"]:
    print(f"\n=== {block} ===")
    print(pivot[block].round(2).to_string())
out_csv = Path(__file__).with_suffix(".csv")
report.to_csv(out_csv, index=False)
print(f"\nsaved {out_csv}")
