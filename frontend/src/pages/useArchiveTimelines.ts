// Loads archive-only timelines for the comparison page's series.
//
// Reads straight from R2 via loadCellTimeline (same path the main app uses) but
// keeps ONLY the settled archive rows (data_type === 'historical') — the compare
// page is explicitly archive-only, no recent/forecast tiers. Results are cached
// by snapped cell coords so multiple series on the same cell, or re-renders,
// don't re-download.
import { useEffect, useState } from 'react';
import { loadCellTimeline, snap } from '../services/tieredData';
import type { WeatherDataPoint } from '../types';
import type { Series, SeriesData } from './compareTypes';

interface CellLoad {
  rows: WeatherDataPoint[];
  noArchive: boolean;
}

// Cache by snapped "lat,lon" so series sharing a cell share one fetch.
const cellCache = new Map<string, Promise<CellLoad>>();

function loadCellArchive(lat: number, lon: number): Promise<CellLoad> {
  const key = `${snap(lat).toFixed(1)},${snap(lon).toFixed(1)}`;
  let p = cellCache.get(key);
  if (!p) {
    p = loadCellTimeline(lat, lon).then(({ data }) => {
      const rows = data.filter((d) => d.data_type === 'historical');
      return { rows, noArchive: rows.length === 0 };
    });
    cellCache.set(key, p);
    p.catch(() => cellCache.delete(key)); // let a failure retry later
  }
  return p;
}

/**
 * Map of seriesId → SeriesData for the given series. Loads each series' cell
 * archive once and tracks loading/error state per series. Adding/removing a
 * series or changing its location triggers the relevant load; metric/year/color
 * changes are pure filtering done in the chart, so they don't reload here.
 */
export function useArchiveTimelines(series: Series[]): Record<string, SeriesData> {
  const [dataMap, setDataMap] = useState<Record<string, SeriesData>>({});

  useEffect(() => {
    let cancelled = false;

    for (const s of series) {
      const existing = dataMap[s.id];
      // Reload only if we have nothing for this series, or its cell moved.
      if (existing && !existing.loading && existing._lat === s.lat && existing._lon === s.lon) {
        continue;
      }
      setDataMap((prev) => ({
        ...prev,
        [s.id]: { rows: [], loading: true, noArchive: false, _lat: s.lat, _lon: s.lon },
      }));
      loadCellArchive(s.lat, s.lon)
        .then(({ rows, noArchive }) => {
          if (cancelled) return;
          setDataMap((prev) => ({
            ...prev,
            [s.id]: { rows, loading: false, noArchive, _lat: s.lat, _lon: s.lon },
          }));
        })
        .catch((err) => {
          if (cancelled) return;
          setDataMap((prev) => ({
            ...prev,
            [s.id]: {
              rows: [],
              loading: false,
              noArchive: false,
              error: String(err),
              _lat: s.lat,
              _lon: s.lon,
            },
          }));
        });
    }

    // Drop data for series that no longer exist.
    setDataMap((prev) => {
      const ids = new Set(series.map((s) => s.id));
      const next: Record<string, SeriesData> = {};
      let changed = false;
      for (const [id, v] of Object.entries(prev)) {
        if (ids.has(id)) next[id] = v;
        else changed = true;
      }
      return changed ? next : prev;
    });

    return () => {
      cancelled = true;
    };
    // We intentionally key the effect on the identity-relevant fields only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [series.map((s) => `${s.id}:${s.lat}:${s.lon}`).join('|')]);

  return dataMap;
}
