"""Backfill a `name` column into data/cells.csv.

Each curated cell is a bare 0.1deg ERA5-Land grid point (lat/lon/population) with
no human label. The app now puts ONLY coords in the shareable URL and derives the
displayed place name from the cell list locally -- so every cell needs a name.

Strategy (local-first, network-fallback)
-----------------------------------------
  1. GeoNames cities500 gazetteer (population >= 500, ~200K places worldwide) is
     downloaded once and used as a LOCAL nearest-city lookup. For each cell we
     pick the nearest gazetteer city, preferring the more prominent one when two
     are within a hair of each other (our cells were chosen by population, so the
     nearby big city is almost always the right label). A KD-tree on an
     equirectangular projection makes the 10K x 200K join run in ~a second.
  2. For the handful of SPARSE cells whose nearest gazetteer city is still far
     (> FAR_KM), fall back to Photon reverse-geocoding for just those cells so
     they get a real OSM name too. Resumable + cached so an interruption mid-run
     loses nothing.

Output
------
  Rewrites data/cells.csv in place, appending a `name` column. All other columns
  are preserved verbatim. A reverse-geocode cache (data/era5-land/revgeo_cache.json)
  persists the Photon answers so re-runs are instant.

Usage
-----
  source .venv/bin/activate
  python name_cells.py            # download gazetteer if missing, then backfill
  python name_cells.py --no-photon  # skip the reverse-geocode fallback (coords for sparse)
"""
from __future__ import annotations

import argparse
import csv
import io
import json
import sys
import time
from collections import Counter
import urllib.request
import zipfile
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
DATA = HERE.parents[1] / "data"
CELLS = DATA / "cells.csv"
GAZ_DIR = DATA / "era5-land"
GAZ_ZIP = GAZ_DIR / "cities500.zip"
GAZ_TXT = GAZ_DIR / "cities500.txt"
REVGEO_CACHE = GAZ_DIR / "revgeo_cache.json"

GEONAMES_URL = "https://download.geonames.org/export/dump/cities500.zip"

# Beyond this great-circle distance, the nearest gazetteer city is too far to be
# a trustworthy label for the cell, so we reverse-geocode the cell directly.
FAR_KM = 25.0

R_EARTH_KM = 6371.0


def download_gazetteer() -> None:
    """Fetch + unzip GeoNames cities500 into GAZ_TXT (once)."""
    if GAZ_TXT.exists():
        return
    GAZ_DIR.mkdir(parents=True, exist_ok=True)
    print(f"Downloading {GEONAMES_URL} ...", file=sys.stderr)
    req = urllib.request.Request(GEONAMES_URL, headers={"User-Agent": "howhotwasit-namecells/1.0"})
    with urllib.request.urlopen(req) as resp:
        raw = resp.read()
    with zipfile.ZipFile(io.BytesIO(raw)) as zf:
        # The archive holds cities500.txt (and a readme we ignore).
        with zf.open("cities500.txt") as f, GAZ_TXT.open("wb") as out:
            out.write(f.read())
    print(f"  -> {GAZ_TXT} ({GAZ_TXT.stat().st_size / 1e6:.1f} MB)", file=sys.stderr)


def load_country_names() -> dict[str, str]:
    """Map ISO country code -> full country name from GeoNames countryInfo.

    Bundled with the dump download. Falls back to an empty map (code is then
    used verbatim) if it can't be fetched, so naming never hard-fails on it.
    """
    url = "https://download.geonames.org/export/dump/countryInfo.txt"
    out: dict[str, str] = {}
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "howhotwasit-namecells/1.0"})
        with urllib.request.urlopen(req, timeout=30) as resp:
            text = resp.read().decode("utf-8")
    except Exception as e:  # noqa: BLE001
        print(f"  countryInfo fetch failed ({e}); using codes verbatim", file=sys.stderr)
        return out
    for line in text.splitlines():
        if line.startswith("#") or not line.strip():
            continue
        cols = line.split("\t")
        if len(cols) > 4 and cols[0]:
            out[cols[0]] = cols[4]  # ISO code -> country name
    return out


