// Runs the year-shuffle period test for every split chart on the compare page.
//
// Results are cached by a SIGNATURE of the request — cell, metric, the two year
// windows and the unit system — rather than by series id. Nothing about a
// signature can go stale, so there is no superseded-response bookkeeping: a
// result either exists for what the chart is currently showing or it doesn't,
// and flipping the split off and back on re-reads the cached answer instantly.
import { useEffect, useMemo, useRef, useState } from 'react';
import { convert } from '../utils/units';
import type { UnitSystem } from '../utils/units';
import type { Series, SeriesData } from './compareTypes';
import { seriesPeriods } from './compareTypes';
import { extractSamples, statisticFor, type PeriodTest } from './comparePeriodTest';
import type { PeriodWorkerRequest, PeriodWorkerResponse } from './comparePeriodTest.worker';

export interface PeriodTestState {
  /** Null while pending, and also when the split is untestable. */
  result: PeriodTest | null;
  /** True while the worker is still on it. */
  pending: boolean;
}

/** Shuffles per test. 2000 resolves a p-value down to about 0.0005. */
const N_PERM = 2000;

/**
 * The cache key for a chart's test, or null when there is nothing to test:
 * not split, no archive loaded yet, or a range too short to halve.
 */
function signature(s: Series, data: SeriesData | undefined, system: UnitSystem): string | null {
  if (!s.split || !data || data.loading || data.rows.length === 0) return null;
  const periods = seriesPeriods(s);
  if (periods.length !== 2) return null;
  const [early, late] = periods;
  return [
    s.lat, s.lon, s.metric, system,
    early.startYear, early.endYear, late.startYear, late.endYear,
    data.rows.length,
  ].join('|');
}

export function useComparePeriodTests(
  series: Series[],
  dataMap: Record<string, SeriesData>,
  system: UnitSystem
): Record<string, PeriodTestState> {
  const [cache, setCache] = useState<Record<string, PeriodTest | null>>({});
  const workerRef = useRef<Worker | null>(null);
  // Signatures already posted, so a re-render doesn't dispatch them twice.
  const inFlight = useRef<Set<string>>(new Set());

  useEffect(() => {
    const posted = inFlight.current;
    const worker = new Worker(new URL('./comparePeriodTest.worker.ts', import.meta.url), {
      type: 'module',
    });
    workerRef.current = worker;
    worker.onmessage = (e: MessageEvent<PeriodWorkerResponse>) => {
      posted.delete(e.data.key);
      setCache((prev) => ({ ...prev, [e.data.key]: e.data.result }));
    };
    return () => {
      worker.terminate();
      workerRef.current = null;
      posted.clear();
    };
  }, []);

  // What each chart needs right now, and whether we already have it.
  const wanted = useMemo(
    () =>
      series.map((s) => ({ s, key: signature(s, dataMap[s.id], system) })),
    [series, dataMap, system]
  );

  useEffect(() => {
    const worker = workerRef.current;
    if (!worker) return;
    for (const { s, key } of wanted) {
      if (!key || key in cache || inFlight.current.has(key)) continue;
      const data = dataMap[s.id];
      if (!data) continue;
      const [early, late] = seriesPeriods(s);
      const samples = extractSamples(
        data.rows,
        s.metric,
        early.startYear,
        late.endYear,
        (raw) => convert(raw, s.metric, system)
      );
      // An empty payload is dispatched like any other: the test answers null
      // for it, and the answer gets cached the same way as a real one.
      inFlight.current.add(key);
      const req: PeriodWorkerRequest = {
        key,
        years: samples.years,
        weeks: samples.weeks,
        values: samples.values,
        early: { startYear: early.startYear, endYear: early.endYear },
        late: { startYear: late.startYear, endYear: late.endYear },
        statistic: statisticFor(s.metric),
        nPerm: N_PERM,
        seed: 42,
      };
      // Transfer the buffers — they were built for this message and nothing on
      // this side reads them again.
      worker.postMessage(req, [
        samples.years.buffer,
        samples.weeks.buffer,
        samples.values.buffer,
      ]);
    }
  }, [wanted, cache, dataMap, system]);

  return useMemo(() => {
    const out: Record<string, PeriodTestState> = {};
    for (const { s, key } of wanted) {
      out[s.id] = key
        ? { result: cache[key] ?? null, pending: !(key in cache) }
        : { result: null, pending: false };
    }
    return out;
  }, [wanted, cache]);
}
