# Follow-ups: cell names & location selector

Three polish items deferred from the coords-only-URL + per-cell-name work. The
core feature is shipped and working; these refine the labels and the dropdown.

## 1. Add the neighbourhood AND the parent city — "Pallabi, Dhaka"

**Now:** `name_cells.py` labels each cell by the most-populous gazetteer city
within `PROMINENCE_KM` (8 km), else the single nearest place. So a megacity-edge
cell shows the neighbourhood alone (e.g. cell #0 = "Pallabi, Bangladesh") while
the city-centre cell shows the city (cell #5 = "Dhaka, Bangladesh").

**Want:** when the nearest place is a sub-district, append the recognisable
parent → "Pallabi, Dhaka, Bangladesh". Both precision and recognisability.

**How:** in `nearest_city_join`'s `pick()`, keep the NEAREST place as the primary
label, then look for a meaningfully-larger place within ~12 km (`PARENT_KM`) whose
population is, say, ≥4× the nearest (`PARENT_POP_RATIO`) and a different name; if
found, render "`{nearest}, {parent}`". Don't append when nearest already IS the
prominent one (Kolkata stays "Kolkata", not "Kolkata, Kolkata"). The earlier
draft of this exact logic is in git history (the parent-city version of
`nearest_city_join`) — can lift it back. Note: a wider radius (~12 km, one cell)
is needed because Dhaka's centroid is 10 km from cell #0; 8 km misses it.
Then re-run `python name_cells.py` (Photon cache makes it instant) and
`node frontend/scripts/sync-cells.mjs`.

## 2. De-dupe the suggestion dropdown

**Now:** each Photon result snaps independently to its nearest cell, so one query
can yield several rows that land on the SAME cell (or different cells sharing a
name) — e.g. "Paris" shows two "Paris 18 Buttes-Montmartre, France" rows (6 km &
5 km) because two Photon hits snapped to two adjacent cells with the same name.

**Want:** one row per distinct snapped cell.

**How:** in `LocationSelector.tsx`, after building `matched`, de-dupe by the
snapped cell's `(lat, lon)` (or by `cell.name` if we'd rather collapse
same-named adjacent cells too — decide which). Keep the closest of any group.
Build the list, then filter with a `Set` of seen cell keys before `setSuggestions`.

## 3. Same name across different regions — "Springfield"

**Now:** "Springfield" returns several genuinely-different cells (Illinois,
Missouri, Massachusetts…) all labelled just "Springfield, United States" — so the
rows are indistinguishable, and #2's de-dupe could wrongly collapse them.

**Want:** disambiguate same-named cells in different regions, e.g. add the state/
admin-1 → "Springfield, Illinois, United States".

**How:** GeoNames `cities500.txt` has the admin-1 code in **column 10** (e.g.
"IL"); the human admin-1 NAME needs `admin1Codes.txt`
(https://download.geonames.org/export/dump/admin1CodesASCII.txt, keyed
`{country}.{admin1code}` → name). Load it like `countryInfo.txt` is loaded today,
and insert the region between name and country in `name_cells.py`. Keep it
concise — only add the region when it disambiguates, or always for US/large
countries; decide. This also makes #2's de-dupe safe (the rows now differ).
Re-run the script + sync afterwards.

## Re-run recipe (for any of the above)
```
cd scripts/era5_pipeline && .venv/bin/python name_cells.py   # idempotent; Photon cached
cd ../../frontend && node scripts/sync-cells.mjs             # copy to public/
```
`data/cells.csv` is the tracked source of truth; `frontend/public/cells.csv` is
the generated served copy (gitignored, rebuilt on predev/prebuild).
