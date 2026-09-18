import { useEffect, useMemo, useRef, useState } from 'react';
import type { WeatherDataPoint } from '../types';
import type { MetricKey } from '../utils/config';
import { buildPeriods, type Period } from '../components/PeriodHistogramChart';
import type { PermRecord, PermutationResult } from '../utils/permutationTest';
import type { PermWorkerRequest, PermWorkerResponse } from '../utils/permutationTest.worker';

/**
 * The three comparisons this section runs over the eras:
 *   newestVsPooled   — the newest era against both older ones POOLED. Drawn as
 *                      the bracket spanning the whole panel stack.
 *   presatVsFirstsat — pre-satellite against the first satellite era. Drawn as
 *                      the bracket over the bottom two panels.
 *   postsatPair      — the two satellite eras against each other. NOT drawn:
 *                      this is the one the prose reports, and it is what
 *                      `result` holds.
 */
export const PERM_COMPARISONS = ['newestVsPooled', 'presatVsFirstsat', 'postsatPair'] as const;
export type PermComparison = (typeof PERM_COMPARISONS)[number];

/** The comparison the headline and the SignificancePanel speak for. */
const TEXT_COMPARISON: PermComparison = 'postsatPair';

export type PermResults = Record<PermComparison, PermutationResult | null>;
const NO_RESULTS: PermResults = {
  newestVsPooled: null,
  presatVsFirstsat: null,
  postsatPair: null,
};

export interface PermutationTestState {
  /**
   * The post-satellite pair's result — THE comparison the text reports. Kept
   * under this name because every text consumer (the headline's changeVerdict,
   * the SignificancePanel's sentence) reads exactly one result and should not
   * have to choose which.
   */
  result: PermutationResult | null;
  // The metric `result` was computed for. Lets consumers tell a fresh result
  // from a stale one when the metric was just switched (the workers are async,
  // so for a tick `result` still holds the previous metric's numbers).
  resultMetric: MetricKey | null;
  // True from the moment the metric changes until THAT metric's text result
  // lands. The raw worker-busy flag only flips in the dispatch effect, i.e. one
  // render *after* the switch, so it isn't exposed: keying off it alone flashes
  // an "empty" state in that gap.
  pending: boolean;
  /** All three, for the chart's brackets. Cleared the moment a new round is
   *  dispatched, so a non-null entry is always for the current metric. */
  results: PermResults;
  /** The eras being compared, so the panel can name them without re-deriving. */
  periods: Period[];
}

/**
 * Runs the year-block permutation test over the three eras — three comparisons,
 * one worker each. Re-dispatches whenever the data/metric change. Shared by
 * SignificancePanel and the headline (which read `result`, the post-satellite
 * pair) and by PeriodHistogramChart (which brackets the other two), so the
 * words and the marks are always the same numbers.
 *
 * WHY THREE WORKERS AND NOT ONE. The eras are much larger pools than the
 * 15-year windows this replaced, and a single 10k-permutation run over them
 * takes ~0.8–1.5s (measured 2026-09-18, 1950–2026 at a ±3-day window: 890ms for
 * the pre/first-sat pair, 842ms for the post-sat pair, 1539ms for the newest
 * against 50 pooled year-blocks). Queued on one worker that is ~3.3s, past the
 * point where the headline gives up and says "Yet to be tested…" on every
 * metric switch. One worker per comparison runs them at once, so the wait is
 * the slowest test (~1.5s), not the sum.
 */