def load_admin1_names() -> dict[str, str]:
    """Map "{country}.{admin1code}" -> human admin-1 name (e.g. "US.IL" -> "Illinois").

    Used to disambiguate same-named cells in different regions (the Springfield
    problem). Like countryInfo, this is best-effort: on failure we return an empty
    map and simply skip the region, never hard-failing naming on it.
    """
    url = "https://download.geonames.org/export/dump/admin1CodesASCII.txt"
    out: dict[str, str] = {}
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "howhotwasit-namecells/1.0"})
        with urllib.request.urlopen(req, timeout=30) as resp:
            text = resp.read().decode("utf-8")
    except Exception as e:  # noqa: BLE001
        print(f"  admin1Codes fetch failed ({e}); skipping region disambiguation", file=sys.stderr)
        return out
    # Format: "{country}.{admin1code}\t{name}\t{asciiName}\t{geonameid}"
    for line in text.splitlines():
        if not line.strip():
            continue
        cols = line.split("\t")
        if len(cols) >= 2 and cols[0]:
            out[cols[0]] = cols[1]  # "US.IL" -> "Illinois"
    return out


def load_gazetteer() -> tuple[np.ndarray, np.ndarray, list[str], np.ndarray, list[str], list[str]]:
    """Return (lats, lons, names, populations, country_codes, admin1_codes) per city.

    GeoNames dump is a tab-separated file; the columns we use are:
      1 name, 4 latitude, 5 longitude, 8 country code, 10 admin1 code,
      14 population  (0-indexed)
    """
    lats, lons, names, pops, ccs, a1s = [], [], [], [], [], []
    with GAZ_TXT.open(encoding="utf-8") as f:
        for line in f:
            cols = line.rstrip("\n").split("\t")
            if len(cols) < 15:
                continue
            try:
                lat = float(cols[4])
                lon = float(cols[5])
            except ValueError:
                continue
            pop = int(cols[14]) if cols[14].isdigit() else 0
            lats.append(lat)
            lons.append(lon)
            names.append(cols[1])
            pops.append(pop)
            ccs.append(cols[8])
            a1s.append(cols[10])
    print(f"  gazetteer: {len(names):,} cities", file=sys.stderr)
    return (np.asarray(lats), np.asarray(lons), names, np.asarray(pops), ccs, a1s)


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    dlat = np.radians(lat2 - lat1)
    dlon = np.radians(lon2 - lon1)
    a = (np.sin(dlat / 2) ** 2
         + np.cos(np.radians(lat1)) * np.cos(np.radians(lat2)) * np.sin(dlon / 2) ** 2)
    return float(2 * R_EARTH_KM * np.arcsin(np.sqrt(a)))


# Within this radius of a cell centre we prefer the most POPULOUS gazetteer
# city over the literally-nearest one — so a dense cell gets the recognisable
# name (Kolkata, Cairo) rather than whichever sub-district happens to sit on the
# exact grid point. Beyond it, the nearest city wins. A cell is ~11km wide, but
# 8km keeps the preference to places genuinely inside the cell; a cell that is
# itself a distinct megacity centre (e.g. Dhaka) gets named on its own row.
PROMINENCE_KM = 8.0

# A sub-district cell (e.g. Pallabi) gets the recognisable parent appended
# ("Pallabi, Dhaka") when a meaningfully-larger place sits within PARENT_KM of
# the chosen one. The radius is ~one cell wide because a megacity's centroid can
# sit a full cell away from an edge sub-district (Dhaka is ~10 km from Pallabi's
# cell, which 8 km PROMINENCE misses). The parent must be PARENT_POP_RATIO times
# more populous and a different name, so we never append a same-size neighbour or
# the place's own duplicate.
PARENT_KM = 12.0
PARENT_POP_RATIO = 4.0


