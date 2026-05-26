/**
 * GeoNames cell-coverage UX test page.
 *
 * Type a place name -> searchable dropdown of GeoNames results. Each result
 * shows the GeoNames hit and, in brackets, how far the place is from the
 * nearest cell in the SELECTED ERA5-Land cell list (public/cells.csv, the
 * top-N populated cells from select_cells.py). The point: eyeball whether
 * arbitrary places land close to a selected cell, or fall in a coverage gap.
 */
import { useEffect, useRef, useState } from 'react';
import { searchGeoNames, type GeoNamesPlace } from './geonames';
import { loadCells, nearestCell, type Cell, type CellMatch } from './grid';
import './GeoNamesTest.css';

interface Result extends GeoNamesPlace {
  match: CellMatch;
}

/**
 * Bracket label + severity for a place->nearest-selected-cell distance.
 * If a place sat on its own 0.1deg cell, distance would be <=7.9 km. Anything
 * well beyond that means the nearest SELECTED cell is in a different cell —
 * i.e. this place is in a region the top-N selection didn't cover densely.
 */
function distanceBadge(km: number): { text: string; level: string } {
  const text = `${km.toFixed(1)} km to cell`;
  if (km < 8) return { text, level: 'good' }; // within ~one cell — well covered
  if (km < 25) return { text, level: 'ok' }; // a few cells off
  return { text, level: 'far' }; // coverage gap — no nearby selected cell
}

export default function GeoNamesTest() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Result[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Result | null>(null);
  const [activeIdx, setActiveIdx] = useState(-1);

  const [cells, setCells] = useState<Cell[] | null>(null);
  const [cellsError, setCellsError] = useState<string | null>(null);

  const debounce = useRef<number | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  // Load the selected-cell list once on mount.
  useEffect(() => {
    loadCells()
      .then(setCells)
      .catch((e) =>
        setCellsError(e instanceof Error ? e.message : 'cells.csv load failed'),
      );
  }, []);

  // Debounced GeoNames lookup as the user types.
  useEffect(() => {
    if (debounce.current) clearTimeout(debounce.current);

    if (query.trim().length < 2 || !cells) {
      setResults([]);
      setOpen(false);
      setError(null);
      return;
    }

    debounce.current = window.setTimeout(async () => {
      setLoading(true);
      setError(null);
      try {
        const places = await searchGeoNames(query.trim(), 10);
        const withCells: Result[] = places.map((p) => ({
          ...p,
          match: nearestCell(p.lat, p.lng, cells),
        }));
        setResults(withCells);
        setOpen(true);
        setActiveIdx(-1);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Search failed');
        setResults([]);
        setOpen(true);
      } finally {
        setLoading(false);
      }
    }, 350);

    return () => {
      if (debounce.current) clearTimeout(debounce.current);
    };
  }, [query, cells]);

  // Close the dropdown on outside click.
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, []);

  const pick = (r: Result) => {
    setSelected(r);
    setQuery(r.name);
    setOpen(false);
    setActiveIdx(-1);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!open || results.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIdx((i) => (i < results.length - 1 ? i + 1 : 0));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIdx((i) => (i > 0 ? i - 1 : results.length - 1));
    } else if (e.key === 'Enter' && activeIdx >= 0) {
      e.preventDefault();
      pick(results[activeIdx]);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  };

  return (
    <div className="gnt">
      <h1>GeoNames → ERA5-Land cell test</h1>
      <p className="gnt-intro">
        Search a place. Each result shows the GeoNames hit and, in brackets,
        how far it sits from the nearest cell in the selected list (
        {cells ? `${cells.length.toLocaleString()} cells` : 'loading…'}). A
        large distance means the place is in a coverage gap — no populated cell
        was selected near it.
      </p>

      {cellsError && (
        <div className="gnt-error gnt-error-block">{cellsError}</div>
      )}

      <div className="gnt-search" ref={boxRef}>
        <input
          type="text"
          value={query}
          placeholder="Search a place… (e.g. Lisbon, Kyoto, Nairobi)"
          autoComplete="off"
          disabled={!cells}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          onFocus={() => results.length > 0 && setOpen(true)}
        />
        {loading && <span className="gnt-spinner" aria-label="loading" />}

        {open && (
          <div className="gnt-dropdown">
            {error && <div className="gnt-error">{error}</div>}
            {!error && results.length === 0 && !loading && (
              <div className="gnt-empty">No places found.</div>
            )}
            {!error &&
              results.map((r, i) => {
                const badge = distanceBadge(r.match.distanceKm);
                return (
                  <div
                    key={r.geonameId}
                    className={`gnt-item ${i === activeIdx ? 'active' : ''}`}
                    onClick={() => pick(r)}
                    onMouseEnter={() => setActiveIdx(i)}
                  >
                    <div className="gnt-item-main">
                      <span className="gnt-item-name">{r.name}</span>
                      <span className={`gnt-badge ${badge.level}`}>
                        [{badge.text}]
                      </span>
                    </div>
                    <div className="gnt-item-sub">
                      {[r.adminName1, r.countryName].filter(Boolean).join(', ')}
                      {r.population ? ` · pop ${r.population.toLocaleString()}` : ''}
                    </div>
                  </div>
                );
              })}
          </div>
        )}
      </div>

      {selected && (
        <div className="gnt-detail">
          <h2>{selected.name}</h2>
          <table>
            <tbody>
              <tr>
                <th>GeoNames</th>
                <td>
                  {selected.lat.toFixed(4)}, {selected.lng.toFixed(4)}
                </td>
              </tr>
              <tr>
                <th>Nearest selected cell</th>
                <td>
                  {selected.match.cell.lat.toFixed(1)},{' '}
                  {selected.match.cell.lon.toFixed(1)}{' '}
                  <span className="gnt-muted">
                    (#{selected.match.cell.cellId}, tile{' '}
                    {selected.match.cell.tileId})
                  </span>
                </td>
              </tr>
              <tr>
                <th>Distance to cell</th>
                <td>
                  <span
                    className={`gnt-badge ${
                      distanceBadge(selected.match.distanceKm).level
                    }`}
                  >
                    {selected.match.distanceKm.toFixed(2)} km
                  </span>
                </td>
              </tr>
              <tr>
                <th>Cell population</th>
                <td>{selected.match.cell.population.toLocaleString()}</td>
              </tr>
              <tr>
                <th>Place type</th>
                <td>{selected.fcodeName ?? selected.fcode ?? '—'}</td>
              </tr>
              <tr>
                <th>Place population</th>
                <td>
                  {selected.population
                    ? selected.population.toLocaleString()
                    : '—'}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
