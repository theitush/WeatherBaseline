# debias/ — correcting the forecast onto the ERA5-Land scale

The site ranks today's/tomorrow's **IFS-HRES forecast** against a climatology built
from **ERA5-Land** (the archive tier). The two products disagree systematically —
per cell, per variable, worst in mountains and at the tails — and that offset would
read as a fake percentile signal ("windier than 98% of days" with no weather behind
it). This folder is the study that measured the offset, the training run that learned
a per-cell correction (`corrected = hres + f(hres, day-of-year, cell)` as nine quantile
heads), the validation of the bands those heads give, and the baking of it all into
the static per-cell tables the frontend reads from R2 (`debias-v9/`, live since
2026-08-28).

Everything Python here runs in `../era5_pipeline/.venv`. R2 is the source of truth
for all data; the `data/` subdirs are local caches or research extracts
(see `.gitignore` — only `data/overlap.csv` and `data/cell_elevation.csv` are tracked).

## Scripts — the production path, in order

| file | what it does |
|---|---|
| `pull_hres_all.py` | Forecast side of the study: pulls ~2 yr of settled IFS-HRES daily forecasts (tmax/tmin/precip/wind_max) for every cell in `cells.csv`, at the identical snapped point + `cell_selection=nearest` the prod Worker uses, into its own R2 prefix. Resumable from any machine; `--append` tops up the tail monthly. **Hits Open-Meteo — `--dry-run` first, it's quota-metered.** Runbook: `HRES_VM_RUN.md`. |
| `pull_archive_slice.py` | Baseline side: for every cell with an HRES object, reads our own ERA5-Land archive from R2 and keeps the rows in the HRES overlap window (2024-03-01 →). Pure R2 read, no external API. `train_quantile_debias.py` calls it as its step 2. |
| `make_cell_elevation.py` | Derives each cell's elevation from ERA5-Land's *own* geopotential (`data/geo.grib` from CDS) → `data/cell_elevation.csv`, the `elevation` feature. Never the Open-Meteo elevation API (different surface). Rerun after any `cells.csv` change. |
| `train_quantile_debias.py` | **Single source of truth for the model pipeline** — `preflight → load_and_verify → add_features → split → train → evaluate`. Fits one CatBoost MultiQuantile model per variable (levels .01/.05/.10/.25/.50/.75/.90/.95/.99) with the cell as a native categorical (`M3_base`, the bakeable variant). Blocked-in-time split, 3-day embargo, unweighted. Writes `models/{variant}_{var}_{TAG}.cbm` + `spec_/eval_/per_cell_{TAG}`. The notebooks import its functions rather than re-implementing them. |
| `make_debias_tables.py` | Bakes the `M3_base` fits into per-cell interpolation tables (`debias_{lat}_{lon}.csv.gz`, deltas on a doy × hres grid, nine heads each with a signed per-level one-sided CQR shift, median pinned). Cells where the model *hurts* vs raw are gated and get an empirical band instead (constant for temp/wind, forecast-conditional for precip) — same schema, so the client has no gating logic. Output goes to a **new versioned** `data/debias-vN/` every time; promotion = upload under that prefix + flip `DEBIAS_PREFIX` in `frontend/src/services/ci.ts` + Pages deploy. |
| `check_50r1_val_coverage.py` | Side check for the q9 bake: the test split has no IFS-cycle-50r1 days, so this reads per-level coverage on the 20 val-split 50r1 days (the cycle the shipped tables are pinned to) vs a non-50r1 val control. Mildly optimistic (val was seen by early stopping) — that's why it's a comparison, not an absolute. |
| `qm_vs_m3_decomp.py`, `qm_m3_hybrid.py` | Not standalone — `%run -i` them inside a live `ml_debias` kernel. They settle the precip question "quantile mapping matches the *distribution* (QQ) but M3 wins per-day error — which one, or a hybrid gated on the forecast?" by metric / season / cell / cycle. |

Typical run (after the archive itself has been topped up in `era5_pipeline/`, since
the archive is the stale side):

```bash
cd debias && source ../era5_pipeline/.venv/bin/activate
set -a; source ../era5_pipeline/r2.env; set +a
python pull_hres_all.py --append --end YYYY-MM-DD --dry-run   # price it, then run it
python train_quantile_debias.py                               # resumes; pulls archive slices itself
python make_debias_tables.py --out-dir data/debias-vN
```