def nearest_city_join(cell_lats, cell_lons, gaz_lats, gaz_lons, names, pops, ccs, a1s):
    """For each cell, return (name, country_code, admin1_code, distance_km).

    The chosen city = the most populous gazetteer city within PROMINENCE_KM of the
    cell centre; if none are that close, the single nearest city. When the chosen
    city is a sub-district, a much larger nearby place is appended as a parent
    ("Pallabi, Dhaka"). distance_km is to the CHOSEN (primary) city. Uses a KD-tree
    over a local equirectangular projection so Euclidean nearest ~ great-circle
    nearest at city scale; exact distance is haversine. Falls back to brute force
    if scipy isn't available.
    """
    cell_lats = np.asarray(cell_lats)
    cell_lons = np.asarray(cell_lons)

    def project(lats, lons):
        # Equirectangular about the equator; good enough for nearest-neighbour.
        x = np.radians(lons) * np.cos(np.radians(lats))
        y = np.radians(lats)
        return np.column_stack([x, y]) * R_EARTH_KM

    def pick(cands, ci):
        """Build (name, country_code, admin1_code, distance_km) from candidate gaz indices."""
        kms = [(j, haversine_km(cell_lats[ci], cell_lons[ci], gaz_lats[j], gaz_lons[j]))
               for j in cands]
        near = [(j, km) for j, km in kms if km <= PROMINENCE_KM]
        if near:
            j = max(near, key=lambda t: pops[t[0]])[0]       # most populous nearby
            km = next(k for jj, k in near if jj == j)
        else:
            j, km = min(kms, key=lambda t: t[1])             # else the single nearest

        label = names[j]
        # Append a recognisable parent when the chosen place is a small piece of a
        # much larger nearby city (a sub-district / neighbourhood). The parent must
        # be a different name and PARENT_POP_RATIO× more populous, and sit within
        # PARENT_KM of the cell centre.
        parents = [
            (jj, kk) for jj, kk in kms
            if kk <= PARENT_KM
            and names[jj] != names[j]
            and pops[jj] >= PARENT_POP_RATIO * max(pops[j], 1)
        ]
        if parents:
            pj = max(parents, key=lambda t: pops[t[0]])[0]   # most populous parent
            label = f"{names[j]}, {names[pj]}"
        return label, ccs[j], a1s[j], km

    try:
        from scipy.spatial import cKDTree
        tree = cKDTree(project(gaz_lats, gaz_lons))
        # Pull enough neighbours that the parent search sees the big city too,
        # not just the cluster of sub-districts on top of the cell centre.
        _, idxs = tree.query(project(cell_lats, cell_lons), k=20)
        out_names, out_cc, out_a1, out_dist = [], [], [], []
        for i in range(len(cell_lats)):
            label, cc, a1, km = pick(np.atleast_1d(idxs[i]), i)
            out_names.append(label)
            out_cc.append(cc)
            out_a1.append(a1)
            out_dist.append(km)
        return out_names, out_cc, out_a1, out_dist
    except ImportError:
        print("  scipy not installed; brute-force nearest (slower)", file=sys.stderr)
        out_names, out_cc, out_a1, out_dist = [], [], [], []
        for i in range(len(cell_lats)):
            d = haversine_km(cell_lats[i], cell_lons[i], gaz_lats, gaz_lons)
            order = np.argsort(d)[:20]
            label, cc, a1, km = pick(order, i)
            out_names.append(label)
            out_cc.append(cc)
            out_a1.append(a1)
            out_dist.append(km)
        return out_names, out_cc, out_a1, out_dist


def load_revgeo_cache() -> dict:
    if REVGEO_CACHE.exists():
        try:
            return json.loads(REVGEO_CACHE.read_text())
        except Exception:  # noqa: BLE001
            return {}
    return {}


def save_revgeo_cache(cache: dict) -> None:
    REVGEO_CACHE.write_text(json.dumps(cache))


