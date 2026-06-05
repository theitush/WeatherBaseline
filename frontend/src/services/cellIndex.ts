// cellIndex — the curated ~10K servable cells (data/cells.csv, shipped to the
// client at /cells.csv). We have archive data ONLY for these cells, so every
// searched place must snap to the nearest one before loadCellTimeline runs.
//
// The geocoder finds any place on Earth; this module pins that place to the
// closest grid cell we can actually serve. A flat distance scan is fine: a
// search yields ≤6 results × ~10K cells.
//
// Each cell also carries a human `name` (backfilled offline — see
// scripts/era5_pipeline/name_cells.py). That name is the ONLY label the app
// shows: it labels the suggestion the user picks, and it's what we resolve a
// coords-only shareable URL back into on load. No geocoding needed for either.

/** One curated cell. lat/lon are already on the 0.1° ERA5-Land grid. */
export interface Cell {
  lat: number;
  lon: number;
  /** Human label for this cell (nearest city / reverse-geocoded place). */
  name: string;
}

/** A geocoded point snapped to its nearest curated cell. */
export interface SnappedCell {
  /** The cell we'll fetch archive data for (grid lat/lon + name). */
  cell: Cell;
  /** Great-circle distance from the searched point to that cell, in km. */
  distanceKm: number;
}

let cellsPromise: Promise<Cell[]> | null = null;

/**
 * Load and cache the curated cell list. Fetched once per session from the
 * bundled /cells.csv; parsing keeps lat/lon (for the snap) and name (the label).
 */
export function loadCells(): Promise<Cell[]> {
  if (!cellsPromise) {
    cellsPromise = fetch('/cells.csv')
      .then((res) => {
        if (!res.ok) throw new Error(`cells.csv ${res.status}`);
        return res.text();
      })
      .then(parseCells)
      .catch((err) => {
        // Reset so a later search can retry rather than caching the failure.
        cellsPromise = null;
        throw err;
      });
  }
  return cellsPromise;
}

function parseCells(text: string): Cell[] {
  // Split on newlines and tolerate CRLF — the generated CSV may carry \r, which
  // would otherwise cling to the last column (turning "name" into "name\r" and
  // breaking the header lookup).
  const lines = text.trim().split(/\r?\n/);
  const header = parseCsvLine(lines[0]);
  const latIdx = header.indexOf('lat');
  const lonIdx = header.indexOf('lon');
  const nameIdx = header.indexOf('name');
  const cells: Cell[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]);
    const lat = Number(cols[latIdx]);
    const lon = Number(cols[lonIdx]);
    const name = nameIdx >= 0 ? (cols[nameIdx] ?? '').trim() : '';
    if (Number.isFinite(lat) && Number.isFinite(lon)) cells.push({ lat, lon, name });
  }
  return cells;
}

/**
 * Split one CSV line into fields, honouring double-quoted fields (the `name`
 * column can contain a comma, e.g. "Dhaka, Bangladesh", which Python's csv
 * writer quotes). Handles "" as an escaped quote. Sufficient for our own
 * generated file — not a general-purpose CSV parser.
 */
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { field += '"'; i++; } // escaped quote
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      out.push(field);
      field = '';
    } else field += ch;
  }
  out.push(field);
  return out;
}

const R_EARTH_KM = 6371;
const toRad = (deg: number) => (deg * Math.PI) / 180;

/** Great-circle (haversine) distance between two lat/lon points, in km. */
function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH_KM * Math.asin(Math.sqrt(a));
}

/**
 * Snap a geocoded point to the nearest curated cell. Returns null only when the
 * cell list is empty (it never is in practice). Flat scan over ~10K cells.
 */
export function snapToNearestCell(lat: number, lon: number, cells: Cell[]): SnappedCell | null {
  let best: Cell | null = null;
  let bestKm = Infinity;
  for (const cell of cells) {
    const km = haversineKm(lat, lon, cell.lat, cell.lon);
    if (km < bestKm) {
      bestKm = km;
      best = cell;
    }
  }
  return best ? { cell: best, distanceKm: bestKm } : null;
}

/**
 * Resolve a coords-only URL back into a display name: find the cell nearest the
 * URL's coords and return its label. The URL coords ARE a cell centre, so the
 * nearest cell is an exact match in practice; we still snap (rather than require
 * exact equality) to tolerate rounding to 2dp in the URL.
 */
export async function lookupCellName(lat: number, lon: number): Promise<string> {
  const cells = await loadCells();
  const snapped = snapToNearestCell(lat, lon, cells);
  return snapped?.cell.name ?? '';
}
