# Next session: audit the nearest-land snap for silently relocated cells

## The ask

`resolve_land_indices` in [download_cells.py](download_cells.py) snaps a cell whose
nearest ERA5-Land gridpoint is ocean to the nearest land **anywhere in its tile
window**, with **no distance cap** — the bare `d2.argmin()` at ~line 540. A
5°×10° window is roughly 550×1100 km, so a cell can be silently relocated
hundreds of km and still produce a full, plausible-looking archive.

**Audit how far each snapped cell actually moved, then decide on a cap.**

## Why this is not hypothetical

On 2026-08-25 this shipped bad data for a real city. `archive_-10.4_105.7`,
labelled "Flying Fish Cove, Christmas Island", held 27,911 rows of **West Java's
climate** — the snap had landed on `-7.40, 106.70`, **350 km away**. Proof:
recomputing daily tmax/tmin at that gridpoint with the cell's +7h solar offset
reproduced the shipped rows exactly, max |Δ| **0.0000 °C** across 12 sampled
days. Christmas Island has never had ERA5-Land data (the gridpoint is NaN in
both the v3 and the frozen legacy v2 store, all 4 vars, 1950→2026; no land
within ±0.5°) — it is simply too small for a 0.1° land mask.

That cell was caught **only because the v3 retiling (64×64 → 50 lat × 100 lon)
shrank its window until it contained no land at all**, turning a silent bad snap
into a loud skip. Cells that still have *some* land in range remain silent.
Removed and deployed in `86289345`.

## Scope

The 2026 top-up log records **220 cells snapped across 118 tiles**
([topup_2026_resume.log](topup_2026_resume.log), lines matching
`land snap — N cell(s) snapped off ocean`). None of those distances were
computed or logged. That log only names tiles and counts, so the audit must
recompute per-cell.

## Method

Mirror [find_noland_cells.py](find_noland_cells.py) — it already replays
`process_span`'s exact window selection and calls the real
`resolve_land_indices`, reading **one timestep chunk of t2m per tile** (~47 MB)
instead of a full history. Land is static, so one chunk's finite-mask equals the
mask a full span builds. Extend it to report, per cell:

- the cell's own (lat, lon) and its nearest gridpoint
- the resolved land gridpoint
- **great-circle distance between them** (use haversine for the report; the
  in-code snap deliberately uses squared index distance as a cheap tie-break —
  do not change that without thinking about the lat-dependent cell width)
- the tile id, cell name and population (so the impact is rankable)

Run it over **all tiles** (a cell not snapped this run could still be snapped on
a rerun with a different span), and write a CSV sorted by distance descending.
Cost is ~331 tiles × ~47 MB against the DestinE store, the pipeline's own
source. **Quote the volume and get an explicit go before running it** — see the
`download_cells` token rule in memory.

## What to do with the answer

- Report the distance distribution: median, p95, max, and every cell over
  ~25 km, with names and populations.
- Then propose a cap (~25–50 km is the starting guess, but let the data set it
  — a genuine coastal city should snap only a gridpoint or two, i.e. ~10–20 km).
  Above the cap the cell should be **skipped like a no-land cell**, not silently
  relocated, and logged loudly.
- Any cell already over the cap has a **wrong archive on R2 right now**. It
  needs the same treatment Christmas Island got: verify by reproducing its rows
  from the snapped gridpoint, then drop the cell and delete all four tier
  objects (`archive/`, `recent/`, `forecast/`, `debias/`).
- Cells snapped a *short* way are fine and expected — that is the F1 coastal fix
  working as designed. Do not regress it.

## Watch out for

- **Do not** re-derive tile ids from `data/cells.csv` blindly against the old
  scheme. `noland_cells.csv` still carries **old-scheme 64×64 tile ids** for its
  first 14 rows (e.g. `9_46` — column 46 cannot exist in the 100-column grid);
  only the 15th row (Christmas Island, `20_10`) is new-scheme.
- The store grid is **1472 lat × 3600 lon**, lat 90.0 → -57.1 step -0.1, lon
  0.0 → 359.9. Tile `r_c` = lat idx `r*50:(r+1)*50`, lon idx `c*100:(c+1)*100`.
- Longitudes in `cells.csv` are −180..180; the store is 0..360. `process_span`
  converts with `np.where(lons < 0, lons + 360, lons)` — mirror that or western
  cells will resolve to the wrong column.
- A positive control is worth keeping in the script (Jakarta `-6.2, 106.8`
  returns 24/24 finite t2m). An all-NaN fetch from a broken query looks
  identical to genuine ocean, and that ambiguity is exactly what hid this bug.

## Useful context

- `cells.csv` is now **8,726 rows**; R2 holds 8,726 archives, 0 orphans.
- Archives are `Cache-Control: public, no-cache`, so the edge revalidates by
  ETag — a re-upload needs no zone purge (there is still no purge-scoped token).
- Memory: `project_topup_2026_resume` has the full Christmas Island diagnosis;
  `feedback_download_cells_tokens` has the run-approval rule.
