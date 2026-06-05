# Follow-ups: cell names & location selector — SHIPPED

All three polish items are now done (in `name_cells.py` + `LocationSelector.tsx`).
Kept here as a record of what each does and the tuning knobs.

## 1. Neighbourhood + parent city — "Pallabi, Dhaka"  ✅

`nearest_city_join`'s `pick()` keeps the chosen place as the primary label, then
appends a recognisable parent when a much larger nearby place exists: within
`PARENT_KM` (12 km), a different name, and `PARENT_POP_RATIO` (4×) more populous.
So cell #0 = "Pallabi, Dhaka, Bangladesh", "Masina, Kinshasa", etc. A megacity
that IS the prominent place stays single ("Dhaka", "Kolkata").

Known edge: a second Pallabi cell (#494) sits just past 12 km from Dhaka's
centroid, so it stays "Pallabi, Bangladesh". Widening `PARENT_KM` over-attaches
parents elsewhere; left as the intended tradeoff.

## 2. De-dupe the suggestion dropdown  ✅

`LocationSelector.tsx` de-dupes `matched` by the snapped cell's `(lat,lon)` via a
`Set`, keeping the first (most-relevant) hit per cell. Collapses the duplicate
"Paris 18" rows; same-named cells in different regions snap to distinct coords so
they stay separate rows (relies on #3).

## 3. Same name across different regions — "Springfield"  ✅

`load_admin1_names()` loads `admin1CodesASCII.txt` (keyed `{country}.{admin1code}`
→ name); the admin1 code rides through the join from gazetteer col 10. In `main()`
we compute each near cell's `{place}, {country}` base label, count collisions, and
splice the region in ONLY for labels shared by >1 cell → "Springfield, Illinois,
United States". Unique labels stay concise. A region that just repeats a label
segment is dropped (no "Cairo, Cairo, Egypt").

## Re-run recipe (for any of the above)
```
cd scripts/era5_pipeline && .venv/bin/python name_cells.py   # idempotent; Photon cached
cd ../../frontend && node scripts/sync-cells.mjs             # copy to public/
```
`data/cells.csv` is the tracked source of truth; `frontend/public/cells.csv` is
the generated served copy (gitignored, rebuilt on predev/prebuild).
