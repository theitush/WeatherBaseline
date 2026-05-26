/**
 * ERA5-Land cell matching against the actual selected cell list.
 *
 * select_cells.py picks the top-N most-populated ERA5-Land 0.1deg cells and
 * writes them to data/era5/cells.csv (copied to public/cells.csv so the dev
 * server can serve it). This module loads that list and answers, for an
 * arbitrary place from GeoNames: which SELECTED cell is nearest, and how far?
 *
 * Note this is the nearest cell *in the list* — not just any 0.1deg cell. A
 * place can be far from its nearest selected cell if it sits in a sparsely
 * populated region the top-N never reached. That gap is the thing this test
 * page exists to surface.
 */

export interface Cell {
  cellId: number;
  lat: number;
  lon: number;
  population: number;
  tileId: string;
}

const EARTH_RADIUS_KM = 6371;

/** Great-circle distance in km between two lat/lon points (haversine). */
export function haversineKm(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(a));
}

let cellsCache: Cell[] | null = null;

/**
 * Fetch and parse public/cells.csv once, then memoise. Columns:
 * cell_id,lat,lon,population,tile_id,tile_lat,tile_lon
 */
export async function loadCells(): Promise<Cell[]> {
  if (cellsCache) return cellsCache;

  const res = await fetch('/cells.csv');
  if (!res.ok) {
    throw new Error(`cells.csv HTTP ${res.status} — run select_cells.py first`);
  }
  const text = await res.text();
  const lines = text.trim().split('\n');
  const header = lines[0].split(',');
  const col = (name: string) => header.indexOf(name);
  const iId = col('cell_id');
  const iLat = col('lat');
  const iLon = col('lon');
  const iPop = col('population');
  const iTile = col('tile_id');

  const cells: Cell[] = [];
  for (let i = 1; i < lines.length; i++) {
    const f = lines[i].split(',');
    cells.push({
      cellId: Number(f[iId]),
      lat: Number(f[iLat]),
      lon: Number(f[iLon]),
      population: Number(f[iPop]),
      tileId: f[iTile],
    });
  }
  cellsCache = cells;
  return cells;
}

export interface CellMatch {
  cell: Cell;
  distanceKm: number;
}

/**
 * Find the nearest SELECTED cell to a place. Linear scan over the ~10K-cell
 * list — negligible cost, and avoids needing a spatial index.
 */
export function nearestCell(
  lat: number,
  lon: number,
  cells: Cell[],
): CellMatch {
  let best = cells[0];
  let bestDist = Infinity;
  for (const c of cells) {
    const d = haversineKm(lat, lon, c.lat, c.lon);
    if (d < bestDist) {
      bestDist = d;
      best = c;
    }
  }
  return { cell: best, distanceKm: bestDist };
}
