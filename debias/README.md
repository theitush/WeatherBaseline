# Bias study — ERA5-Land baseline vs IFS-HRES forecast

Empirical test of whether the app's percentile statements ("hotter/windier than X%
of days") are distorted by a systematic offset between the **archive** tier
(ERA5-Land, the climatology) and the **forecast** tier (IFS-HRES).

## Files
- `pull_hres_all.py` — production-scale, resumable pull of IFS-HRES forecast
  history for every study cell.
- `pull_archive_slice.py` — matching ERA5-Land archive extract for those cells.
- `train_quantile_debias.py` — joins the two sources and trains the correction
  models.
- `make_debias_tables.py` — bakes the trained models into the deployable tables.

## Run
```bash
../era5_pipeline/.venv/bin/python pull_hres_all.py
../era5_pipeline/.venv/bin/python pull_archive_slice.py --local --overwrite
../era5_pipeline/.venv/bin/python train_quantile_debias.py
../era5_pipeline/.venv/bin/python make_debias_tables.py
```
See `HRES_VM_RUN.md` for the full-grid HRES acquisition runbook.

## Pilot findings (20 cells, 2024-06 .. 2026-05) — directional, not final

**Data bug found first.** Edinburgh (56.0,-3.2) and Wellington (-41.3,174.8)
archive objects in R2 are broken — tmax/tmin/wind empty, precip all-zero. They'd
render a meaningless climatology live. **Action: re-pull these in the era5
pipeline.** The notebook auto-detects and drops zero-variance baseline slices.

**vs the briefing's hypotheses:**

| H | Claim | Pilot result |
|---|---|---|
| H1 | flat-inland temp ±0.5°C | **FAIL** — mean \|bias\| 0.81°C; HRES runs warm even on flat cells |
| H2 | Tmin noisier than Tmax | Mixed — 8/14 cells; warm Tmin bias clear at high-lat/NW-Europe (London +1.7, Reykjavik +1.7, Innsbruck +3.5) |
| H3 | mountain temp off 1–2°C | **Holds** — mountain \|bias\| 1.65 vs flat 0.81; Kathmandu +3.1, Denver +2.3, Cape_Town +3.5 |
| H4 | HRES windier everywhere (ERA5-Land under-reps 20–30%) | **Partial** — only 11/18 cells >1, median ratio 1.11. NOT universal: coast/storm cells (Cape_Town 0.70, Singapore 0.78) run the *other* way; mountains inflate hard (Cusco 2.17, Srinagar 2.15) |
| H5 | wind bias worst in tail | Mixed — 10/18 cells p95 ratio > mean ratio |

**Phase-3 app impact (percentile points the bias moves the HRES-p90 headline):**
- tmax mean **−5.3 pts**, tmin +1.1, wind +1.8, precip +2.1 — but huge cell spread
  (wind up to +34, tmin up to +63 before cleanup). The distortion is real and
  cell-specific, not a uniform shift → any correction must be **per-gridpoint**,
  not global.

**Headline:** the wind story is more complicated than "HRES always windier" — the
sign flips by regime. Mountains are the worst offenders across *all* variables
(orography mismatch dominates). Worth expanding the sample (esp. more flat-inland
and coastal cells) before committing to a correction scheme.

## Next
- Re-pull Edinburgh/Wellington (+ audit how many of the 10k cells have the same
  empty-archive bug).
- Scale to ~150–200 cells for stable per-regime numbers.
- H8 (archive→recent internal seam) — not yet done; testable on live data with no
  new API pulls.