def photon_reverse(lat: float, lon: float) -> tuple[str, str] | None:
    """Reverse-geocode a point via Photon. Returns (name, country) or None."""
    url = f"https://photon.komoot.io/reverse?lat={lat}&lon={lon}"
    req = urllib.request.Request(url, headers={"User-Agent": "howhotwasit-namecells/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read())
    except Exception as e:  # noqa: BLE001
        print(f"    revgeo {lat},{lon} failed: {e}", file=sys.stderr)
        return None
    feats = data.get("features") or []
    if not feats:
        return None
    p = feats[0].get("properties", {})
    name = p.get("name") or p.get("city") or p.get("county") or p.get("state")
    if not name:
        return None
    return name, (p.get("country") or "")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--no-photon", action="store_true",
                    help="skip Photon reverse-geocode fallback; label sparse cells by coords")
    ap.add_argument("--no-dedupe", action="store_true",
                    help="skip the sub-district pass that makes same-metro names unique")
    args = ap.parse_args()

    download_gazetteer()
    gaz_lats, gaz_lons, names, pops, ccs, a1s = load_gazetteer()
    cc_to_country = load_country_names()
    admin1_to_name = load_admin1_names()

    # Read the existing cells.csv, preserving every column.
    with CELLS.open(encoding="utf-8") as f:
        reader = csv.DictReader(f)
        fieldnames = list(reader.fieldnames or [])
        rows = list(reader)
    print(f"  cells: {len(rows):,}", file=sys.stderr)

    cell_lats = [float(r["lat"]) for r in rows]
    cell_lons = [float(r["lon"]) for r in rows]

    print("  nearest-city join ...", file=sys.stderr)
    t0 = time.time()
    nn_names, nn_cc, nn_a1, nn_dist = nearest_city_join(
        cell_lats, cell_lons, gaz_lats, gaz_lons, names, pops, ccs, a1s)
    print(f"    done in {time.time() - t0:.1f}s", file=sys.stderr)

    far = [i for i, d in enumerate(nn_dist) if d > FAR_KM]
    print(f"  {len(far):,} cells beyond {FAR_KM:g} km from any gazetteer city", file=sys.stderr)

    # Cache stores [name, country] per sparse cell. Resumable across runs; a
    # null entry means Photon had no answer (fall through to coords).
    cache = load_revgeo_cache()
    if far and not args.no_photon:
        print(f"  reverse-geocoding {len(far):,} sparse cells via Photon ...", file=sys.stderr)
        for n, i in enumerate(far):
            key = f"{cell_lats[i]:.2f},{cell_lons[i]:.2f}"
            if key in cache:
                continue
            cache[key] = photon_reverse(cell_lats[i], cell_lons[i])  # (name, country) or None
            if (n + 1) % 20 == 0:
                save_revgeo_cache(cache)
                print(f"    {n + 1}/{len(far)}", file=sys.stderr)
            time.sleep(1.0)  # be polite to the public Photon instance
        save_revgeo_cache(cache)

    def with_country(name: str, country: str) -> str:
        """Append the country unless it's already the tail of the name."""
        country = country.strip()
        if country and not name.endswith(country):
            return f"{name}, {country}"
        return name

    # Region disambiguation (#3): two same-named cities in different regions
    # (Springfield, IL vs MO vs MA) all read "Springfield, United States" and are
    # indistinguishable. So first compute each near cell's "{place}, {country}"
    # base label and count how many cells share it; for any base shared by more
    # than one cell, splice the admin-1 region in between → "Springfield, Illinois,
    # United States". Cells whose base label is unique keep the concise form. We
    # only count cells whose region is actually resolvable, so an unknown region
    # never blocks a disambiguation it can't help with.
    base_label: dict[int, str] = {}
    region: dict[int, str] = {}
    for i in range(len(rows)):
        if nn_dist[i] > FAR_KM:
            continue
        country = cc_to_country.get(nn_cc[i], nn_cc[i])
        base_label[i] = with_country(nn_names[i], country)
        reg = admin1_to_name.get(f"{nn_cc[i]}.{nn_a1[i]}", "")
        # Drop a region that just repeats a segment already in the label — many
        # capital/city-state admin-1 areas share the city's name ("Cairo, Cairo",
        # "Kinshasa, Kinshasa"), where the region adds nothing.
        segments = {s.strip().casefold() for s in nn_names[i].split(",")}
        region[i] = "" if reg.casefold() in segments else reg

    base_counts = Counter(base_label.values())

    # Assign final names: gazetteer for near cells; Photon (or coords) for far ones.
    for i, r in enumerate(rows):
        if nn_dist[i] <= FAR_KM:
            reg = region[i]
            if reg and base_counts[base_label[i]] > 1:
                country = cc_to_country.get(nn_cc[i], nn_cc[i])
                # Splice region between the place label and the country.
                r["name"] = with_country(f"{nn_names[i]}, {reg}", country)
            else:
                r["name"] = base_label[i]
        else:
            key = f"{cell_lats[i]:.2f},{cell_lons[i]:.2f}"
            rev = cache.get(key)
            if rev:
                r["name"] = with_country(rev[0], rev[1])
            else:
                r["name"] = f"{cell_lats[i]:.1f}, {cell_lons[i]:.1f}"

    # Final pass: a 0.1deg grid slices a dense metro into many cells that all
    # resolve to the same city+region, so ~3k cells would otherwise share a name
    # with a neighbour. Refine each duplicate to its sub-district (Nominatim, cached)
    # with a deterministic bearing/coord backstop, so every cell ends up unique.
    if not args.no_dedupe:
        from disambiguate_dupes import disambiguate
        print("  dedupe: refining same-metro duplicate names ...", file=sys.stderr)
        for i, _old, new in disambiguate(rows):
            rows[i]["name"] = new

    if "name" not in fieldnames:
        fieldnames.append("name")
    with CELLS.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fieldnames)
        w.writeheader()
        w.writerows(rows)
    print(f"\nWrote name column to {CELLS}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