export function usePermutationTest(
  filteredData: WeatherDataPoint[],
  currentMetric: MetricKey
): PermutationTestState {
  const [results, setResults] = useState<PermResults>(NO_RESULTS);
  const [resultMetric, setResultMetric] = useState<MetricKey | null>(null);
  const [loading, setLoading] = useState(false);
  const workersRef = useRef<Record<PermComparison, Worker> | null>(null);
  const reqIdRef = useRef(0);
  // Metric of the most recently dispatched round, read in the workers'
  // onmessage (set up once, so it can't close over the live currentMetric).
  const pendingMetricRef = useRef<MetricKey | null>(null);

  // The three eras, from the same builder the chart draws — so the tests, the
  // bars and the sentence can never disagree about which years are which.
  const periods = useMemo(
    () => buildPeriods(filteredData, currentMetric),
    [filteredData, currentMetric]
  );

  // One PermRecord[] per comparison. Memoized on data+metric+periods so we don't
  // rebuild (or re-dispatch) on unrelated re-renders.
  const recordSets = useMemo<Record<PermComparison, PermRecord[]> | null>(() => {
    const [pre, firstSat, latest] = periods;
    if (!pre || !firstSat || !latest) return null;
    const within = (year: number, ps: Period[]) =>
      ps.some((p) => year >= p.start && year <= p.end);
    const build = (oldSide: Period[], newSide: Period[]): PermRecord[] => {
      const out: PermRecord[] = [];
      for (const d of filteredData) {
        // Exclude only forecast; 'recent' is real settled-enough data (unchanged
        // from when recent rows were tagged 'historical').
        if (d.data_type === 'forecast') continue;
        const v = d[currentMetric];
        if (v === null || v === undefined || !Number.isFinite(v)) continue;
        if (within(d.year, oldSide)) out.push({ year: d.year, group: 'old', value: v });
        else if (within(d.year, newSide)) out.push({ year: d.year, group: 'new', value: v });
      }
      return out;
    };
    return {
      newestVsPooled: build([pre, firstSat], [latest]),
      presatVsFirstsat: build([pre], [firstSat]),
      postsatPair: build([firstSat], [latest]),
    };
  }, [filteredData, currentMetric, periods]);

  // Spin the workers up once — one per comparison, so the three runs overlap.
  useEffect(() => {
    const made = {} as Record<PermComparison, Worker>;
    for (const key of PERM_COMPARISONS) {
      const worker = new Worker(
        new URL('../utils/permutationTest.worker.ts', import.meta.url),
        { type: 'module' }
      );
      worker.onmessage = (e: MessageEvent<PermWorkerResponse>) => {
        // Drop superseded responses (metric switched mid-compute).
        if (e.data.id !== reqIdRef.current) return;
        setResults((prev) => ({ ...prev, [key]: e.data.result }));
        // Only the text's comparison ends the pending state: the brackets have
        // no loading copy to hold, their stars just fade in when they land.
        if (key === TEXT_COMPARISON) {
          setResultMetric(pendingMetricRef.current);
          setLoading(false);
        }
      };
      made[key] = worker;
    }
    workersRef.current = made;
    return () => {
      for (const key of PERM_COMPARISONS) made[key].terminate();
      workersRef.current = null;
    };
  }, []);

  // Dispatch a fresh round whenever the memoized records change.
  useEffect(() => {
    const workers = workersRef.current;
    if (!workers) return;
    if (!recordSets) {
      setResults(NO_RESULTS);
      setResultMetric(null);
      setLoading(false);
      return;
    }
    const id = ++reqIdRef.current;
    pendingMetricRef.current = currentMetric;
    // Clearing here is what makes "non-null ⇒ current metric" true for the
    // brackets, so they can't show the previous metric's stars.
    setResults(NO_RESULTS);
    // A comparison with no records on one side (e.g. the pre-satellite era on a
    // record that starts after 1979) is never dispatched, so it never answers —
    // only the TEXT one may hold the pending flag.
    setLoading(recordSets[TEXT_COMPARISON].length > 0);
    if (recordSets[TEXT_COMPARISON].length === 0) setResultMetric(null);
    for (const key of PERM_COMPARISONS) {
      const records = recordSets[key];
      if (records.length === 0) continue;
      const req: PermWorkerRequest = {
        id,
        records,
        groupA: 'old',
        groupB: 'new',
        nPerm: 10000,
        seed: 42,
        statistic: 'median',
      };
      workers[key].postMessage(req);
    }
  }, [recordSets, currentMetric]);

  // The text's records are non-empty exactly when its test can run, so a metric
  // with data but no result for it yet is always a test in flight — even before
  // the dispatch effect has had its turn.
  const hasTextRecords = (recordSets?.[TEXT_COMPARISON].length ?? 0) > 0;
  const pending = loading || (hasTextRecords && resultMetric !== currentMetric);

  return { result: results[TEXT_COMPARISON], resultMetric, pending, results, periods };
}
