"""One-off: rebuild the notebook pipeline frame with all five variables (dew point
included) and report, column by column, how it differs from the cached four-variable
frame the v9 eval artifacts were built on. Writes data/pipeline_frame_full.feather."""
import numpy as np, pandas as pd
from pathlib import Path
import train_quantile_debias as tqd

OUT = tqd.HERE / "data" / "pipeline_frame_full.feather"
REF = Path("/home/ita/HowHotWasIt/debias/data/pipeline_frame_full.feather")  # 4-var, 2026-08-27

tqd.log(f"vars: {[v['name'] for v in tqd.VARS]}")
static_cells = tqd.preflight(None, allow_partial=False)
data = tqd.load_and_verify(static_cells, allow_partial=False)
data = tqd.add_features(data)
data = tqd.split(data)
data = tqd.shrink(data).reset_index(drop=True)
tqd.log(f"built {len(data):,} rows x {len(data.columns)} cols")
data.to_feather(OUT)
tqd.log(f"wrote {OUT} ({OUT.stat().st_size/1e6:.0f} MB)")

# --- how does this differ from the frame the cached v9 artifacts were built on? ---
ref = pd.read_feather(REF)
print(f"\nref {len(ref):,} rows x {len(ref.columns)} cols   new {len(data):,} x {len(data.columns)}")
assert len(ref) == len(data), "row count changed"
assert (ref.key.to_numpy() == data.key.to_numpy()).all(), "row ORDER changed (key)"
assert (ref.date.to_numpy() == data.date.to_numpy()).all(), "row ORDER changed (date)"
print("row alignment: identical keys and dates, in the same order\n")

print(f"{'column':<22}{'kind':<8}{'n differing':>13}{'max |delta|':>14}")
n_changed = 0
for col in ref.columns:
    assert col in data.columns, f"cached column {col} vanished"
    a, b = ref[col].to_numpy(), data[col].to_numpy()
    if a.dtype.kind in "fi":
        fa, fb = a.astype("float64"), b.astype("float64")
        nan_gap = int((np.isnan(fa) != np.isnan(fb)).sum())
        both = ~np.isnan(fa) & ~np.isnan(fb)
        diff = fa[both] != fb[both]
        n = int(diff.sum()) + nan_gap
        gap = float(np.abs(fa[both][diff] - fb[both][diff]).max()) if diff.any() else 0.0
        kind = "num"
    else:
        sa, sb = pd.Series(a).astype(str), pd.Series(b).astype(str)
        n = int((sa != sb).sum()); gap = float("nan"); kind = "str"
    if n:
        n_changed += 1
        print(f"{col:<22}{kind:<8}{n:>13,}{gap:>14.6f}")
print(f"\n{n_changed} of {len(ref.columns)} cached columns differ")
print(f"new columns: {[c for c in data.columns if c not in ref.columns]}")
n_null = int(data['bias_dewpt'].isna().sum())
print(f"bias_dewpt nulls: {n_null:,} of {len(data):,} ({100*n_null/len(data):.3f}%)")
