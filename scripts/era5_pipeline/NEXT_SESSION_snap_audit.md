# Next session: audit the nearest-land snap for silently relocated cells

> **DONE 2026-08-25.** The audit ran (227 snapped, 14 over the 25 km cap) and
> the full rewrite was executed the same day — see **SNAP_REWRITE.md** for the
> outcome, the verification record, and the downstream (debias/HRES)
> obligations. This brief is kept as the original problem statement.

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

Run it over **all tiles** — not because a rerun could snap differently (land is
static, it can't), but because the resume log is incomplete: its scope line says
331 tiles / 7,897 cells, i.e. ~10 tiles finished in earlier runs and were never
reprocessed, so their snaps were never logged. The current cells.csv spans
**341** tiles. Write a CSV sorted by distance descending. Cost is ~341 tiles ×
~47 MB ≈ 16 GB against the DestinE store, the pipeline's own source. **Quote
the volume and get an explicit go before running it** — see the
`download_cells` token rule in memory.

> **2026-08-25 review:** the audit script now exists —
> [audit_snap_distances.py](audit_snap_distances.py). It implements this method
> plus: per-tile mask caching to `snap_audit_masks/*.npz` (cap-tuning reruns are
> free), the true haversine-nearest land column (exposes the index-metric drift
> at high latitude), a `cross_tile_possible` flag (see below), and the all-ocean
> guard as a hard error. Math validated offline against the Christmas Island
> case (351 km reproduced). Only the store fetch is pending approval.

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
- **Except**: a far-snapped cell flagged `cross_tile_possible` sits nearer to
  its tile's edge than to the land the snap chose — a neighboring tile may hold
  much closer land. That is a window artifact (the snap only searches within
  one tile), not a Christmas-Island case; the fix there is padding the window
  or special-casing the cell, **not** dropping a real city. Check its
  8-neighborhood masks before deciding.
- **USER DECISION 2026-08-25 (firm): every legitimately snapped cell gets its
  `cells.csv` coordinate MOVED to the resolved land gridpoint** (`res_lat`/
  `res_lon` in the audit CSV). The coordinate's job is to point at where the
  data comes from — the UI reports geocode→coordinate distance and must be
  honest. The **name stays** (Sittwe's card is still Sittwe; only the pin moves
  ~1 gridpoint to the data source). This is the F1 rewrite procedure again,
  minus blank archives. Implications to handle in the rewrite:
  - **R2 keys derive from coords** (`archive_<lat>_<lon>` × archive/recent/
    forecast/debias): each moved cell needs a four-tier server-side copy to the
    new key + delete of the old, or a re-pull. Verify count before/after.
  - **Collisions**: the land gridpoint may already be another cell's coordinate
    (F1 saw 183 dups) — merge, don't duplicate.
  - Recompute `tile_id`/`tile_lat`/`tile_lon` for moved cells (a move can cross
    a tile edge); regenerate `cell_elevation.csv` (make_cell_elevation.py,
    ERA5-Land only); redeploy `/cells.csv` (Pages static, CRLF preserved).
  - **Do NOT re-derive names** via the naming pipeline (known non-idempotent,
    Barcelona regression) — names are kept verbatim.
  - Check the local-solar-day offset doesn't change for any lon move; if it
    does, that cell needs a re-pull, not a key rename.
  - After the rewrite the runtime snap becomes a no-op for every moved cell
    (its nearest gridpoint IS land), so the cap only ever fires on genuinely
    new/broken cases — loudly.
- Far-snapped cells are NOT moved — relabeling West Java as "Flying Fish Cove"
  is the bug, not the fix. Over-cap = drop (Christmas Island treatment);
  `cross_tile_possible` = widen the window first, then move to the *near* land.

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
