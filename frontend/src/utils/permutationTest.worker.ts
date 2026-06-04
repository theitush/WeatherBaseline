// Web Worker wrapper around the year-block permutation test. 10k permutations
// over hundreds of pooled values is enough to jank the main thread, so the
// SignificancePanel offloads the compute here and renders a loading state until
// the result message comes back.

import { yearBlockPermutationTest, type PermRecord, type PermutationResult } from './permutationTest.ts';

export interface PermWorkerRequest {
  /** Echoed back so a stale (superseded) response can be ignored. */
  id: number;
  records: PermRecord[];
  groupA: string | number;
  groupB: string | number;
  nPerm?: number;
  seed?: number;
}

export interface PermWorkerResponse {
  id: number;
  result: PermutationResult | null;
}

self.onmessage = (e: MessageEvent<PermWorkerRequest>) => {
  const { id, records, groupA, groupB, nPerm, seed } = e.data;
  const result = yearBlockPermutationTest(records, groupA, groupB, { nPerm, seed });
  const response: PermWorkerResponse = { id, result };
  (self as unknown as Worker).postMessage(response);
};