## Notebooks

Reading order for the current (q9, 9-level) system, then the studies that led to it.

### The model and its validation

| notebook | question it answers |
|---|---|
| `debias_eval.ipynb` | Probably the most interesting and definitely the most up-to-date notebook in the repo. Raw forecast vs the previously shipped 7-level model (scored *as served*, all 8,620 live cells) vs the q9 retrain, on identical rows: signed error per tier (boxplots + full histograms), band coverage per tier per metric, and a worst-cells drill-down (QQ + rung reliability). |
| `ml_debias.ipynb` | The modelling notebook. Wires `train_quantile_debias`'s functions to the cached full-grid fits (no retraining — `CELL_LIMIT` must stay `None`) and evaluates them: point error vs raw at the tails, band coverage/width, feature importance, cycle offset, where M2 (no cell identity) and M3 disagree, and the gating diagnostic (cells where M3 hurts). |
| `cqr_per_level_validity.ipynb` | **Level 0.** Computes the eight per-level one-sided CQR shifts `make_debias_tables.py` bakes in, and measures how honest each calibrated tail is on days the calibration never saw — marginal, monthly, and conditional on an extreme forecast. Also the empirical bands for gated cells and the forecast-conditional precip band. |
| `cdf_rung_coverage.ipynb` | **Level 1.** Builds the 9-point band exactly as the frontend does and checks the interpolated predictive CDF at every 5 % rung (15, 20, 30 … are interpolations *between* trained heads). |
| `card_claim_reliability.ipynb` | **Level 2.** Is the card's "~C % chance this day will be ‹predicate›" calibrated — overall and **per verdict tier** that fired? The tier-conditional view is where selection effects show up (extreme tiers over-promise; a retrain can't fix that). |
| `part3_validation_summary.ipynb` | One-page graphical verdict of the 2026-08-27 q9 validation run, recomputed from cached artifacts in ~1 min. The three notebooks above stay the source of truth. |

### Earlier studies (conclusions already folded into the scripts)

| notebook | what it settled |
|---|---|
| `bias_study.ipynb` | The 20-cell pilot on `data/overlap.csv`: is there a bias at all, per variable and regime, and how many percentile points does it move the headline? Found the empty-ocean-cell archive bug (`FINDINGS.md` #1). |
| `preliminary.ipynb` | 300-cell follow-up on `data/archive-overlap/` vs `data/hres-forecast/`: QQ plots, bias by climate zone / elevation / season, behaviour at the extremes, what drives the large misses and whether they're fixable. |
| `quantile_cat_bakeoff.ipynb` | Weighted (tail-upweighted) vs unweighted quantile CatBoost. Unweighted won — weights bias the quantiles — which is why the trainer is unweighted. |
| `q25_q75_interp_check.ipynb` | 7-level era: was it legit to probit-interpolate q25/q75 client-side from q10/q50/q90? (Yes, ≤1.7 pp.) Superseded by the q9 retrain, which trains those two heads. |

## Docs

- `FINDINGS.md` — living log of *confirmed* findings; nothing added without sign-off.
- `HRES_VM_RUN.md` — how to run the full-grid HRES pull on a throwaway VM (free vs paid tier, resume).

## Data & models on disk

- `data/overlap.csv` (tracked) — the tidy 20-cell pilot frame.
- `data/cell_elevation.csv` (tracked) — from `make_cell_elevation.py`.
- `data/hres-forecast-ifs-hres/` — the version-pinned IFS-HRES pull the q9 fits were trained on; `data/hres-forecast/` is the older feed.
- `data/archive-overlap/` — ERA5-Land slices from `pull_archive_slice.py`.
- `data/debias-v9/` — the shipped bake (older `debias.stale-*` dirs are dead).
- `data/pipeline_frame_full.feather`, `data/nb_confidence/`, `data/archive-full-sample/` — notebook mirrors of the training/validation frames.
- `models/` — fits + eval CSVs by `TAG`: `n488_s0` (early 488-cell), `qn8727_s0` (7-level, shipped 2026-07-12), `qn8620_s0_q9` (9-level, live). `per_cell_*` drives gating; `per_level_cqr_*`, `gated_*` are the baked shift tables.
- `catboost_info/` — CatBoost training logs. `*.bak*` — editing snapshots of notebooks/feathers, kept beside their originals.
