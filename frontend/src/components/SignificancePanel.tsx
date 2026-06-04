import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { WeatherDataPoint } from '../types';
import type { MetricKey } from '../utils/config';
import { buildPeriods } from './PeriodHistogramChart';
import type { PermRecord, PermutationResult } from '../utils/permutationTest';
import type { PermWorkerRequest, PermWorkerResponse } from '../utils/permutationTest.worker';
import './SignificancePanel.css';

interface SignificancePanelProps {
  // Same windowed (±CONFIG.chart.seasonalWindowDays, all years) subset the histogram above consumes.
  filteredData: WeatherDataPoint[];
  currentMetric: MetricKey;
}

const UNITS: Record<MetricKey, string> = {
  max_temperature: '°C',
  min_temperature: '°C',
  precipitation_sum: 'mm',
  wind_speed_10m_max: 'm/s',
};

const METRIC_NOUN: Record<MetricKey, string> = {
  max_temperature: 'warmer',
  min_temperature: 'warmer',
  precipitation_sum: 'wetter',
  wind_speed_10m_max: 'windier',
};
const METRIC_NOUN_NEG: Record<MetricKey, string> = {
  max_temperature: 'cooler',
  min_temperature: 'cooler',
  precipitation_sum: 'drier',
  wind_speed_10m_max: 'calmer',
};

// Plain-language verdict from the p-value. The thresholds are deliberately
// loose — this is a vibe check on top of the histogram, not a paper.
function verdict(p: number): string {
  if (p < 0.01) return 'Wow Yes!';
  if (p < 0.05) return 'Pretty likely.';
  if (p < 0.15) return 'Maybe?';
  return 'Not really..';
}

function fmtP(p: number): string {
  if (p < 0.001) return '< 0.001';
  return p.toFixed(3);
}

const SignificancePanel: React.FC<SignificancePanelProps> = ({ filteredData, currentMetric }) => {
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
  }, [records]);

  const unit = UNITS[currentMetric];
  // Label the compared statistic to match what the test actually used.
  const statLabel = currentMetric === 'precipitation_sum' ? '90th pct' : 'Median';

  return (
    <div className="significance-panel">
      {loading ? (
        <div className="sig-loading">
          <span className="sig-spinner" /> Running 10,000 permutations…
        </div>
      ) : !result ? (
        <div className="sig-empty">Not enough data in these periods to test.</div>
      ) : (
        (() => {
          const line = verdict(result.pValue);
          const diff = result.observedDiff;
          const dir = diff >= 0 ? METRIC_NOUN[currentMetric] : METRIC_NOUN_NEG[currentMetric];
          return (
            <div className="sig-body">
              <div className="sig-verdict">{line}</div>
              <p className="sig-explain">
                {statLabel} of {newest.label} is {Math.abs(diff).toFixed(1)} {unit} {dir} than {statLabel.toLowerCase()} of {oldest.label}
                {' '}(p&nbsp;=&nbsp;{fmtP(result.pValue)}).
              </p>
            </div>
          );
        })()
      )}
    </div>
  );
};

export default SignificancePanel;
