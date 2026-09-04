// Web Worker wrapper around the compare page's period shuffle test. 2000
// shuffles across 52 weeks takes about 400ms — enough to freeze the page on
// every metric or year change — so the dial offloads it here and shows the
// sentence once the result arrives.
//
// The samples travel as transferable typed arrays rather than as row objects,
// so handing a 47-year record to the worker costs nothing.

import {
  periodShuffleTest,
  type PeriodSamples,
  type PeriodStatistic,
  type PeriodTest,
} from './comparePeriodTest.ts';

export interface PeriodWorkerRequest {
  /** The request's cache key, echoed back so the result can be filed. */
  key: string;
  years: Int32Array;
  weeks: Uint8Array;
  values: Float64Array;
  early: { startYear: number; endYear: number };
  late: { startYear: number; endYear: number };
  statistic: PeriodStatistic;
  nPerm?: number;
  seed?: number;
}

export interface PeriodWorkerResponse {
  key: string;
  result: PeriodTest | null;
}

self.onmessage = (e: MessageEvent<PeriodWorkerRequest>) => {
  const { key, years, weeks, values, early, late, statistic, nPerm, seed } = e.data;
  const samples: PeriodSamples = { years, weeks, values };
  const result = periodShuffleTest(samples, early, late, statistic, { nPerm, seed });
  const response: PeriodWorkerResponse = { key, result };
  (self as unknown as Worker).postMessage(response);
};
