import { useEffect, useMemo, useRef, useState } from 'react';
import type { WeatherDataPoint } from '../types';
import type { MetricKey } from '../utils/config';
import { buildPeriods } from '../components/PeriodHistogramChart';
import type { PermRecord, PermutationResult } from '../utils/permutationTest';
import type { PermWorkerRequest, PermWorkerResponse } from '../utils/permutationTest.worker';

export interface PermutationTestState {
  result: PermutationResult | null;
  loading: boolean;
}

/**
 * Runs the year-block permutation test comparing the oldest vs newest of the
 * three histogram periods. Owns a single web worker and re-dispatches whenever
 * the data/metric change. Shared by SignificancePanel (the verdict text) and
 * PeriodHistogramChart (the significance bracket), so both read one result.
 */
export function usePermutationTest(
  filteredData: WeatherDataPoint[],
  currentMetric: MetricKey
): PermutationTestState {
  const [result, setResult] = useState<PermutationResult | null>(null);
  const [loading, setLoading] = useState(false);
  const workerRef = useRef<Worker | null>(null);
  const reqIdRef = useRef(0);

  // The two periods being compared: oldest vs newest of the three the histogram
  // shows. Derived from buildPeriods() so they track the rolling windows.
  const periods = useMemo(() => buildPeriods(), []);
  const oldest = periods[0];
  const newest = periods[periods.length - 1];

  // Flatten the windowed historical rows into year-block records for just the
  // two compared periods. Memoized on data+metric so we don't rebuild (or
  // re-dispatch to the worker) on unrelated re-renders.
  const records = useMemo<PermRecord[]>(() => {
    const out: PermRecord[] = [];
    for (const d of filteredData) {
      if (d.data_type !== 'historical') continue;
      const v = d[currentMetric];
      if (v === null || v === undefined || !Number.isFinite(v)) continue;
      if (d.year >= oldest.start && d.year <= oldest.end) {
        out.push({ year: d.year, group: 'old', value: v });
      } else if (d.year >= newest.start && d.year <= newest.end) {
        out.push({ year: d.year, group: 'new', value: v });
      }
    }
    return out;
  }, [filteredData, currentMetric, oldest.start, oldest.end, newest.start, newest.end]);

  // Spin up the worker once.
  useEffect(() => {
    const worker = new Worker(new URL('../utils/permutationTest.worker.ts', import.meta.url), {
      type: 'module',
    });
    workerRef.current = worker;
    worker.onmessage = (e: MessageEvent<PermWorkerResponse>) => {
      // Drop superseded responses (metric switched mid-compute).
      if (e.data.id !== reqIdRef.current) return;
      setResult(e.data.result);
      setLoading(false);
    };
    return () => {
      worker.terminate();
      workerRef.current = null;
    };
  }, []);

  // Dispatch a fresh test whenever the memoized records change.
  useEffect(() => {
    const worker = workerRef.current;
    if (!worker) return;
    if (records.length === 0) {
      setResult(null);
      setLoading(false);
      return;
    }
    const id = ++reqIdRef.current;
    setLoading(true);
    const req: PermWorkerRequest = {
      id,
      records,
      groupA: 'old',
      groupB: 'new',
      nPerm: 10000,
      seed: 42,
      // Precip's median is usually 0; compare the wet tail (90th pct) instead.
      statistic: currentMetric === 'precipitation_sum' ? 'p90' : 'median',
    };
    worker.postMessage(req);
  }, [records, currentMetric]);

  return { result, loading };
}
